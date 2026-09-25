/**
 * Evidence of what the changed code does, read from the repository itself:
 * the data hooks a changed component uses, and for each one the HTTP method,
 * the endpoint path and the parameters it sends - so a test can observe the
 * real request instead of guessing a URL, and without needing a selector.
 *
 *   EducationHistoryDialog.tsx uses useGetSuperUserDetail
 *     -> api.get(API_URL.getSuperSaveUserDetails, { params: { email, ... } })
 *     -> "/super-save/get_user_details"
 *
 * Resolution is textual (names, object keys, string literals), so it works on
 * any TypeScript/JavaScript codebase without building it. When a constant is
 * defined more than once, every candidate is listed; the running application
 * (the walkthrough) says which one is used.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface ApiCallEvidence {
  /** The hook or function the changed file calls, e.g. useGetSuperUserDetail. */
  via: string;
  method: string;
  /** The endpoint expression as written, e.g. API_URL.getSuperSaveUserDetails. */
  endpoint: string;
  /** Resolved path literals for it. */
  paths: string[];
  params: string[];
  /** Condition in the calling code that enables it, e.g. "enabled: !!user?.user_email". */
  enabledWhen: string | null;
  definedIn: string;
  /**
   * What a user does in the changed file to send it, outermost step first, e.g.
   * click the button (onClick={handleReset}) -> opens EducationResetDialog ->
   * submit it -> confirm the confirmation dialog. Null when no path was found.
   */
  trigger?: string[] | null;
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage', 'out']);

function sourceFiles(root: string, limit = 6000): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (out.length >= limit) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name)); }
      else if (/\.[cm]?[jt]sx?$/.test(e.name) && !/\.(test|spec|d)\.[jt]sx?$/.test(e.name)) out.push(path.join(dir, e.name));
    }
  };
  walk(root);
  return out;
}

/** The body of `const name = ... ;` or `function name(...) {...}`, as text (bounded). */
function definitionOf(source: string, name: string): string | null {
  const start = source.search(new RegExp(`(?:const|let|function)\\s+${name}\\b`));
  if (start < 0) return null;
  return source.slice(start, start + 1600);
}

export function discoverApiEvidence(repoDir: string, changedFiles: string[]): ApiCallEvidence[] {
  const files = sourceFiles(repoDir);
  const read = (f: string) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
  const out: ApiCallEvidence[] = [];
  const seen = new Set<string>();

  // Where each object key maps to a path literal: getUserDetails: "/super-save/get_user_details"
  const keyPaths = new Map<string, string[]>();
  const keyIndex = () => {
    if (keyPaths.size) return;
    for (const f of files.filter((x) => /url|endpoint|api|route|constant/i.test(path.basename(x)))) {
      for (const m of read(f).matchAll(/^\s*(\w+)\s*:\s*(['"`])(\/[^'"`\s]*)\2/gm)) {
        keyPaths.set(m[1]!, [...new Set([...(keyPaths.get(m[1]!) ?? []), m[3]!])]);
      }
    }
  };

  for (const rel of changedFiles) {
    const source = read(path.join(repoDir, rel));
    if (!source) continue;
    // Hooks and API functions the changed file calls: useGetX(...), fetchX(...)
    const called = [...new Set([...source.matchAll(/\b(use[A-Z]\w+|(?:get|fetch|update|post|put|delete|create)[A-Z]\w+)\s*\(/g)].map((m) => m[1]!))]
      .filter((n) => !/^use(State|Effect|Memo|Callback|Ref|Context|Reducer|ImperativeHandle|LayoutEffect|Locale|Router|Translation|Form|Theme|Media|Id)$/.test(n));
    for (const name of called) {
      const defFile = files.find((f) => new RegExp(`(?:const|let|function)\\s+${name}\\b`).test(read(f)));
      if (!defFile) continue;
      const def = definitionOf(read(defFile), name);
      if (!def) continue;
      const call = def.match(/\b(?:api|axios|http|client|request)\s*\.\s*(get|post|put|patch|delete)\s*(?:<[^>]*>)?\s*\(\s*([^,)\n]+)/i);
      if (!call) continue;
      const endpoint = call[2]!.trim();
      keyIndex();
      const literal = endpoint.match(/^(['"`])(\/[^'"`]*)\1$/)?.[2];
      const key = endpoint.match(/\.(\w+)$/)?.[1];
      const paths = literal ? [literal] : key ? keyPaths.get(key) ?? [] : [];
      const params = [...new Set([...(def.match(/params\s*:\s*\{([^}]*)\}/)?.[1] ?? '').matchAll(/(\w+)/g)].map((m) => m[1]!))];
      // How the changed file enables it: the options object passed to the call.
      const at = source.indexOf(`${name}(`);
      const enabled = at >= 0 ? source.slice(at, at + 400).match(/enabled\s*:\s*([^,}\n]+)/)?.[1]?.trim() ?? null : null;
      const id = `${rel}:${name}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ via: name, method: call[1]!.toUpperCase(), endpoint, paths, params, enabledWhen: enabled ? `enabled: ${enabled}` : null, definedIn: path.relative(repoDir, defFile), trigger: triggerPath(source, name) });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* How the user reaches a call: handler -> JSX control -> dialog -> ...         */
/* -------------------------------------------------------------------------- */

const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Name and body of the function declared as `const name = ... =>` / `function name` that encloses `at`. */
function enclosingFunction(source: string, at: number): { name: string; start: number; body: string } | null {
  const decls = [...source.slice(0, at).matchAll(/(?:const|let)\s+(\w+)\s*=\s*(?:useCallback\(\s*)?(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::\s*[^=]+)?=>|function\s+(\w+)\s*\(/g)];
  for (const d of decls.reverse()) {
    const start = d.index!;
    // The body ends where braces opened after the declaration balance out.
    const open = source.indexOf('{', start + d[0].length - 1);
    if (open < 0 || open > at) continue;
    let depth = 0; let end = -1;
    for (let i = open; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}' && --depth === 0) { end = i; break; }
    }
    if (end >= at) return { name: (d[1] ?? d[2])!, start, body: source.slice(start, end + 1) };
  }
  return null;
}

/** The JSX element whose attribute at `at` references a handler: tag, and its visible label when it has one. */
function elementAt(source: string, at: number): { tag: string; attrs: string; label: string | null; labelIsKey: boolean } | null {
  const open = source.lastIndexOf('<', at);
  const tag = source.slice(open).match(/^<([A-Za-z][\w.]*)/)?.[1];
  if (!tag) return null;
  const endOfOpen = source.indexOf('>', at);
  const attrs = source.slice(open, endOfOpen + 1);
  const inner = source.slice(endOfOpen + 1, source.indexOf(`</${tag}`, endOfOpen) >>> 0 || endOfOpen + 400).slice(0, 600);
  const key = inner.match(/\b(?:text|t)\(\s*(['"`])([^'"`]+)\1\s*\)/)?.[2];
  const label = key ?? inner.match(/>\s*([A-Za-z][^<>{}\n]{1,40}?)\s*</)?.[1] ?? null;
  return { tag, attrs, label, labelIsKey: Boolean(key) };
}

/** Whether `at` lies inside the callback of a .map( call (a list or table rendering one element per item). */
function insideMap(source: string, at: number): boolean {
  for (const m of source.slice(0, at).matchAll(/\.map\(\s*(?:\(|\w+\s*=>)/g)) {
    let depth = 0;
    for (let i = m.index! + m[0].indexOf('('); i < source.length; i++) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')' && --depth === 0) { if (i > at) return true; break; }
    }
  }
  return false;
}

/** One thing a user does on the way to a request, as the source wires it. */
export interface TriggerStep {
  /** control: a JSX element with a handler; dialog: a dialog component submitted; confirm: confirmDialog(...). */
  kind: 'control' | 'dialog' | 'confirm';
  /** The JSX tag (control) or the dialog component (dialog). */
  tag?: string;
  /** The attribute that invokes the handler: onClick, onChange, onOk. */
  event?: string;
  handler?: string;
  /** The element's label as written: a translation key inside text("..."), or literal text. */
  label?: string | null;
  labelIsKey?: boolean;
  /** The id attribute's expression, e.g. htmlIds.btn_reset. */
  idExpr?: string | null;
  /** How many elements in the file carry the same id expression. */
  idUses?: number;
  /** control: rendered inside a .map(...) - one per list or table row. */
  perRow?: boolean;
  /** control: its handler does nothing but open the dialog of the next step (safe to click to look). */
  opensDialogOnly?: boolean;
  /** confirm: the title passed to confirmDialog, a translation key or text. */
  title?: string | null;
  titleIsKey?: boolean;
}

/**
 * Walks back from the call of `hook`'s result in a changed component to the
 * control a user operates: which handler calls it, whether a confirmation
 * dialog stands in between, which JSX element or dialog invokes that handler,
 * and what opens that dialog. Textual and bounded; it never guesses a selector.
 */
export function traceTrigger(source: string, hook: string): TriggerStep[] | null {
  const hookAt = source.search(new RegExp(`\\b${hook}\\s*\\(`));
  if (hookAt < 0) return null;
  const binding = source.slice(Math.max(0, source.lastIndexOf('\n', hookAt)), hookAt);
  const alias = binding.match(/(?:mutateAsync|mutate)\s*:\s*(\w+)/)?.[1] ?? binding.match(/(?:const|let)\s+(\w+)\s*=\s*$/)?.[1];
  if (!alias) return null;

  const steps: TriggerStep[] = [];
  let callee = alias;
  /** A function that opens a dialog: resolved by who invokes it, not by a call to it. */
  let opener: { name: string; only: boolean } | null = null;
  const visited = new Set<string>();
  for (let depth = 0; depth < 6; depth++) {
    let handler: string;
    let opensDialogOnly = false;
    if (opener) {
      handler = opener.name;
      opensDialogOnly = opener.only;
      opener = null;
    } else {
      // A call of the callee inside some other function (not its own binding).
      const uses = [...source.matchAll(new RegExp(`(?<![\\w.])${escapeRe(callee)}\\s*\\(`, 'g'))].map((m) => m.index!)
        .filter((i) => !/(?:const|let)\s*\{?[^;=]*$/.test(source.slice(source.lastIndexOf('\n', i), i)));
      const fn = uses.map((i) => ({ i, fn: enclosingFunction(source, i) })).find((u) => u.fn && !visited.has(u.fn.name));
      if (!fn?.fn) break;
      visited.add(fn.fn.name);
      const before = source.slice(fn.fn.start, fn.i);
      const confirmAt = before.search(/\b(confirmDialog|confirm|showConfirm|openConfirm)\s*\(/);
      if (confirmAt >= 0) {
        const title = before.slice(confirmAt).match(/\btitle\s*:\s*(?:(?:text|t)\(\s*(['"`])([^'"`]+)\1\s*\)|(['"`])([^'"`]+)\3)/);
        steps.unshift({ kind: 'confirm', title: title?.[2] ?? title?.[4] ?? null, titleIsKey: Boolean(title?.[2]) });
      }
      handler = fn.fn.name;
    }

    // Who invokes the handler: a JSX attribute, or another function.
    const attr = source.match(new RegExp(`(\\w+)=\\{\\s*(?:(?:async\\s*)?\\([^)]*\\)\\s*=>\\s*)?${escapeRe(handler)}\\b`));
    if (attr) {
      const el = elementAt(source, attr.index!);
      if (!el) break;
      const ref = el.attrs.match(/\bref=\{\s*(\w+)\s*\}/)?.[1];
      if (/^[A-Z]/.test(el.tag) && ref) {
        // A dialog component: its own action calls the handler; something opens it.
        steps.unshift({ kind: 'dialog', tag: el.tag, event: attr[1], handler });
        const openAt = source.search(new RegExp(`${escapeRe(ref)}\\.current\\?*\\.open\\s*\\(`));
        const openFn = openAt >= 0 ? enclosingFunction(source, openAt) : null;
        if (!openFn || visited.has(openFn.name)) break;
        visited.add(openFn.name);
        // Its body is only the open() call: clicking it changes nothing.
        const only = openFn.body.replace(/^[^{]*\{/, '').replace(/\}\s*$/, '').replace(/\/\/[^\n]*/g, '').trim()
          .replace(new RegExp(`${escapeRe(ref)}\\.current\\?*\\.open\\s*\\(\\s*\\)\\s*;?`), '').trim() === '';
        opener = { name: openFn.name, only };
        continue;
      }
      const idExpr = el.attrs.match(/\bid=\{\s*([^}\s]+)\s*\}|\bid=(['"])([^'"]+)\2/);
      const id = idExpr ? (idExpr[1] ?? `'${idExpr[3]}'`) : null;
      steps.unshift({
        kind: 'control', tag: el.tag, event: attr[1], handler, label: el.label, labelIsKey: el.labelIsKey,
        idExpr: id, idUses: id ? source.split(idExpr![0]).length - 1 : 0, opensDialogOnly, perRow: insideMap(source, attr.index!),
      });
      return steps;
    }
    callee = handler;
  }
  return steps.length ? steps : null;
}

/** The trace as sentences, for a prompt. */
export function triggerPath(source: string, hook: string): string[] | null {
  const steps = traceTrigger(source, hook);
  return steps ? steps.map(describeStep) : null;
}

function describeStep(s: TriggerStep): string {
  if (s.kind === 'confirm') return 'confirm the confirmation dialog';
  if (s.kind === 'dialog') return `fill in and submit ${s.tag} (its ${s.event} calls ${s.handler})`;
  return `${s.event === 'onClick' ? 'click' : `trigger ${s.event} on`} the ${s.tag}${s.label ? ` labelled ${s.label}` : ''}${s.idExpr ? ` (id ${s.idExpr})` : ''} (${s.event}={${s.handler}})`;
}

export function renderApiEvidence(items: ApiCallEvidence[], changedFileOf: (via: string) => string | undefined = () => undefined): string {
  return items.map((e) => [
    `- ${e.via}${changedFileOf(e.via) ? ` (used by ${changedFileOf(e.via)})` : ''}: ${e.method} ${e.endpoint}`,
    `  path(s): ${e.paths.length ? e.paths.join(' | ') : 'not resolved'}`,
    e.params.length ? `  params: ${e.params.join(', ')}` : null,
    e.enabledWhen ? `  only when ${e.enabledWhen}` : null,
    e.trigger?.length ? `  sent when the user: ${e.trigger.join(' -> ')} -> ${e.method} request` : null,
  ].filter(Boolean).join('\n')).join('\n');
}
