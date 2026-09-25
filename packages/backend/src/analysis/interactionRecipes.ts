/**
 * Journeys: every way a user makes the changed code send a request, step by
 * step, with the ways each control can be located - built for tests to run,
 * not only for a model to read.
 *
 * analysis/flowTrace.ts finds the paths through the code (controls, dialogs,
 * forms, confirmations, the conditions on the way). Here each path becomes a
 * journey:
 *
 *   - steps with locator candidates read from the repository: the visible
 *     label from the app's own translation file as a role + accessible name,
 *     the id (flagged when several elements share it), exact text, the data
 *     grid column for a control repeated per row, the dialog scope;
 *   - the requests it leads to, with the code conditions on the way
 *     ("handleOnSaveSuperSave: selectedUserForHistory?.user_email && ...");
 *   - guards: the data-changing requests it sends, answered by the test (never
 *     the real backend).
 *
 * Journeys are written into the suite as a flows class (playwright/flows.ts),
 * run by qa.runFlow, proven against the live application before tests are
 * generated, and preflight requires tests to use them.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ApiCallEvidence } from './behaviorEvidence.js';
import { FlowTracer, repoTraceContext, routesShowing, type FlowPath, type FlowStep, type TraceContext } from './flowTrace.js';

/** Where to look for a control: the page, or the dialog that is open. */
export interface LocatorSpec {
  role?: string;
  name?: string;
  css?: string;
  text?: string;
  label?: string;
  inDialog?: boolean;
}

export interface LocatorCandidate extends LocatorSpec {
  /** Scoped to one table / list row (and data-grid column). */
  row?: { column: string | null } | null;
  /** Stable id for the live check. */
  id: string;
  /** The Playwright expression a test would write. */
  code: string;
  /** Why it may be unreliable, from the source (an id several elements share). */
  caution?: string;
  /** What the live page showed; absent when it was not checked. */
  live?: { count: number; visible: boolean };
  /** One per list/table row: several matches are expected; scope it to one row. */
  perRow?: boolean;
}

export interface JourneyField {
  what: string;
  required: boolean;
  date: boolean;
  candidates: LocatorCandidate[];
}

export interface JourneyStep {
  action: 'click' | 'submit' | 'confirm';
  what: string;
  scope: 'page' | 'dialog';
  row: { column: string | null } | null;
  candidates: LocatorCandidate[];
  /** Filled before this step's click (a dialog's form). */
  fields: JourneyField[];
  /** The code branch this step is on, e.g. "!(props.status)" - it depends on the row's data. */
  when: string | null;
  /** Clicking it only opens the next step's dialog. */
  opensDialog: boolean;
  /** The source handler the step runs, and the file it is in: what state it sets. */
  handler?: string | null;
  file?: string | null;
}

export interface JourneyTarget {
  method: string;
  path: string;
  via: string;
  /** qa alias the flow records it under. */
  alias: string;
  /** Code conditions between the steps and this request. */
  conditions: string[];
  /** Whether the conditions hold in this journey, worked out from the state its steps set. */
  expected?: { sent: boolean | null; why: string };
}

export interface Journey {
  /** Method name on the flows class. */
  name: string;
  /** The page the journey starts on. */
  route: string | null;
  /** A page that needs a query (?email=...) is opened by following a link to it from a page that has one. */
  entry: { via: string; link: string } | null;
  /** The file of the component the first step is in. */
  file: string | null;
  steps: JourneyStep[];
  leadsTo: JourneyTarget[];
  /** Data-changing requests on the way: the flow answers them itself (never the real backend). */
  guards: { method: string; path: string; alias: string }[];
  /** Set by the live proof (pipeline): the flow ran to its end on the running application. */
  proven?: { ok: boolean; detail: string };
}

/* -------------------------------------------------------------------------- */
/* The repository's labels and ids                                             */
/* -------------------------------------------------------------------------- */

const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage', 'out']);

function walk(root: string, keep: (f: string) => boolean, limit = 8000): string[] {
  const out: string[] = [];
  const go = (dir: string) => {
    if (out.length >= limit) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith('.')) go(full); }
      else if (keep(full)) out.push(full);
    }
  };
  go(root);
  return out;
}

const read = (f: string) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

export interface RepoVocabulary {
  /** Translation key -> English text. */
  label(key: string): string | null;
  /** htmlIds.x -> the id attribute value. */
  id(expr: string): string | null;
  /** The source of the component with this name. */
  component(name: string): string | null;
  /** The source of the file that implements the app's confirm dialog. */
  confirmDialog(): string | null;
}

export function repoVocabulary(repoDir: string): RepoVocabulary {
  const sources = walk(repoDir, (f) => /\.[cm]?[jt]sx?$/.test(f) && !/\.(test|spec|d)\.[jt]sx?$/.test(f));
  let labels: Map<string, string> | null = null;
  const loadLabels = () => {
    if (labels) return labels;
    labels = new Map();
    // English first: en.json, en/*.json, en-US.json under a locale / i18n / lang / translations folder.
    const files = walk(repoDir, (f) => /\.json$/.test(f) && /(locale|i18n|lang|translation|messages)/i.test(f)
      && /(^|[/\\._-])en([/\\._-]|-us|$)/i.test(path.relative(repoDir, f)));
    const flatten = (obj: unknown, prefix: string) => {
      if (!obj || typeof obj !== 'object') return;
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (typeof v === 'string') { if (!labels!.has(key)) labels!.set(key, v); if (!labels!.has(k)) labels!.set(k, v); }
        else flatten(v, key);
      }
    };
    for (const f of files) { try { flatten(JSON.parse(read(f)), ''); } catch { /* not JSON */ } }
    return labels;
  };
  let idMap: Map<string, string> | null = null;
  const loadIds = () => {
    if (idMap) return idMap;
    idMap = new Map();
    for (const f of sources.filter((x) => /(^|[/\\])(html)?ids?\.[jt]sx?$/i.test(x))) {
      for (const m of read(f).matchAll(/^\s*(\w+)\s*:\s*(['"`])([^'"`]+)\2/gm)) idMap.set(m[1]!, m[3]!);
    }
    return idMap;
  };
  return {
    label: (key) => loadLabels().get(key) ?? null,
    id: (expr) => {
      const literal = expr.match(/^'([^']+)'$/)?.[1];
      if (literal) return literal;
      const name = expr.match(/\.(\w+)$/)?.[1] ?? expr.match(/^(\w+)$/)?.[1];
      if (!name) return null;
      // A key: "value" map, or (the common case) an array/enum where the id is the name itself.
      return loadIds().get(name) ?? name;
    },
    component: (name) => {
      const named = sources.find((f) => path.basename(f).replace(/\.[^.]+$/, '') === name && new RegExp(`\\b${name}\\b`).test(read(f)));
      if (named) return read(named);
      const def = sources.find((f) => new RegExp(`(?:function|const|class)\\s+${name}\\b`).test(read(f)));
      return def ? read(def) : null;
    },
    confirmDialog: () => {
      const f = sources.find((x) => /confirmDialog/.test(read(x)) && /Provider/.test(read(x)) && /(okButtonText|submitText|confirmText)/.test(read(x)));
      return f ? read(f) : null;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Candidates                                                                  */
/* -------------------------------------------------------------------------- */

const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** The Playwright expression for a candidate, as a test would write it. */
export function locatorCode(l: LocatorSpec & { row?: { column: string | null } | null }): string {
  let base = l.inDialog ? "page.getByRole('dialog').last()" : 'page';
  if (l.row) base = `qa.row(0${l.row.column ? `, ${q(l.row.column)}` : ''})`;
  if (l.role) return `${base}.getByRole(${q(l.role)}${l.name ? `, { name: ${q(l.name)}, exact: true }` : ''})`;
  if (l.label) return `${base}.getByLabel(${q(l.label)}, { exact: true })`;
  if (l.text) return `${base}.getByText(${q(l.text)}, { exact: true })`;
  return `${base}.locator(${q(l.css ?? '')})`;
}

/** The ARIA roles a JSX tag renders with, when it is a common control. */
function roleOf(tag: string): string[] {
  if (/^(button|Button|IconButton|LoadingButton|\w*MuiButton|\w*Button)$/.test(tag)) return ['button'];
  if (/^(a|Link|NextLink)$/.test(tag)) return ['link'];
  if (/Switch$/.test(tag)) return ['switch', 'checkbox'];
  if (/Checkbox$/.test(tag)) return ['checkbox'];
  if (/^(Tab)$/.test(tag)) return ['tab'];
  if (/^(MenuItem)$/.test(tag)) return ['menuitem'];
  return [];
}

/** CSS for a library control whose input may be hidden (a MUI switch hides its checkbox). */
function cssOf(tag: string): string[] {
  if (/Switch$/.test(tag)) return ['.MuiSwitch-root', '.MuiSwitch-switchBase', 'input[type="checkbox"]'];
  if (/Checkbox$/.test(tag)) return ['.MuiCheckbox-root', 'input[type="checkbox"]'];
  return [];
}

let counter = 0;
function candidate(spec: LocatorSpec & { row?: { column: string | null } | null }, caution?: string): LocatorCandidate {
  return { id: `c${++counter}`, ...spec, code: locatorCode(spec), ...(caution ? { caution } : {}) };
}

/** A form's title, fields and submit button, read from its component's source. */
function formParts(source: string, vocab: RepoVocabulary) {
  const resolve = (key: string | undefined) => (key ? vocab.label(key) ?? null : null);
  const required = [...source.matchAll(/\[\s*(htmlIds\.\w+)\s*\]\s*:\s*Yup[\s\S]{0,300}?\.required\(/g)].map((m) => m[1]!);
  const labels = [...source.matchAll(/\blabel=\{\s*(?:text|t)\(\s*(['"`])([^'"`]+)\1/g)].map((m) => resolve(m[2]));
  const dateLabels = [...source.matchAll(/<(\w*Date\w*)\b[^>]*?\blabel=\{\s*(?:text|t)\(\s*(['"`])([^'"`]+)\2/gs)].map((m) => resolve(m[3]));
  const submitKey = source.match(/\bsubmitText=\{\s*(?:text|t)\(\s*(['"`])([^'"`]+)\1/)?.[2]
    ?? source.match(/<(?:\w*Button)[^>]*type=["']submit["'][^>]*>[\s\S]{0,200}?(?:text|t)\(\s*(['"`])([^'"`]+)\1/)?.[2];
  const submitId = source.match(/\bsubmitBtnId=\{\s*([^}\s]+)\s*\}/)?.[1] ?? null;
  return { required, labels, dateLabels, submit: resolve(submitKey), submitId };
}

/** One traced step as a journey step with its candidates. */
function toStep(st: FlowStep, next: FlowStep | undefined, vocab: RepoVocabulary, repoDir: string): JourneyStep {
  return { ...toStepInner(st, next, vocab, repoDir), handler: st.handler ?? null, file: st.componentFile ?? null };
}

function toStepInner(st: FlowStep, next: FlowStep | undefined, vocab: RepoVocabulary, repoDir: string): JourneyStep {
  const inDialog = Boolean(st.inComponent);
  const scope: 'page' | 'dialog' = inDialog || st.kind !== 'control' ? 'dialog' : 'page';
  if (st.kind === 'control') {
    const label = st.label ? (st.labelIsKey ? vocab.label(st.label) : st.label) : null;
    const row = st.perRow ? { column: st.column ?? null } : null;
    const base = { ...(inDialog ? { inDialog: true } : {}), ...(row ? { row } : {}) };
    const c: LocatorCandidate[] = [];
    const ownText = /button|Button|Link|^a$|Tab|MenuItem/.test(st.tag!);
    for (const role of roleOf(st.tag!)) if (label && ownText) c.push(candidate({ ...base, role, name: label }));
    const idValue = st.idExpr ? vocab.id(st.idExpr) : null;
    if (idValue) c.push(candidate({ ...base, css: `#${idValue}` }, (st.idUses ?? 0) > 1 ? `${st.idUses} elements in the source share id ${idValue}` : undefined));
    for (const css of cssOf(st.tag!)) c.push(candidate({ ...base, css }));
    if (label && ownText) c.push(candidate({ ...base, text: label }));
    for (const role of roleOf(st.tag!)) if (!(label && ownText)) c.push(candidate({ ...base, role }));
    return {
      action: 'click', scope, row, candidates: c, fields: [], when: st.when ?? null, opensDialog: Boolean(st.opensComponent),
      what: `${st.event === 'onClick' ? 'click' : `use (${st.event})`} the ${st.tag}${label ? ` "${label}"` : ''}${row ? ` in a table row${row.column ? ` (column ${row.column})` : ''}` : ''}${inDialog ? ` inside ${st.inComponent}` : ''}${st.opensComponent ? ` - opens ${st.opensComponent}` : ''}`,
    };
  }
  if (st.kind === 'submit') {
    const src = st.componentFile ? (() => { try { return fs.readFileSync(path.join(repoDir, st.componentFile!), 'utf8'); } catch { return ''; } })() : '';
    const parts = formParts(src, vocab);
    const fields: JourneyField[] = [];
    parts.labels.forEach((label, i) => {
      if (!label) return;
      const date = parts.dateLabels.includes(label);
      const idValue = parts.required[i] ? vocab.id(parts.required[i]!) : null;
      if (!date && !idValue) return; // other fields are completed at runtime (qa.runFlow fills what is required and empty)
      fields.push({ what: label, required: Boolean(idValue) || date, date,
        candidates: [candidate({ inDialog: true, label }), ...(idValue ? [candidate({ inDialog: true, css: `#${idValue}` })] : [])] });
    });
    const c: LocatorCandidate[] = [];
    if (parts.submitId) { const v = vocab.id(parts.submitId); if (v) c.push(candidate({ inDialog: true, css: `#${v}` })); }
    if (parts.submit) c.push(candidate({ inDialog: true, role: 'button', name: parts.submit }));
    c.push(candidate({ inDialog: true, css: 'button[type="submit"]' }));
    return {
      action: 'submit', scope: 'dialog', row: null, candidates: c, fields, when: st.when ?? null, opensDialog: false,
      what: `complete the form in ${st.inComponent ?? 'the dialog'} and submit it${parts.submit ? ` ("${parts.submit}")` : ''}`,
    };
  }
  const title = st.title ? (st.titleIsKey ? vocab.label(st.title) : st.title) : null;
  const src = vocab.confirmDialog();
  const okKey = src?.match(/(?:okButtonText|confirmText)[^|]*\|\|\s*(?:text|t)\(\s*(['"`])([^'"`]+)\1/)?.[2];
  const ok = okKey ? vocab.label(okKey) : null;
  const okId = src?.match(/\bsubmitBtnId=\{\s*([^}\s]+)\s*\}/)?.[1];
  const c: LocatorCandidate[] = [];
  if (okId) { const v = vocab.id(okId); if (v) c.push(candidate({ inDialog: true, css: `#${v}` })); }
  if (ok) c.push(candidate({ inDialog: true, role: 'button', name: ok }));
  void next;
  return { action: 'confirm', scope: 'dialog', row: null, candidates: c, fields: [], when: st.when ?? null, opensDialog: false,
    what: `confirm${title ? ` "${title}"` : ' the confirmation dialog'}${ok ? ` with "${ok}"` : ''}` };
}

/** A GET that changes data: its endpoint's own name starts with a verb that writes (reset_education_manual, approve_all_education). */
const WRITE_VERB = /^(reset|delete|remove|purge|destroy|approve|reject|wipe|clear|deactivate|terminate|save|submit|update|change|toggle|confirm|send|apply|create|add|set|cancel|restrict)$/i;
const writesData = (method: string, p: string) => method !== 'GET' || WRITE_VERB.test((p.split('/').filter(Boolean).pop() ?? '').split(/[_-]/)[0] ?? '');
const aliasOf = (p: string) => p.split('/').filter(Boolean).pop()?.replace(/[^\w-]/g, '') ?? 'request';
const camelWords = (words: string[]) => words.join(' ').replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 8)
  .map((w, i) => (i === 0 ? w.toLowerCase() : w[0]!.toUpperCase() + w.slice(1).toLowerCase())).join('') || 'flow';

function journeyName(steps: JourneyStep[]): string {
  const words = steps.map((s) => s.action === 'confirm' ? 'confirm' : s.action === 'submit' ? 'submit' : (s.what.match(/"([^"]+)"/)?.[1] ?? s.what.split(' ')[2] ?? 'click'));
  const row = steps[0]?.row ? ['in row'] : [];
  return camelWords([...words.slice(0, 1), ...row, ...words.slice(1)]);
}

const componentOf = (file: string) => path.basename(file).replace(/\.[^.]+$/, '');

/* -------------------------------------------------------------------------- */
/* Conditions                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Whether a journey makes a condition like
 *   "handleOnSaveSuperSave: selectedUserForHistory?.user_email && selectedUserForHistory?.user_id"
 * true: each value it reads is React state (useState) that starts empty and is
 * set only by some handlers (handleViewHistory -> setSelectedUserForHistory),
 * or a prop a parent fills (user={{ user_email: userDetail.email }}). A journey
 * none of whose steps sets the state leaves it empty: the guarded request is
 * not sent. Unknown when a value is neither.
 */
function evaluate(conditions: string[], steps: JourneyStep[], ctx: TraceContext, repoDir: string, files: string[]): { sent: boolean | null; why: string } | undefined {
  const read = (f: string) => { try { return fs.readFileSync(path.join(repoDir, f), 'utf8'); } catch { return ''; } };
  const parts = conditions.filter((c) => c !== '(sent on the way)').map((c) => {
    const m = c.match(/^([\w.]+)(?::|\s+enabled:)\s*(.*)$/);
    const fn = m?.[1] ?? '';
    // The file the condition is written in: where its function is declared (or its hook is called).
    const candidates = [...new Set([...files, ...steps.map((st) => st.file ?? '')])].filter(Boolean);
    const declares = new RegExp(`(?:const|let|function)\\s+${escapeRe(fn)}\\b|\\b${escapeRe(fn)}\\s*:\\s*(?:async\\s*)?\\(`);
    const file = candidates.find((f) => declares.test(read(f)))
      ?? candidates.find((f) => new RegExp(`(?<![.\\w])${escapeRe(fn)}\\s*\\(`).test(read(f))) ?? null;
    return { expr: (m?.[2] ?? c).replace(/^!!/, ''), file };
  });
  if (!parts.length) return undefined;
  const exprs = parts.map((p) => p.expr);
  // Only conjunctions of values being present are understood.
  if (exprs.some((e) => /\|\||[<>=]|!(?!\()/.test(e.replace(/!!/g, '')))) return { sent: null, why: 'the condition is not a plain "these values are present" check' };
  const roots = [...new Set(exprs.flatMap((e) => [...e.matchAll(/(?:^|[\s&(!])([a-zA-Z_]\w*)(?=\?*\.|\s*(?:&&|$|\)))/g)].map((m) => m[1]!)))]
    .filter((r) => !/^(true|false|null|undefined|props)$/.test(r));
  const reasons: string[] = [];
  const unknown: string[] = [];
  let allSet = true;
  const stateIn = (src: string, name: string) => src.match(new RegExp(`\\[\\s*${name}\\s*,\\s*(set\\w+)\\s*\\]\\s*=\\s*useState`))?.[1];
  for (const root of roots) {
    const home = parts.find((p) => new RegExp(`\\b${root}\\b`).test(p.expr))?.file ?? null;
    const src = home ? read(home) : '';
    let setter = stateIn(src, root);
    let stateName = root;
    // Data a query hook loads: present once it has loaded.
    if (!setter && new RegExp(`\\bdata\\s*:\\s*${root}\\b|const\\s+\\{[^}]*\\b${root}\\b[^}]*\\}\\s*=\\s*use[A-Z]`).test(src)) {
      reasons.push(`${root} is loaded by a query`);
      continue;
    }
    if (!setter && home) {
      // A prop: what the parent in this journey passes for it - <EducationHistoryDialog user={selectedUserForHistory} /> or user={{ ... }}.
      const comp = src.match(/export\s+default\s+(?:forwardRef\(\s*)?(?:function\s+)?([A-Z]\w*)/)?.[1] ?? src.match(/function\s+([A-Z]\w*)\s*\(/)?.[1] ?? '';
      const parents = ctx.renderersOf(comp).filter((sf) => new RegExp(`<${comp}\\b[^>]*?\\b${root}=\\{`, 's').test(sf.source));
      const parent = parents.find((sf) => steps.some((st) => st.file === sf.file)) ?? parents.find((sf) => files.includes(sf.file));
      const value = parent?.source.match(new RegExp(`<${comp}\\b[^>]*?\\b${root}=\\{\\s*(\\{|[\\w.]+)`, 's'))?.[1];
      if (value === '{') { reasons.push(`${root} is filled by ${componentOf(parent!.file)} (an object literal)`); continue; }
      if (parent && value && /^\w+$/.test(value)) {
        setter = stateIn(parent.source, value);
        stateName = value;
      }
    }
    if (!setter) { unknown.push(`could not work out ${root} from the code`); continue; }
    const setting = steps.find((st) => st.handler && st.file && new RegExp(`(?:const|function)\\s+${escapeRe(st.handler)}\\b[\\s\\S]{0,1500}?\\b${setter}\\s*\\(\\s*(?!undefined|null|''|false)`).test(read(st.file)));
    if (setting) reasons.push(`${stateName} is set by ${setting.handler} ("${setting.what.match(/"([^"]+)"/)?.[1] ?? setting.what}")`);
    else { allSet = false; reasons.push(`nothing in this journey sets ${stateName} (only ${setter}(...) does), so it is still empty`); }
  }
  // One value the journey leaves empty is enough: the request is not sent, whatever the others are.
  const uniq = (xs: string[]) => [...new Set(xs)].join('; ');
  if (!allSet) return { sent: false, why: `NOT expected in this journey: ${uniq(reasons.filter((r) => r.startsWith('nothing')))}` };
  if (unknown.length) return { sent: null, why: unknown.join('; ') };
  return allSet
    ? { sent: true, why: `expected in this journey: ${uniq(reasons)} (for a row whose data has the fields)` }
    : { sent: false, why: `NOT expected in this journey: ${reasons.filter((r) => r.startsWith('nothing')).join('; ')}` };
}

/* -------------------------------------------------------------------------- */
/* Journeys                                                                    */
/* -------------------------------------------------------------------------- */

/** The local name a changed file uses for a hook's result: mutateAsync: x, refetch: y, or const x = useX(). */
function aliasesOf(source: string, hook: string): string[] {
  const at = source.search(new RegExp(`\\b${hook}\\s*\\(`));
  if (at < 0) return [];
  const stmt = source.slice(source.lastIndexOf('const', at), at);
  const names = [...stmt.matchAll(/\b(?:mutateAsync|mutate|refetch)\s*:\s*(\w+)/g)].map((m) => m[1]!);
  if (/\{[^}]*\brefetch\b(?!\s*:)/.test(stmt)) names.push('refetch');
  const plain = stmt.match(/const\s+(\w+)\s*=\s*$/)?.[1];
  if (plain) names.push(plain);
  return names;
}

const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Where a journey that starts in `file` begins: its page, and a link that opens that page with real query values. */
function startOf(ctx: TraceContext, repoDir: string, file: string | null, fallback: string | null, cache: Map<string, { route: string | null; entry: Journey['entry'] }>, preferredVia: string[] = []) {
  if (!file) return { route: fallback, entry: null };
  const hit = cache.get(file);
  if (hit) return hit;
  const read = (f: string) => { try { return fs.readFileSync(path.join(repoDir, f), 'utf8'); } catch { return ''; } };
  const routes = routesShowing(ctx, { file, source: read(file) });
  let result: { route: string | null; entry: Journey['entry'] } = { route: fallback && routes.includes(fallback) ? fallback : routes[0] ?? fallback, entry: null };
  // A page the application only ever links to with a query (?email=...) shows nothing without one: open it
  // through such a link, even when it is the module's own route.
  const needsQuery = routes.some((r) => (ctx.filesMatching?.(new RegExp(`href=\\{?\\s*[\`'"]${escapeRe(r)}\\?`)) ?? []).length > 0);
  if (!(fallback && routes.includes(fallback)) || needsQuery) {
    // A link somewhere in the app to one of those pages: href={`/users/user-details?email=${row.email}`}.
    // A link on the module's own page first, then any other page's.
    const options = routes.map((route) => {
      const linking = ctx.filesMatching?.(new RegExp(`href=\\{?\\s*[\`'"]${escapeRe(route)}(\\?${needsQuery ? '' : `|[\`'"]`})`)) ?? [];
      const via = [...new Set(linking.flatMap((sf) => routesShowing(ctx, sf)))].filter((r) => r !== route && !/[[:*]/.test(r));
      return { route, via };
    });
    // The pages this review walks link the way the change is used (Education Management -> the user's Basic Information tab).
    const preferred = [...preferredVia, ...(fallback ? [fallback] : [])];
    const pick = options.find((o) => o.via.some((v) => preferred.includes(v)))
      ?? options.find((o) => o.route === fallback && o.via.length) ?? options.find((o) => o.via.length);
    if (pick) result = { route: pick.route, entry: { via: pick.via.find((v) => preferred.includes(v)) ?? pick.via[0]!, link: pick.route } };
  }
  cache.set(file, result);
  return result;
}

export function buildRecipes(repoDir: string, changedFiles: string[], evidence: ApiCallEvidence[], route: string | null, ownFiles?: string[], preferredVia: string[] = []): Journey[] {
  const vocab = repoVocabulary(repoDir);
  const ctx = repoTraceContext(repoDir);
  const tracer = new FlowTracer(ctx);
  const starts = new Map<string, { route: string | null; entry: Journey['entry'] }>();
  const byKey = new Map<string, Journey>();
  const read = (f: string) => { try { return fs.readFileSync(path.join(repoDir, f), 'utf8'); } catch { return ''; } };
  const guardsFor = (e: ApiCallEvidence) => e.paths[0] && writesData(e.method, e.paths[0])
    ? [{ method: e.method, path: e.paths[0], alias: aliasOf(e.paths[0]) }] : [];

  for (const e of evidence) {
    for (const file of changedFiles) {
      const source = read(file);
      if (!source.includes(`${e.via}(`)) continue;
      const sf = { file, source };
      const paths: FlowPath[] = aliasesOf(source, e.via).flatMap((a) => tracer.pathsTo(sf, a));
      // A query in a component opened by a ref runs when it opens.
      if (e.method === 'GET' && !paths.length || (e.enabledWhen && /useImperativeHandle/.test(source))) paths.push(...tracer.pathsToOpen(sf).map((p) => ({ ...p, conditions: [...p.conditions, ...(e.enabledWhen ? [`${e.via} ${e.enabledWhen}`] : [])] })));
      for (const p of paths) {
        if (!p.steps.length) continue;
        const file = p.steps[0]!.componentFile ?? null;
        // A module's journeys are the ones that start in its own files.
        if (ownFiles && file && !ownFiles.includes(file)) continue;
        const start = startOf(ctx, repoDir, file, route, starts, preferredVia);
        const steps = p.steps.map((st, i) => toStep(st, p.steps[i + 1], vocab, repoDir));
        const key = JSON.stringify([start.route, steps.map((st) => [st.action, st.what])]);
        const journey = byKey.get(key) ?? { name: '', route: start.route, entry: start.entry, file, steps, leadsTo: [], guards: [] };
        const target: JourneyTarget = { method: e.method, path: e.paths[0] ?? e.endpoint, via: e.via, alias: aliasOf(e.paths[0] ?? e.via), conditions: p.conditions };
        if (!journey.leadsTo.some((t) => t.path === target.path && JSON.stringify(t.conditions) === JSON.stringify(target.conditions))) journey.leadsTo.push(target);
        for (const g of guardsFor(e)) if (!journey.guards.some((x) => x.path === g.path)) journey.guards.push(g);
        byKey.set(key, journey);
      }
    }
  }
  // A journey that is a prefix of another sends what the prefix sends, too.
  const all = [...byKey.values()];
  for (const j of all) {
    for (const other of all) {
      if (other === j || other.steps.length <= j.steps.length) continue;
      const prefix = j.steps.every((st, i) => st.what === other.steps[i]!.what);
      if (!prefix) continue;
      for (const t of j.leadsTo) if (!other.leadsTo.some((x) => x.path === t.path)) other.leadsTo.push({ ...t, conditions: [...t.conditions, '(sent on the way)'] });
    }
  }
  for (const j of all) for (const t of j.leadsTo) t.expected = evaluate(t.conditions, j.steps, ctx, repoDir, changedFiles);
  const used = new Set<string>();
  for (const j of all) {
    let name = journeyName(j.steps);
    for (let n = 2; used.has(name); n++) name = `${journeyName(j.steps)}${n}`;
    used.add(name);
    j.name = name;
  }
  return all;
}

/* -------------------------------------------------------------------------- */
/* Live checks (walkthrough)                                                   */
/* -------------------------------------------------------------------------- */

export interface LiveCheckPlan {
  route: string;
  page: LocatorCandidate[];
  dialogs: { openWith: LocatorCandidate[]; inDialog: LocatorCandidate[] }[];
}

/** Page-level first steps are counted on the live page (row-scoped ones are proven by running the flow). */
export function liveCheckPlan(journeys: Journey[]): LiveCheckPlan[] {
  const byRoute = new Map<string, LiveCheckPlan>();
  for (const j of journeys) {
    if (!j.route) continue;
    const plan = byRoute.get(j.route) ?? { route: j.route, page: [], dialogs: [] };
    const first = j.steps[0];
    if (first && !first.row && first.scope === 'page' && !j.entry) plan.page.push(...first.candidates.filter((c) => !plan.page.some((x) => x.id === c.id)));
    byRoute.set(j.route, plan);
  }
  return [...byRoute.values()];
}

export function applyLiveResults(journeys: Journey[], results: Record<string, { count: number; visible: boolean }>): void {
  for (const j of journeys) for (const st of j.steps) for (const c of [...st.candidates, ...st.fields.flatMap((f) => f.candidates)]) {
    if (results[c.id]) c.live = results[c.id];
  }
}

/** Best first: exactly one visible live match, then unchecked without caution, then the rest. */
function rank(c: LocatorCandidate): number {
  if (c.live) return c.live.count === 1 && c.live.visible ? 0 : c.live.count === 0 ? 4 : 3;
  return c.caution ? 3 : c.role && !c.name && !c.row ? 2 : 1;
}

/** Candidates in the order a flow tries them. */
export function ranked(list: LocatorCandidate[]): LocatorCandidate[] {
  return [...list].sort((a, b) => rank(a) - rank(b));
}

function verdict(c: LocatorCandidate): string {
  if (c.live) return c.live.count === 1 && c.live.visible ? 'live: exactly 1 visible match'
    : c.live.count === 0 ? 'live: NO match' : c.live.count > 1 ? `live: ${c.live.count} matches - not unique` : 'live: 1 match, not visible';
  return c.caution ?? 'from the source';
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

export function renderRecipes(journeys: Journey[], flowsInstance?: string): string {
  return journeys.map((j) => {
    const call = flowsInstance ? `${flowsInstance}.${j.name}()` : j.name;
    const status = j.proven ? (j.proven.ok ? 'PROVEN on the live application' : `NOT PROVEN: ${j.proven.detail}`) : 'not yet run';
    const lines = [`${call}  [${status}]${j.route ? ` - starts on ${j.route}${j.entry ? ` (opened through the first link to it on ${j.entry.via})` : ''}` : ''}`];
    j.steps.forEach((st, i) => {
      lines.push(`  ${i + 1}. ${st.what}${st.when ? `   (code branch: ${st.when})` : ''}`);
      for (const f of st.fields) lines.push(`     field "${f.what}"${f.date ? ' (date)' : ''}: ${ranked(f.candidates)[0]?.code ?? '-'}`);
      const best = ranked(st.candidates).filter((c) => rank(c) < 3);
      if (best.length) lines.push(`     locators tried in order: ${best.map((c) => `${c.code} (${verdict(c)})`).join(' | ')}`);
      const avoid = st.candidates.filter((c) => rank(c) >= 3);
      if (avoid.length) lines.push(`     unreliable: ${avoid.map((c) => `${c.code} (${verdict(c)})`).join(' | ')}`);
    });
    lines.push(`  leads to:`);
    for (const t of j.leadsTo) lines.push(`    ${t.method} ${t.path} (alias "${t.alias}")${t.conditions.length ? ` - only if ${t.conditions.join('; ')}` : ''}${t.expected ? ` => ${t.expected.why}` : ''}`);
    if (j.guards.length) lines.push(`  answered by the flow, never sent to the real backend: ${j.guards.map((g) => `${g.method} ${g.path} -> alias "${g.alias}" (200 unless you pass respond: { ${g.alias}: { statusCode, body } })`).join('; ')}`);
    return lines.join('\n');
  }).join('\n\n');
}

/** What preflight needs: endpoints a user action sends, and the flows that send them. */
export interface RecipeTrigger {
  paths: string[];
  method: string;
  /** Per flow: whether the live proof completed it. */
  proven?: Record<string, boolean>;
  /** Per flow that failed its live proof: why. */
  proofFailures?: Record<string, string>;
  steps: number;
  summary: string;
  flows: string[];
  /** The aliases each of those flows records (its guards): a test that calls the flow may assert them. */
  aliases: Record<string, string[]>;
  /** Per flow: the code conditions on the way to this request, and whether they hold in that flow. */
  conditions: Record<string, string[]>;
  expected: Record<string, { sent: boolean | null; why: string }>;
}

export function recipeTriggers(journeys: Journey[]): RecipeTrigger[] {
  const byPath = new Map<string, RecipeTrigger>();
  for (const j of journeys) for (const t of j.leadsTo) {
    const trig = byPath.get(t.path) ?? { paths: [t.path], method: t.method, steps: j.steps.length, summary: j.steps.map((s) => s.what).join(' -> '), flows: [], aliases: {}, conditions: {}, expected: {}, proven: {} };
    if (j.proven) trig.proven![j.name] = j.proven.ok;
    trig.steps = Math.min(trig.steps, j.steps.length);
    trig.flows.push(j.name);
    trig.aliases[j.name] = j.guards.map((g) => g.alias);
    trig.conditions[j.name] = t.conditions;
    if (j.proven && !j.proven.ok) (trig.proofFailures ??= {})[j.name] = j.proven.detail;
    if (t.expected) trig.expected[j.name] = t.expected;
    byPath.set(t.path, trig);
  }
  return [...byPath.values()];
}

/** Ids the source puts on several elements (id={htmlIds.btn_bug_report_save_request} on Approve All and Reset): not a way to find one control. */
export function sharedIds(journeys: Journey[]): string[] {
  return [...new Set(journeys.flatMap((j) => j.steps.flatMap((st) => st.candidates))
    .filter((c) => c.caution && /share id/.test(c.caution) && c.css?.startsWith('#')).map((c) => c.css!.slice(1)))];
}
