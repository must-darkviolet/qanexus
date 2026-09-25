/**
 * API call discovery (spec section 4): endpoints, HTTP methods, request and
 * response shapes where they can be recovered, and the error codes the code
 * visibly handles.
 */
import type { ApiEndpoint } from '@qa-agent/shared';
import { ts, parseSource, forEachNode, lineOf, textOf, stringish, literalString } from './ast.js';
import type { ScannedFile } from './scanner.js';

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

function normalizeMethod(raw: string | undefined): ApiEndpoint['method'] {
  if (!raw) return 'UNKNOWN';
  const m = raw.toUpperCase();
  return METHODS.has(m) ? (m as ApiEndpoint['method']) : 'UNKNOWN';
}

/**
 * Strips a base URL or base-path variable so paths from different call sites
 * compare equal. `${BASE}/users` and `/api/users` should both become
 * `/users`-shaped keys rather than one of them keeping a template artefact.
 */
function normalizePath(raw: string): string {
  let p = raw.trim();
  p = p.replace(/^https?:\/\/[^/]+/, '');
  p = p.replace(/^\$\{[^}]*\}/, '');
  // templateToPattern turns `${BASE}` into `:BASE`; a leading interpolation is
  // a base-url variable, not a route parameter.
  p = p.replace(/^:[A-Za-z_][A-Za-z0-9_]*(?=\/|$)/, '');
  p = p.replace(/^:param/, '');
  if (!p.startsWith('/')) p = `/${p}`;
  return p.replace(/\/+$/, '') || '/';
}

/** `{ method: 'POST', body: JSON.stringify(x) }` -> method + request shape. */
function readFetchOptions(node: ts.Node | undefined, sf: ts.SourceFile) {
  const out: { method?: string; body?: string; auth?: boolean } = {};
  if (!node || !ts.isObjectLiteralExpression(node)) return out;
  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const key = prop.name.getText(sf).replace(/['"]/g, '');
    if (key === 'method') out.method = stringish(prop.initializer, sf);
    else if (key === 'body') out.body = textOf(prop.initializer, sf).slice(0, 300);
    else if (key === 'headers') {
      const headers = textOf(prop.initializer, sf);
      if (/Authorization|Bearer|credentials|token/i.test(headers)) out.auth = true;
    } else if (key === 'credentials') out.auth = true;
  }
  return out;
}

/**
 * The enclosing function body. Status handling usually sits a few statements
 * after the call (`const res = await fetch(...); if (res.status === 409) ...`),
 * so the whole function is the right scope to search, not the call expression.
 */
function enclosingFunctionText(node: ts.Node, sf: ts.SourceFile): string {
  let current: ts.Node | undefined = node;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) || ts.isMethodDeclaration(current)
    ) {
      return textOf(current, sf);
    }
    current = current.parent;
  }
  return textOf(sf, sf);
}

/**
 * Name of the function that makes the call, e.g. `fetchTasks` in
 * `export async function fetchTasks() { return fetch('/tasks') }`. This is what
 * lets a page that only imports `fetchTasks` be linked to `GET /tasks`.
 */
function enclosingFunctionName(node: ts.Node): string | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if ((ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) && current.name) {
      return current.name.getText();
    }
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current))
      && current.parent && ts.isVariableDeclaration(current.parent) && ts.isIdentifier(current.parent.name)) {
      return current.parent.name.text;
    }
    current = current.parent;
  }
  return undefined;
}

/** HTTP status codes explicitly referenced near a call site. */
function errorCodesIn(text: string): number[] {
  const codes = new Set<number>();
  for (const m of text.matchAll(/\b(?:status|statusCode|code)\s*(?:===|==|!==|!=|>=|<=|>|<)\s*(\d{3})\b/g)) {
    const n = Number(m[1]);
    if (n >= 100 && n < 600) codes.add(n);
  }
  for (const m of text.matchAll(/\bstatus\s*:\s*(\d{3})\b/g)) {
    const n = Number(m[1]);
    if (n >= 100 && n < 600) codes.add(n);
  }
  return [...codes].sort((a, b) => a - b);
}

export function extractApis(files: ScannedFile[]): ApiEndpoint[] {
  const endpoints = new Map<string, ApiEndpoint>();

  const add = (e: ApiEndpoint) => {
    const key = `${e.method} ${e.path}`;
    const existing = endpoints.get(key);
    if (!existing) { endpoints.set(key, e); return; }
    if (!existing.callerComponent && e.callerComponent) existing.callerComponent = e.callerComponent;
    existing.errorCodes = [...new Set([...existing.errorCodes, ...e.errorCodes])].sort((a, b) => a - b);
    existing.requiresAuth = existing.requiresAuth || e.requiresAuth;
    if (!existing.requestShape && e.requestShape) existing.requestShape = e.requestShape;
    if (!existing.responseShape && e.responseShape) existing.responseShape = e.responseShape;
  };

  for (const file of files) {
    if (!file.content || file.isTest) continue;
    if (!/\.[jt]sx?$/.test(file.path)) continue;
    if (!/\b(fetch|axios|useQuery|useMutation|useSWR|\$\.ajax|http\.)/.test(file.content)) continue;

    const sf = parseSource(file.path, file.content);
    // A shared response handler means the status codes belong to every call in
    // the file. When a file makes many different calls, attributing all codes
    // to all of them would manufacture coverage, so it is only done when the
    // file plausibly has one shared handler.
    const sharedHandler = /function\s+handle|const\s+handle\s*=|\.then\(handle|=> handle\(/.test(file.content);
    const fileErrorCodes = sharedHandler ? errorCodesIn(file.content) : [];

    forEachNode(sf, (node) => {
      if (!ts.isCallExpression(node)) return;
      const callee = node.expression;
      const calleeText = textOf(callee, sf);
      const args = node.arguments;
      const line = lineOf(sf, node);
      const nearby = enclosingFunctionText(node, sf).slice(0, 4000);

      // fetch('/api/users', { method: 'POST' })
      if (calleeText === 'fetch' || calleeText.endsWith('.fetch')) {
        const url = args[0] ? stringish(args[0], sf) : undefined;
        if (!url) return;
        const opts = readFetchOptions(args[1], sf);
        add({
          method: normalizeMethod(opts.method ?? 'GET'),
          path: normalizePath(url),
          file: file.path,
          line,
          requestShape: opts.body,
          errorCodes: errorCodesIn(nearby).length ? errorCodesIn(nearby) : fileErrorCodes,
          requiresAuth: opts.auth,
          callerComponent: enclosingFunctionName(node),
        });
        return;
      }

      // axios.post('/api/users', payload) / api.get(...) / http.delete(...)
      const axiosMatch = calleeText.match(/^(?:axios|api|http|client|request|instance)\.(get|post|put|patch|delete|head|options)$/i);
      if (axiosMatch) {
        const url = args[0] ? stringish(args[0], sf) : undefined;
        if (!url) return;
        const method = normalizeMethod(axiosMatch[1]);
        const bodyArg = method === 'GET' || method === 'DELETE' ? undefined : args[1];
        add({
          method,
          path: normalizePath(url),
          file: file.path,
          line,
          requestShape: bodyArg ? textOf(bodyArg, sf).slice(0, 300) : undefined,
          errorCodes: errorCodesIn(nearby).length ? errorCodesIn(nearby) : fileErrorCodes,
          callerComponent: enclosingFunctionName(node),
        });
        return;
      }

      // axios({ url, method })
      if (/^(?:axios|request|client)$/.test(calleeText) && args[0] && ts.isObjectLiteralExpression(args[0])) {
        const obj = args[0];
        let url: string | undefined;
        let method: string | undefined;
        for (const prop of obj.properties) {
          if (!ts.isPropertyAssignment(prop)) continue;
          const key = prop.name.getText(sf).replace(/['"]/g, '');
          if (key === 'url') url = stringish(prop.initializer, sf);
          if (key === 'method') method = stringish(prop.initializer, sf);
        }
        if (url) {
          add({
            method: normalizeMethod(method ?? 'GET'),
            path: normalizePath(url),
            file: file.path,
            line,
            errorCodes: fileErrorCodes,
          });
        }
      }
    });
  }

  // Next.js route handlers declare the methods they serve as exported names.
  for (const file of files) {
    if (!file.content) continue;
    const isHandler = /(?:^|\/)(?:src\/)?app\/.*\/route\.[jt]s$/.test(file.path)
      || /(?:^|\/)(?:src\/)?pages\/api\//.test(file.path);
    if (!isHandler) continue;
    const sf = parseSource(file.path, file.content);
    const routePath = file.path
      .replace(/^.*?(?:src\/)?app\//, '/')
      .replace(/\/route\.[jt]s$/, '')
      .replace(/^.*?(?:src\/)?pages\/api\//, '/api/')
      .replace(/\.[jt]s$/, '')
      .replace(/\[([^\]]+)\]/g, ':$1') || '/';
    for (const stmt of sf.statements) {
      if (!ts.isFunctionDeclaration(stmt) || !stmt.name) continue;
      const name = stmt.name.text.toUpperCase();
      if (!METHODS.has(name)) continue;
      add({
        method: name as ApiEndpoint['method'],
        path: normalizePath(routePath),
        file: file.path,
        line: lineOf(sf, stmt),
        errorCodes: errorCodesIn(textOf(stmt, sf)),
        requiresAuth: /getServerSession|requireAuth|verifyToken|authorize/.test(textOf(stmt, sf)),
      });
    }
  }

  return [...endpoints.values()].sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
}

/** Links each component to the API paths it calls. */
export function attachApisToComponents(
  apis: ApiEndpoint[],
  components: { name: string; file: string; callsApis: string[] }[],
  files: ScannedFile[] = [],
): void {
  const byFile = new Map<string, string[]>();
  for (const api of apis) {
    const list = byFile.get(api.file) ?? [];
    list.push(`${api.method} ${api.path}`);
    byFile.set(api.file, list);
  }
  const contentOf = new Map(files.map((f) => [f.path, f.content ?? '']));
  for (const c of components) {
    const calls = new Set(byFile.get(c.file) ?? []);
    // Indirect calls: the component's file uses a function (e.g. fetchTasks)
    // defined in an API module.
    const content = contentOf.get(c.file) ?? '';
    for (const api of apis) {
      if (!api.callerComponent || api.file === c.file) continue;
      if (new RegExp(`\\b${api.callerComponent}\\s*\\(`).test(content)) calls.add(`${api.method} ${api.path}`);
    }
    if (calls.size) c.callsApis = [...calls];
  }
}

export { normalizePath as normalizeApiPath, literalString };
