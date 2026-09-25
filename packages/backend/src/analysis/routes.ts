/**
 * Route discovery (spec section 4).
 *
 * The spec is explicit that folder structure must not be assumed, so routes
 * are discovered from three independent signals and merged:
 *   - Next.js App Router file conventions (app/**\/page.tsx)
 *   - Next.js Pages Router file conventions (pages/**.tsx)
 *   - react-router / remix route definitions in source
 */
import path from 'node:path';
import type { Route } from '@qa-agent/shared';
import { ts, parseSource, forEachNode, literalString, getJsxAttributes, stringish } from './ast.js';
import type { ScannedFile } from './scanner.js';

function nextAppRoute(rel: string): string | null {
  // app/(marketing)/dashboard/[id]/page.tsx -> /dashboard/:id
  const m = rel.match(/(?:^|\/)(?:src\/)?app\/(.*)\/(page|route)\.[jt]sx?$/);
  if (!m) {
    if (/(?:^|\/)(?:src\/)?app\/(page|route)\.[jt]sx?$/.test(rel)) return '/';
    return null;
  }
  const segments = (m[1] ?? '').split('/').filter(Boolean)
    .filter((s) => !(s.startsWith('(') && s.endsWith(')')))   // route groups
    .filter((s) => !s.startsWith('@'))                        // parallel routes
    .map((s) => {
      if (/^\[\[\.\.\..+\]\]$/.test(s)) return `:${s.slice(5, -2)}?`;
      if (/^\[\.\.\..+\]$/.test(s)) return `:${s.slice(4, -1)}*`;
      if (/^\[.+\]$/.test(s)) return `:${s.slice(1, -1)}`;
      return s;
    });
  return '/' + segments.join('/');
}

function nextPagesRoute(rel: string): string | null {
  const m = rel.match(/(?:^|\/)(?:src\/)?pages\/(.*)\.[jt]sx?$/);
  if (!m) return null;
  let p = m[1] ?? '';
  if (/^_(app|document|error)$/.test(path.basename(p))) return null;
  p = p.replace(/\/index$/, '').replace(/^index$/, '');
  const segments = p.split('/').filter(Boolean).map((s) => {
    if (/^\[\.\.\..+\]$/.test(s)) return `:${s.slice(4, -1)}*`;
    if (/^\[.+\]$/.test(s)) return `:${s.slice(1, -1)}`;
    return s;
  });
  return '/' + segments.join('/');
}

function paramsOf(routePath: string): string[] {
  return [...routePath.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]!).filter(Boolean);
}

/** Pulls `<Route path="/users" element={<Users/>} />` and `createBrowserRouter([...])`. */
function extractReactRouterRoutes(file: ScannedFile): Route[] {
  const routes: Route[] = [];
  if (!file.content) return routes;
  if (!/react-router|createBrowserRouter|RouterProvider|<Route/.test(file.content)) return routes;
  const sf = parseSource(file.path, file.content);

  forEachNode(sf, (node) => {
    // JSX: <Route path="..." />
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const tag = node.tagName.getText();
      if (tag !== 'Route') return;
      const attrs = getJsxAttributes(node, sf);
      const p = attrs['path'];
      if (!p) return;
      const normalized = p.startsWith('/') ? p : `/${p}`;
      routes.push({
        path: normalized,
        file: file.path,
        kind: normalized.includes('*') ? 'catch_all' : normalized.includes(':') ? 'dynamic' : 'page',
        params: paramsOf(normalized),
        guardedByRoles: [],
        framework: 'react_router',
      });
    }
    // Object form: { path: '/users', element: <Users/> }
    if (ts.isObjectLiteralExpression(node)) {
      const pathProp = node.properties.find(
        (p) => ts.isPropertyAssignment(p) && p.name.getText(sf) === 'path',
      ) as ts.PropertyAssignment | undefined;
      const hasElement = node.properties.some(
        (p) => ts.isPropertyAssignment(p) && /^(element|Component|component|lazy)$/.test(p.name.getText(sf)),
      );
      if (!pathProp || !hasElement) return;
      const p = stringish(pathProp.initializer, sf);
      if (p === undefined) return;
      const normalized = p.startsWith('/') ? p : `/${p}`;
      routes.push({
        path: normalized,
        file: file.path,
        kind: normalized.includes('*') ? 'catch_all' : normalized.includes(':') ? 'dynamic' : 'page',
        params: paramsOf(normalized),
        guardedByRoles: [],
        framework: 'react_router',
      });
    }
  });
  return routes;
}

/** Detects that a page/layout is behind an auth or role guard. */
function guardSignals(content: string): { requiresAuth: boolean; roles: string[] } {
  const roles = new Set<string>();
  // A guard is as often written as a negation (`role !== 'admin'`) as a match.
  const roleRe = /\b(?:role|roles)\s*(?:===|==|!==|!=|\.includes\(|\.some\(|:)\s*['"`]([A-Za-z_][\w-]*)['"`]/g;
  for (const m of content.matchAll(roleRe)) if (m[1]) roles.add(m[1]);
  const allowedRe = /\b(?:allowedRoles|requiredRole|requiredRoles|permittedRoles)\s*[:=]\s*\[([^\]]*)\]/g;
  for (const m of content.matchAll(allowedRe)) {
    for (const lit of (m[1] ?? '').matchAll(/['"`]([^'"`]+)['"`]/g)) if (lit[1]) roles.add(lit[1]);
  }
  const requiresAuth = /\b(requireAuth|withAuth|ProtectedRoute|RequireAuth|useSession|getServerSession|isAuthenticated|redirect\(['"`]\/login|useRequireUser)\b/.test(content);
  return { requiresAuth: requiresAuth || roles.size > 0, roles: [...roles] };
}

export function extractRoutes(files: ScannedFile[]): Route[] {
  const byPath = new Map<string, Route>();
  const add = (r: Route) => {
    const key = `${r.framework}:${r.path}`;
    const existing = byPath.get(key);
    if (!existing) { byPath.set(key, r); return; }
    // Merge guard information from whichever source found it.
    existing.requiresAuth = existing.requiresAuth || r.requiresAuth;
    existing.guardedByRoles = [...new Set([...existing.guardedByRoles, ...r.guardedByRoles])];
  };

  for (const file of files) {
    if (file.isTest || !file.content) continue;

    const appRoute = nextAppRoute(file.path);
    if (appRoute !== null) {
      const isApi = /\/route\.[jt]sx?$/.test(file.path);
      const guards = guardSignals(file.content);
      add({
        path: appRoute,
        file: file.path,
        kind: isApi ? 'api' : appRoute.includes('*') ? 'catch_all' : appRoute.includes(':') ? 'dynamic' : 'page',
        params: paramsOf(appRoute),
        requiresAuth: guards.requiresAuth,
        guardedByRoles: guards.roles,
        framework: 'next_app',
      });
      continue;
    }

    const pagesRoute = nextPagesRoute(file.path);
    if (pagesRoute !== null) {
      const isApi = /(?:^|\/)(?:src\/)?pages\/api\//.test(file.path);
      const guards = guardSignals(file.content);
      add({
        path: pagesRoute,
        file: file.path,
        kind: isApi ? 'api' : pagesRoute.includes('*') ? 'catch_all' : pagesRoute.includes(':') ? 'dynamic' : 'page',
        params: paramsOf(pagesRoute),
        requiresAuth: guards.requiresAuth,
        guardedByRoles: guards.roles,
        framework: 'next_pages',
      });
      continue;
    }

    for (const r of extractReactRouterRoutes(file)) {
      const guards = guardSignals(file.content);
      add({ ...r, requiresAuth: guards.requiresAuth, guardedByRoles: guards.roles });
    }
  }

  // Layout files contribute guards to the routes beneath them.
  for (const file of files) {
    if (!file.content) continue;
    const m = file.path.match(/(?:^|\/)(?:src\/)?app\/(.*)\/layout\.[jt]sx?$/);
    if (!m) continue;
    const prefix = nextAppRoute(file.path.replace(/layout\.([jt]sx?)$/, 'page.$1'));
    if (prefix === null) continue;
    const guards = guardSignals(file.content);
    if (!guards.requiresAuth && guards.roles.length === 0) continue;
    for (const route of byPath.values()) {
      if (route.path === prefix || route.path.startsWith(prefix === '/' ? '/' : `${prefix}/`)) {
        route.requiresAuth = true;
        route.guardedByRoles = [...new Set([...route.guardedByRoles, ...guards.roles])];
      }
    }
  }

  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}
