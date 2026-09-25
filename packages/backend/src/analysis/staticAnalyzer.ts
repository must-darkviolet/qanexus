/**
 * Deterministic repository analysis (spec sections 3 and 4).
 *
 * "Do not send the entire repository blindly to the AI. First perform
 * deterministic analysis." Everything here runs without a model; the AI
 * agents later receive this structured summary instead of raw source.
 */
import path from 'node:path';
import type { DetectedFramework, StaticAnalysis } from '@qa-agent/shared';
import { scanRepository, type ScanResult, type ScannedFile } from './scanner.js';
import { extractRoutes } from './routes.js';
import { extractComponents } from './components.js';
import { attachApisToComponents, extractApis } from './apis.js';
import { extractValidations } from './validation.js';
import { extractAuthz } from './authz.js';
import { extractEnvVarNames, extractState } from './state.js';
import { analyzeExistingTests } from './existingTests.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('static-analysis');

function detectFramework(pkg: Record<string, unknown> | null, files: ScannedFile[]): DetectedFramework {
  const deps = {
    ...(pkg?.dependencies as Record<string, string> | undefined ?? {}),
    ...(pkg?.devDependencies as Record<string, string> | undefined ?? {}),
  };
  if (deps['next']) return 'next';
  if (deps['@remix-run/react']) return 'remix';
  if (deps['react-scripts']) return 'cra';
  if (deps['vite'] && deps['react']) return 'vite_react';
  if (deps['react']) return 'react';
  if (files.some((f) => /(^|\/)(src\/)?app\/.*page\.[jt]sx?$/.test(f.path))) return 'next';
  return 'unknown';
}

function readJson(files: ScannedFile[], rel: string): Record<string, unknown> | null {
  const file = files.find((f) => f.path === rel);
  if (!file?.content) return null;
  try { return JSON.parse(file.content) as Record<string, unknown>; } catch { return null; }
}

export interface StaticAnalysisResult {
  analysis: StaticAnalysis;
  scan: ScanResult;
}

export function analyzeRepository(root: string): StaticAnalysisResult {
  const started = Date.now();
  const scan = scanRepository(root);
  const files = scan.files;

  // package.json can live at the repo root or one level down in a monorepo.
  const pkgPath = files.find((f) => f.path === 'package.json')?.path
    ?? files.find((f) => /^[^/]+\/package\.json$/.test(f.path))?.path
    ?? 'package.json';
  const pkg = readJson(files, pkgPath);

  const readme = files.find((f) => /^readme\.md$/i.test(path.basename(f.path)) && !f.path.includes('/'))?.content
    ?? files.find((f) => /^readme\.md$/i.test(path.basename(f.path)))?.content;

  const docs = files
    .filter((f) => f.language === 'md' && !/^readme\.md$/i.test(path.basename(f.path)))
    .slice(0, 25)
    .map((f) => ({ file: f.path, excerpt: (f.content ?? '').slice(0, 4000) }));

  const routes = extractRoutes(files);
  const components = extractComponents(files);
  const apis = extractApis(files);
  attachApisToComponents(apis, components, files);
  const validations = extractValidations(files);
  const { roles, permissionChecks, authSignals } = extractAuthz(files);
  const state = extractState(files);
  const existingTests = analyzeExistingTests(files);

  const analysis: StaticAnalysis = {
    framework: detectFramework(pkg, files),
    usesTypeScript: files.some((f) => f.language === 'ts' || f.language === 'tsx')
      || files.some((f) => f.path.endsWith('tsconfig.json')),
    packageName: typeof pkg?.name === 'string' ? pkg.name : undefined,
    scripts: (pkg?.scripts as Record<string, string> | undefined) ?? {},
    dependencies: {
      ...(pkg?.dependencies as Record<string, string> | undefined ?? {}),
      ...(pkg?.devDependencies as Record<string, string> | undefined ?? {}),
    },
    readme: readme?.slice(0, 20_000),
    docs,
    files: files.map((f) => ({ path: f.path, size: f.size, hash: f.hash, language: f.language })),
    routes,
    components,
    apis,
    validations,
    roles,
    permissionChecks,
    stateMachines: state.stateMachines,
    entities: state.entities,
    constants: state.constants,
    featureFlags: state.featureFlags,
    statusValues: state.statusValues,
    errorHandling: state.errorHandling,
    envVarNames: extractEnvVarNames(files),
    authSignals,
    existingTests,
    excludedForSecrets: scan.excludedForSecrets,
  };

  log.info(
    `Static analysis complete in ${Date.now() - started}ms: ` +
    `${routes.length} routes, ${components.length} components, ${apis.length} APIs, ` +
    `${validations.length} validation rules, ${roles.length} roles, ` +
    `${state.stateMachines.length} state machines, ${existingTests.length} existing test files.`,
  );

  return { analysis, scan };
}

/**
 * Groups discovered artifacts into candidate features using route and
 * directory structure. The AI refines these names later, but a deterministic
 * grouping means the system still produces a usable feature map with no AI.
 *
 * Two rules keep the output meaningful rather than a list of filenames:
 *   - framework file conventions (page/layout/route/index) are never features;
 *     the directory that contains them is.
 *   - technical layers (hooks, utils, types, api clients) are attached to the
 *     features that use them rather than becoming features of their own.
 */
const FRAMEWORK_FILENAMES = new Set([
  'page', 'layout', 'route', 'index', 'template', 'loading', 'error',
  'not-found', 'default', 'head', 'middleware', '_app', '_document',
]);

const TECHNICAL_DIRS = /^(src|app|pages|lib|libs|utils?|helpers?|components?|shared|common|hooks?|types?|constants?|config|styles?|assets?|public|api|services?|store|stores|state|context|providers?)$/i;

function isTechnicalFile(rel: string): boolean {
  if (/\.d\.ts$/.test(rel)) return true;                          // type declarations
  if (/(^|\/)\./.test(rel)) return true;                          // dotfiles
  const base = path.basename(rel).replace(/\.[jt]sx?$/, '');
  if (/^use[A-Z]/.test(base)) return true;                         // a hook
  if (/^(types?|constants?|config|schema|validation|utils?|helpers?)$/i.test(base)) return true;
  return /(^|\/)(types?|constants?|config|styles?)\//i.test(rel);
}

export function deriveCandidateFeatures(analysis: StaticAnalysis): {
  key: string; name: string; routes: string[]; components: string[]; files: string[]; apis: string[];
}[] {
  interface Bucket { routes: Set<string>; components: Set<string>; files: Set<string>; apis: Set<string>; fromRoute: boolean }
  const buckets = new Map<string, Bucket>();

  const bucket = (key: string, fromRoute = false): Bucket => {
    let b = buckets.get(key);
    if (!b) {
      b = { routes: new Set(), components: new Set(), files: new Set(), apis: new Set(), fromRoute };
      buckets.set(key, b);
    }
    if (fromRoute) b.fromRoute = true;
    return b;
  };

  /** "/admin/users/[id]" -> "admin"; "/" -> "home". */
  const keyForRoute = (routePath: string): string => {
    const first = routePath.split('/').filter(Boolean).find((seg) => !seg.startsWith(':'));
    return (first ?? 'home').toLowerCase();
  };

  /**
   * "src/features/users/UserForm.tsx" -> "users"
   * "src/app/tasks/new/page.tsx"      -> "tasks"
   * "src/components/Button.tsx"       -> null (a shared component, not a feature)
   */
  const keyForFile = (file: string): string | null => {
    if (isTechnicalFile(file)) return null;

    const segments = file.split('/');
    const base = path.basename(file).replace(/\.[jt]sx?$/, '');

    // A feature/module directory wins when one is present.
    const featureIdx = segments.findIndex((seg) => /^(features?|modules?|domains?|views?|screens?)$/i.test(seg));
    const afterFeature = featureIdx >= 0 ? segments[featureIdx + 1] : undefined;
    if (afterFeature && !/\.[jt]sx?$/.test(afterFeature)) return afterFeature.toLowerCase();

    // App/pages router: the route directory is the feature, not "page.tsx".
    if (FRAMEWORK_FILENAMES.has(base.toLowerCase())) {
      for (let i = segments.length - 2; i >= 0; i--) {
        const seg = segments[i]!;
        if (TECHNICAL_DIRS.test(seg)) continue;
        if (seg.startsWith('(') || seg.startsWith('[') || seg.startsWith('@')) continue;
        return seg.toLowerCase();
      }
      return 'home';   // app/page.tsx is the landing page
    }

    // Otherwise the nearest non-technical directory names the feature.
    for (let i = segments.length - 2; i >= 0; i--) {
      const seg = segments[i]!;
      if (TECHNICAL_DIRS.test(seg)) continue;
      if (seg.startsWith('(') || seg.startsWith('[') || seg.startsWith('@')) continue;
      return seg.toLowerCase();
    }

    // A PascalCase component sitting directly in components/ is shared, not a
    // feature; anything else falls back to its own name.
    if (/^[A-Z]/.test(base) && /(^|\/)components?\//i.test(file)) return null;
    return base.toLowerCase();
  };

  for (const route of analysis.routes) {
    if (route.kind === 'api') continue;
    const b = bucket(keyForRoute(route.path), true);
    b.routes.add(route.path);
    b.files.add(route.file);
  }

  // Routes claim their files first. A component living under an already-routed
  // file must join that route's feature rather than starting a new one - this
  // is what stops "app/tasks/new/page.tsx" becoming a feature called "New".
  const ownerOfFile = new Map<string, string>();
  for (const [key, b] of buckets) for (const file of b.files) ownerOfFile.set(file, key);

  for (const component of analysis.components) {
    if (component.kind === 'test' || component.kind === 'util' || component.kind === 'hook') continue;
    const key = ownerOfFile.get(component.file) ?? keyForFile(component.file);
    if (!key) continue;
    const b = bucket(key);
    b.components.add(component.name);
    b.files.add(component.file);
    for (const api of component.callsApis) b.apis.add(api);
  }

  // APIs are attached to whichever feature already owns their file, or to the
  // feature whose route prefix matches. They never create a feature on their
  // own, which is what produced buckets like "auth" from a login endpoint.
  for (const api of analysis.apis) {
    const owner = [...buckets.entries()].find(([, b]) => b.files.has(api.file));
    if (owner) { owner[1].apis.add(`${api.method} ${api.path}`); continue; }

    const segment = api.path.split('/').filter(Boolean).find((seg) => seg !== 'api' && !seg.startsWith(':'));
    const match = segment ? buckets.get(segment.toLowerCase()) : undefined;
    if (match) { match.apis.add(`${api.method} ${api.path}`); match.files.add(api.file); }
  }

  return [...buckets.entries()]
    // A bucket with no route and no component is not a feature a user can see.
    .filter(([, b]) => b.fromRoute || b.components.size > 0)
    .filter(([key]) => !FRAMEWORK_FILENAMES.has(key) && !TECHNICAL_DIRS.test(key))
    .map(([key, b]) => ({
      key,
      name: key.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
      routes: [...b.routes],
      components: [...b.components],
      files: [...b.files],
      apis: [...b.apis],
    }))
    .sort((a, b) => b.files.length - a.files.length);
}
