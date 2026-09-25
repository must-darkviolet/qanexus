/**
 * Flow tracing: every way a user can make a piece of code run, read from the
 * source across components.
 *
 * behaviorEvidence.traceTrigger follows one chain inside one file. Real flows
 * cross components: PR #2577's refresh() lives in EducationHistoryDialog and
 * runs when the page's handleOnSaveSuperSave calls
 * educationHistoryDialogRef.current?.refresh(), which runs after a Super Save
 * switch - in a table row, or inside that dialog after "View History" opened
 * it - and a confirmation. This walks those edges:
 *
 *   - a call of the function inside another function        -> walk that one
 *   - a call inside a JSX attribute (onClick={() => f(...)}) -> the element is the control
 *   - the function passed as a JSX attribute (onOk={f})      -> into the child component,
 *     to the control that calls that prop; the child is opened by whoever calls
 *     its ref's open()
 *   - a method of useImperativeHandle (refresh)              -> the parent that calls ref.current?.refresh()
 *   - confirmDialog({ onOk: () => f() })                     -> a confirmation step
 *   - if (cond) { f() } / cond && f()                        -> a condition on the path
 *
 * and returns each path from the control a user starts at to the function.
 * Textual and bounded: it recognises the common React patterns, never runs code.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface FlowStep {
  /** control: an element with a handler; submit: a form's submit; confirm: confirmDialog(...). */
  kind: 'control' | 'submit' | 'confirm';
  /** The JSX tag of the control. */
  tag?: string;
  event?: string;
  handler?: string;
  /** Visible label as written: a translation key inside text("..."), or literal text. */
  label?: string | null;
  labelIsKey?: boolean;
  idExpr?: string | null;
  /** Elements in the same file carrying the same id expression. */
  idUses?: number;
  /** Rendered once per list / table row. */
  perRow?: boolean;
  /** The data-grid column (field) it is rendered in. */
  column?: string | null;
  /** The ref-opened component (dialog) the control is inside, when it is. */
  inComponent?: string | null;
  /** The component's source file, for reading its form (submit steps). */
  componentFile?: string | null;
  /** This control only opens the next step's component (and sets state): safe to click to look. */
  opensComponent?: string | null;
  /** confirm: the title passed to confirmDialog. */
  title?: string | null;
  titleIsKey?: boolean;
  /** The branch the step is on, e.g. "!(props.status)". */
  when?: string | null;
}

export interface FlowPath {
  steps: FlowStep[];
  /** Conditions in the code between the control and the target, e.g. "selectedUserForHistory?.user_email && selectedUserForHistory?.user_id". */
  conditions: string[];
}

export interface SourceFile { file: string; source: string }

export interface TraceContext {
  /** The file defining a component, when it is part of the repository. */
  component(name: string): SourceFile | null;
  /** Files that render <name ...>. */
  renderersOf(name: string): SourceFile[];
  /** Files that import `name` (a page module re-exporting a screen imports it without rendering it). */
  importersOf?(name: string): SourceFile[];
  /** Every source file whose text matches. */
  filesMatching?(re: RegExp): SourceFile[];
}

/** The URL a Next.js page file serves: pages/users/user-details/index.ts -> /users/user-details; app/x/page.tsx -> /x. */
export function routeOfPageFile(file: string): string | null {
  const f = file.replace(/\\/g, '/');
  const pages = f.match(/(?:^|\/)pages\/(.+?)\.[cm]?[jt]sx?$/);
  if (pages) {
    const rel = pages[1]!.replace(/(^|\/)index$/, '');
    if (/^(_app|_document|_error|api(\/|$))/.test(rel)) return null;
    return `/${rel}`;
  }
  const app = f.match(/(?:^|\/)app\/(?:(.*)\/)?page\.[cm]?[jt]sx?$/);
  if (app) return `/${(app[1] ?? '').split('/').filter((seg) => !/^\(.*\)$/.test(seg)).join('/')}`;
  return null;
}

/**
 * Whether `from` uses the `name` defined in `target` (two components can share a
 * name): its import of `name` resolves to the target file, its folder, or a
 * barrel folder above it. No import (same file) counts.
 */
export function importsFrom(from: SourceFile, name: string, target: string): boolean {
  const spec = from.source.match(new RegExp(`import[^;]*\\b${name}\\b[^;]*from\\s*['"]([^'"]+)['"]`))?.[1];
  if (!spec) return true;
  const t = target.replace(/\\/g, '/').replace(/\.[cm]?[jt]sx?$/, '');
  const resolved = spec.startsWith('.')
    ? path.posix.normalize(path.posix.join(path.posix.dirname(from.file.replace(/\\/g, '/')), spec))
    : spec.replace(/^[@~]?[\w-]*\//, ''); // an alias: @sections/x -> sections/x, matched anywhere in the path
  return spec.startsWith('.')
    ? t === resolved || t.startsWith(`${resolved}/`)
    : t.endsWith(resolved) || t.includes(`/${resolved}/`) || t.endsWith(`/${resolved}`);
}

/** The page routes that end up showing the component defined in `file` (through renderers and re-exporting page modules). */
export function routesShowing(ctx: TraceContext, start: SourceFile): string[] {
  const seen = new Set<string>([start.file]);
  let frontier: SourceFile[] = [start];
  const routes = new Set<string>();
  for (let depth = 0; depth < 6 && frontier.length; depth++) {
    const next: SourceFile[] = [];
    for (const sf of frontier) {
      const own = routeOfPageFile(sf.file);
      if (own) { routes.add(own); continue; }
      const name = sf.source ? componentName(sf) : path.basename(sf.file).replace(/\.[^.]+$/, '');
      for (const up of [...ctx.renderersOf(name), ...(ctx.importersOf?.(name) ?? [])]) {
        if (seen.has(up.file) || !importsFrom(up, name, sf.file)) continue;
        seen.add(up.file);
        next.push(up);
      }
    }
    frontier = next;
  }
  return [...routes];
}

const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Index of the bracket closing the one at `open`, or -1. */
function closing(source: string, open: number): number {
  const pairs: Record<string, string> = { '{': '}', '(': ')', '[': ']' };
  const want = pairs[source[open]!];
  if (!want) return -1;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === '"' || ch === "'" || ch === '`') {
      // Skip string literals (no nesting of template expressions needed for our patterns).
      const end = source.indexOf(ch, i + 1);
      if (end < 0) return -1;
      i = end;
      continue;
    }
    if (ch === source[open]) depth++;
    else if (ch === want && --depth === 0) return i;
  }
  return -1;
}

/** The component a file defines: its default export, else the first capitalised function. */
export function componentName(sf: SourceFile): string {
  const def = sf.source.match(/export\s+default\s+(?:forwardRef\(\s*)?(?:function\s+)?([A-Z]\w*)/)?.[1];
  return def ?? sf.source.match(/function\s+([A-Z]\w*)\s*\(/)?.[1] ?? path.basename(sf.file).replace(/\.[^.]+$/, '');
}

interface Callable { name: string; start: number; bodyStart: number; end: number; kind: 'function' | 'imperative' | 'component' }

/** Every function-like declaration in the file, with its body range. */
function callables(sf: SourceFile): Callable[] {
  const out: Callable[] = [];
  const s = sf.source;
  const comp = componentName(sf);
  const decl = /(?:const|let)\s+(\w+)\s*=\s*(?:useCallback\(\s*)?(?:async\s*)?(?:\(([^()]|\([^()]*\))*\)|\w+)\s*(?::\s*[^=;{]+)?=>\s*|function\s+(\w+)\s*\(/g;
  for (const m of s.matchAll(decl)) {
    const name = (m[1] ?? m[3])!;
    const brace = s.indexOf('{', m.index! + m[0].length - (m[3] ? 0 : 0));
    // Expression-bodied arrow: body runs to the end of the statement.
    const exprBody = !m[3] && s[m.index! + m[0].length] !== '{';
    const bodyStart = exprBody ? m.index! + m[0].length : brace;
    const end = exprBody ? (() => { const e = s.slice(bodyStart).search(/[;\n]\s*(?:const|let|function|return|\})/); return e < 0 ? s.length : bodyStart + e; })() : closing(s, brace);
    if (bodyStart < 0 || end < 0) continue;
    out.push({ name, start: m.index!, bodyStart, end, kind: name === comp ? 'component' : 'function' });
  }
  // Methods a component exposes through useImperativeHandle: refresh: async () => {...}
  for (const h of s.matchAll(/useImperativeHandle\s*\(/g)) {
    const end = closing(s, h.index! + h[0].length - 1);
    if (end < 0) continue;
    const block = s.slice(h.index!, end);
    for (const m of block.matchAll(/(\w+)\s*:\s*(?:async\s*)?\([^)]*\)\s*=>\s*/g)) {
      const at = h.index! + m.index! + m[0].length;
      const bodyEnd = s[at] === '{' ? closing(s, at) : at + (s.slice(at).search(/,\s*\n|\n\s*\}/) >>> 0);
      out.push({ name: m[1]!, start: h.index! + m.index!, bodyStart: at, end: bodyEnd, kind: 'imperative' });
    }
  }
  return out;
}

/** The innermost callable containing `at` (an imperative method wins over the component around it). */
function enclosing(sf: SourceFile, at: number): Callable | null {
  const all = callables(sf).filter((c) => c.bodyStart <= at && at <= c.end);
  if (!all.length) return null;
  return all.sort((a, b) => b.bodyStart - a.bodyStart)[0]!;
}

/** The JSX attribute whose {...} value contains `at`: name and where it starts. */
function attributeAt(source: string, at: number): { name: string; index: number } | null {
  const before = source.slice(0, at);
  const all = [...before.matchAll(/(\w+)=\{/g)];
  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i]!;
    const open = m.index! + m[0].length - 1;
    const end = closing(source, open);
    if (end > at) return { name: m[1]!, index: m.index! };
    // An attribute that closed before `at` whose tag also closed: stop looking further back.
    if (before.slice(end, at).includes('/>') || /<\/\w/.test(before.slice(end, at))) break;
  }
  return null;
}

interface Element { tag: string; attrs: string; open: number; label: string | null; labelIsKey: boolean }

/** The JSX element around the attribute at `at`. */
function elementAt(source: string, at: number): Element | null {
  let open = source.lastIndexOf('<', at);
  while (open >= 0 && !/^<[A-Za-z]/.test(source.slice(open, open + 2))) open = source.lastIndexOf('<', open - 1);
  const tag = source.slice(open).match(/^<([A-Za-z][\w.]*)/)?.[1];
  if (!tag) return null;
  // The opening tag ends at the first ">" outside braces.
  let end = open;
  for (let i = open, depth = 0; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
    else if (source[i] === '>' && depth === 0) { end = i; break; }
  }
  const attrs = source.slice(open, end + 1);
  const selfClosing = attrs.endsWith('/>');
  const inner = selfClosing ? '' : source.slice(end + 1, Math.min(source.length, source.indexOf(`</${tag}`, end) >>> 0 || end + 600)).slice(0, 600);
  const key = inner.match(/\b(?:text|t)\(\s*(['"`])([^'"`]+)\1\s*\)/)?.[2];
  let label = key ?? inner.match(/>\s*([A-Za-z][^<>{}\n]{1,40}?)\s*</)?.[1] ?? null;
  let labelIsKey = Boolean(key);
  if (!label) {
    // No text of its own (a switch, an icon button): the nearest label written just before it.
    const near = [...source.slice(Math.max(0, open - 500), open).matchAll(/\b(?:text|t)\(\s*(['"`])([^'"`]+)\1\s*\)/g)].pop()?.[2];
    if (near) { label = near; labelIsKey = true; }
  }
  return { tag, attrs, open, label, labelIsKey };
}

/** Whether `at` is rendered once per row: inside .map(...) or a data grid's renderCell. */
function rowContext(source: string, at: number): { perRow: boolean; column: string | null; header: string | null } {
  for (const m of source.slice(0, at).matchAll(/renderCell\s*:\s*/g)) {
    const bodyAt = source.indexOf('=>', m.index!);
    if (bodyAt < 0) continue;
    const bodyOpen = source.slice(bodyAt + 2).search(/\S/) + bodyAt + 2;
    const end = source[bodyOpen] === '{' || source[bodyOpen] === '(' ? closing(source, bodyOpen) : -1;
    if (end > at) {
      const column = source.slice(Math.max(0, m.index! - 1500), m.index!);
      const field = [...column.matchAll(/\bfield\s*:\s*(['"`])(\w+)\1/g)].pop()?.[2] ?? null;
      const header = [...column.matchAll(/(?:headerName|renderHeader)[\s\S]{0,200}?(?:text|t)\(\s*(['"`])([^'"`]+)\1/g)].pop()?.[2] ?? null;
      return { perRow: true, column: field, header };
    }
  }
  for (const m of source.slice(0, at).matchAll(/\.map\(\s*/g)) {
    const open = m.index! + m[0].indexOf('(');
    const end = closing(source, open);
    if (end > at) return { perRow: true, column: null, header: null };
  }
  return { perRow: false, column: null, header: null };
}

/** The condition guarding `at` inside [from, to): if (cond) { ...at... }, else-branches, and `cond && f()`. */
function guardOf(source: string, from: number, at: number): string | null {
  const inline = source.slice(Math.max(from, at - 200), at).match(/([\w?.!]+(?:\s*&&\s*[\w?.!]+)*)\s*&&\s*$/);
  if (inline) return inline[1]!.trim();
  const body = source.slice(from, at);
  for (const m of [...body.matchAll(/\bif\s*\(/g)].reverse()) {
    const condOpen = from + m.index! + m[0].length - 1;
    const condClose = closing(source, condOpen);
    if (condClose < 0) continue;
    const blockOpen = source.indexOf('{', condClose);
    const blockClose = blockOpen >= 0 ? closing(source, blockOpen) : -1;
    const cond = source.slice(condOpen + 1, condClose).replace(/\s+/g, ' ').trim();
    if (blockOpen >= 0 && blockOpen < at && blockClose > at) return cond;
    const elseAt = blockClose > 0 ? source.slice(blockClose + 1, blockClose + 20).match(/^\s*else\s*\{/) : null;
    if (elseAt) {
      const elseOpen = blockClose + 1 + elseAt[0].length - 1;
      if (elseOpen < at && closing(source, elseOpen) > at) return `!(${cond})`;
    }
  }
  return null;
}

/** confirmDialog({ ... onOk: () => f() }) around `at` inside the function: its title. */
function confirmAround(source: string, from: number, at: number): { title: string | null; isKey: boolean } | null {
  for (const m of [...source.slice(from, at).matchAll(/\b(confirmDialog|confirm|showConfirm|openConfirm)\s*\(/g)].reverse()) {
    const open = from + m.index! + m[0].length - 1;
    if (closing(source, open) > at) {
      const args = source.slice(open, at);
      const t = args.match(/\btitle\s*:\s*(?:(?:text|t)\(\s*(['"`])([^'"`]+)\1\s*\)|(['"`])([^'"`]+)\3)/);
      return { title: t?.[2] ?? t?.[4] ?? null, isKey: Boolean(t?.[2]) };
    }
  }
  return null;
}

const MAX_DEPTH = 9;
const MAX_PATHS = 12;

export class FlowTracer {
  constructor(private readonly ctx: TraceContext) {}

  /** Every path from a control to a call of `name` in `sf`. */
  pathsTo(sf: SourceFile, name: string): FlowPath[] {
    const paths = this.walk(sf, name, 0, new Set());
    // A path that starts inside a ref-opened component (its form) starts by opening it.
    const out: FlowPath[] = [];
    for (const p of paths) {
      const first = p.steps[0];
      if (first && first.kind !== 'control' && first.componentFile) {
        const home = first.componentFile === sf.file ? sf : this.ctx.component(first.inComponent ?? '') ?? sf;
        const openers = this.pathsToOpen(home);
        if (openers.length) {
          const inside = p.steps.map((st) => ({ ...st, inComponent: st.inComponent ?? componentName(home) }));
          for (const o of openers) out.push({ steps: [...o.steps, ...inside], conditions: [...o.conditions, ...p.conditions] });
          continue;
        }
      }
      out.push(p);
    }
    return dedupe(out).slice(0, MAX_PATHS);
  }

  private walk(sf: SourceFile, name: string, depth: number, seen: Set<string>): FlowPath[] {
    const key = `${sf.file}#${name}`;
    if (depth > MAX_DEPTH || seen.has(key)) return [];
    const visited = new Set(seen).add(key);
    const out: FlowPath[] = [];
    const s = sf.source;

    // (a) Calls: name(...), props.name(...), x.current?.name(...) is handled by the ref walk.
    for (const m of s.matchAll(new RegExp(`(?<![\\w.])(?:props\\.)?${escapeRe(name)}\\s*\\(`, 'g'))) {
      const at = m.index!;
      const lineStart = s.lastIndexOf('\n', at);
      if (/(?:const|let|function)\s*\{?[^;=]*$/.test(s.slice(lineStart, at)) && !/=>\s*$|\(\s*$/.test(s.slice(lineStart, at))) continue; // its own declaration
      const fn = enclosing(sf, at);
      const attr = attributeAt(s, at);
      // A call inside a JSX attribute of an element that is itself inside fn's render: the element is the trigger.
      if (attr && (!fn || fn.kind === 'component' || attr.index > fn.bodyStart)) {
        const inAttrFn = fn && fn.kind !== 'component' && fn.bodyStart > attr.index ? fn : null;
        if (!inAttrFn) { out.push(...this.fromAttribute(sf, attr, name, visited, depth)); continue; }
      }
      if (!fn || fn.kind === 'component') continue; // runs while rendering, not on a user action
      const rawGuard = guardOf(s, fn.bodyStart, at);
      // "if (onSave) onSave()" only checks the callback exists: not a condition on the flow.
      const guard = rawGuard && !new RegExp(`^!?\\(?\\s*(?:props\\.)?${escapeRe(name)}\\s*\\)?$`).test(rawGuard) ? rawGuard : null;
      const confirm = confirmAround(s, fn.bodyStart, at);
      const tail: FlowStep[] = confirm ? [{ kind: 'confirm', title: confirm.title, titleIsKey: confirm.isKey, when: guardOf(s, fn.bodyStart, s.lastIndexOf(confirm.title ?? 'confirm', at)) }] : [];
      const conditions = guard && !confirm ? [`${fn.name}: ${guard}`] : [];
      const upstream = fn.kind === 'imperative' ? this.viaRef(sf, fn.name, depth, visited) : this.walk(sf, fn.name, depth + 1, visited);
      for (const p of upstream) out.push({ steps: [...p.steps, ...tail.map((t) => ({ ...t, when: t.when ?? guard }))], conditions: [...p.conditions, ...conditions] });
    }
    // (b) Passed by reference: attr={name}
    for (const m of s.matchAll(new RegExp(`(\\w+)=\\{\\s*${escapeRe(name)}\\s*\\}`, 'g'))) {
      out.push(...this.fromAttribute(sf, { name: m[1]!, index: m.index! }, name, visited, depth));
    }
    return dedupe(out);
  }

  /** Every path that opens `sf`'s component through its ref (its queries run when it opens). */
  pathsToOpen(sf: SourceFile): FlowPath[] {
    return this.viaRef(sf, 'open', 0, new Set()).map((p) => {
      const last = p.steps[p.steps.length - 1];
      return last ? { ...p, steps: [...p.steps.slice(0, -1), { ...last, opensComponent: last.opensComponent ?? componentName(sf) }] } : p;
    }).slice(0, MAX_PATHS);
  }

  /** A method exposed by useImperativeHandle runs when a parent calls ref.current?.method(). */
  private viaRef(sf: SourceFile, method: string, depth: number, seen: Set<string>): FlowPath[] {
    const comp = componentName(sf);
    const out: FlowPath[] = [];
    for (const parent of this.ctx.renderersOf(comp)) {
      for (const r of parent.source.matchAll(new RegExp(`<${comp}\\b[^>]*?\\bref=\\{\\s*(\\w+)\\s*\\}`, 'gs'))) {
        const ref = r[1]!;
        for (const call of parent.source.matchAll(new RegExp(`${escapeRe(ref)}\\.current\\?*\\.${escapeRe(method)}\\s*\\(`, 'g'))) {
          const fn = enclosing(parent, call.index!);
          // Called inline by an element: onClick={() => ref.current?.open()}.
          const attr = attributeAt(parent.source, call.index!);
          if (attr && (!fn || fn.kind === 'component' || attr.index > fn.bodyStart)) {
            for (const p of this.fromAttribute(parent, attr, `${ref}.current.${method}`, seen, depth + 1)) {
              const last = p.steps[p.steps.length - 1];
              out.push(method === 'open' && last ? { ...p, steps: [...p.steps.slice(0, -1), { ...last, opensComponent: comp }] } : p);
            }
            continue;
          }
          if (!fn || fn.kind === 'component') continue;
          const guard = guardOf(parent.source, fn.bodyStart, call.index!);
          for (const p of this.walk(parent, fn.name, depth + 1, seen)) {
            out.push({ steps: p.steps, conditions: [...p.conditions, ...(guard ? [`${fn.name}: ${guard}`] : [])] });
          }
        }
      }
    }
    return out;
  }

  /** The element carrying attribute `attr` triggers the handler: a control, a form, or a child component. */
  private fromAttribute(sf: SourceFile, attr: { name: string; index: number }, handler: string, seen: Set<string>, depth: number): FlowPath[] {
    const s = sf.source;
    const el = elementAt(s, attr.index);
    if (!el) return [];
    const ref = el.attrs.match(/\bref=\{\s*(\w+)\s*\}/)?.[1];
    const child = /^[A-Z]/.test(el.tag) && el.tag !== 'Formik' ? this.ctx.component(el.tag) : null;
    const comp = componentName(sf);

    // A form: submitted by its submit button (read from the component's source by the recipe).
    if (attr.name === 'onSubmit' && /^(Formik|form|Form)$/.test(el.tag)) {
      return [{ steps: [{ kind: 'submit', handler, event: attr.name, inComponent: comp, componentFile: sf.file }], conditions: [] }];
    }
    // An application component that is opened by a ref (a dialog): into it, then who opens it.
    if (child && ref) {
      const inner = this.walk(child, attr.name, depth + 1, seen)
        .map((p) => ({ ...p, steps: p.steps.map((st) => ({ ...st, inComponent: st.inComponent ?? el.tag, componentFile: st.componentFile ?? child.file })) }));
      const insides: FlowPath[] = inner.length ? inner
        : [{ steps: [{ kind: 'submit', handler, event: attr.name, inComponent: el.tag, componentFile: child.file }], conditions: [] }];
      const openers: FlowPath[] = [];
      for (const o of s.matchAll(new RegExp(`${escapeRe(ref)}\\.current\\?*\\.open\\s*\\(`, 'g'))) {
        const fn = enclosing(sf, o.index!);
        if (!fn || fn.kind === 'component') continue;
        const body = s.slice(fn.bodyStart, fn.end);
        const onlyOpens = body.replace(/\/\/[^\n]*/g, '').replace(new RegExp(`${escapeRe(ref)}\\.current\\?*\\.open\\s*\\(\\s*\\)\\s*;?`), '')
          .replace(/\bset[A-Z]\w*\s*\(\s*(\{[^}]*\}|[^()]*)\)\s*;?/g, '').replace(/[{}\s;]/g, '') === '';
        const guard = guardOf(s, fn.bodyStart, o.index!);
        for (const p of this.walk(sf, fn.name, depth + 1, seen)) {
          const last = p.steps[p.steps.length - 1];
          const steps = last && onlyOpens ? [...p.steps.slice(0, -1), { ...last, opensComponent: el.tag }] : p.steps;
          openers.push({ steps: steps.map((st) => ({ ...st, when: st.when ?? (guard && st === last ? guard : null) })), conditions: p.conditions });
        }
      }
      if (!openers.length) return insides;
      return openers.flatMap((o) => insides.map((i) => ({ steps: [...o.steps, ...i.steps], conditions: [...o.conditions, ...i.conditions] })));
    }
    // A control (a native element or a library component).
    const id = el.attrs.match(/\bid=\{\s*([^}\s]+)\s*\}|\bid=(['"])([^'"]+)\2/);
    const idExpr = id ? (id[1] ?? `'${id[3]}'`) : null;
    const row = rowContext(s, attr.index);
    return [{
      steps: [{
        kind: 'control', tag: el.tag, event: attr.name, handler, label: el.label ?? row.header, labelIsKey: el.label ? el.labelIsKey : Boolean(row.header),
        idExpr, idUses: idExpr ? s.split(id![0]).length - 1 : 0, perRow: row.perRow, column: row.column, componentFile: sf.file,
      }],
      conditions: [],
    }];
  }
}

function dedupe(paths: FlowPath[]): FlowPath[] {
  const seen = new Set<string>();
  return paths.filter((p) => {
    const k = JSON.stringify(p);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/* -------------------------------------------------------------------------- */
/* Repository context                                                          */
/* -------------------------------------------------------------------------- */

const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage', 'out']);

export function repoTraceContext(repoDir: string): TraceContext {
  const files: string[] = [];
  const walkDir = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith('.')) walkDir(full); }
      else if (/\.[jt]sx?$/.test(e.name) && !/\.(test|spec|stories|d)\.[jt]sx?$/.test(e.name)) files.push(full);
    }
  };
  walkDir(repoDir);
  const cache = new Map<string, string>();
  const read = (f: string) => { if (!cache.has(f)) { try { cache.set(f, fs.readFileSync(f, 'utf8')); } catch { cache.set(f, ''); } } return cache.get(f)!; };
  const rel = (f: string) => path.relative(repoDir, f);
  return {
    component: (name) => {
      const f = files.find((x) => path.basename(x).replace(/\.[^.]+$/, '') === name && new RegExp(`function\\s+${name}\\b|const\\s+${name}\\b`).test(read(x)))
        ?? files.find((x) => new RegExp(`(?:function|const)\\s+${name}\\b[^\\n]*(?:\\(|=)`).test(read(x)) && /return\s*\(?\s*</.test(read(x)));
      return f ? { file: rel(f), source: read(f) } : null;
    },
    renderersOf: (name) => files.filter((f) => new RegExp(`<${name}\\b`).test(read(f))).map((f) => ({ file: rel(f), source: read(f) })),
    importersOf: (name) => files.filter((f) => new RegExp(`import[^;]*\\b${name}\\b[^;]*from`).test(read(f))).map((f) => ({ file: rel(f), source: read(f) })),
    filesMatching: (re) => files.filter((f) => re.test(read(f))).map((f) => ({ file: rel(f), source: read(f) })),
  };
}
