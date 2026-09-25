/**
 * The target repository's own Playwright suite.
 *
 * The generated suite (scaffold.ts / runner.ts) lives beside the checkout and
 * never touches the repository's tests. This module is the other half: it
 * finds the repository's playwright.config, picks the specs a pull request
 * plausibly affects, and runs them with the repository's OWN installed
 * Playwright, from the directory holding that config - so its fixtures, page
 * objects, projects, global setup and storageState all apply exactly as they
 * do in the repository's CI.
 *
 * Nothing here writes into the checkout: results, the HTML report and test
 * artefacts go to a caller-supplied output directory.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createLogger } from '../util/logger.js';
import { withoutSecrets } from '../util/process.js';

const log = createLogger('playwright:repo-suite');

export interface RepoPlaywrightSuite {
  /** The checkout root; spec paths below are relative to it. */
  repoDir: string;
  /** Absolute path to the repository's playwright.config.{ts,js,mjs,cjs,...}. */
  configFile: string;
  /** Directory containing that config (in a monorepo, possibly a subpackage). */
  rootDir: string;
  /** Best-effort parse of `testDir` from the config text, absolute. */
  testDir: string | null;
  /** Repository-relative spec paths (posix separators). */
  specFiles: string[];
  /** The repository's own installed Playwright CLI, or null when dependencies are not installed. */
  cliPath: string | null;
}

export type RepoTestOutcome = 'passed' | 'failed' | 'skipped' | 'flaky';

export interface RepoTestResult {
  /** Repository-relative spec path. */
  specFile: string;
  /** Describe path and test title joined with ' › '. */
  title: string;
  /** Playwright project the test ran in (a config may run each test in several). */
  project: string | null;
  outcome: RepoTestOutcome;
  durationMs: number;
  errorMessage: string | null;
  videoPath: string | null;
  screenshotPaths: string[];
  tracePath: string | null;
  retries: number;
}

export interface RelatedRepoSpec { spec: string; reasons: string[] }

export interface RunRepoSpecsResult {
  ran: boolean;
  skippedReason: string | null;
  results: RepoTestResult[];
  reportDir: string | null;
  stderrTail: string;
}

/* -------------------------------------------------------------------------- */
/* Detection                                                                   */
/* -------------------------------------------------------------------------- */

const CONFIG_NAME = /^playwright(\.[\w-]+)?\.config\.[cm]?[jt]s$/;
const CANONICAL_CONFIG = /^playwright\.config\.[cm]?[jt]s$/;
/** Directories never worth descending into when looking for configs or specs. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.turbo',
  '.cache', '.output', 'playwright-report', 'test-results', 'blob-report', 'vendor',
]);
const SOURCE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];
/** Playwright's own default testMatch. */
const DEFAULT_TEST_MATCH = /\.(spec|test)\.[cm]?[jt]sx?$/;
const MAX_CONFIG_DEPTH = 3;
const MAX_SPEC_FILES = 2000;

const toPosix = (p: string) => p.split(path.sep).join('/');

function readText(file: string): string {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

/**
 * Configs at the repository root win; otherwise the shallowest one (a
 * monorepo's e2e package). Among equals, `playwright.config.*` beats variants
 * like `playwright.ct.config.ts`, which are usually component-test configs.
 */
function findConfig(repoDir: string): string | null {
  const found: { file: string; depth: number; canonical: boolean }[] = [];
  const visit = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isFile() && CONFIG_NAME.test(e.name)) {
        found.push({ file: path.join(dir, e.name), depth, canonical: CANONICAL_CONFIG.test(e.name) });
      }
    }
    if (depth >= MAX_CONFIG_DEPTH) return;
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) visit(path.join(dir, e.name), depth + 1);
    }
  };
  visit(repoDir, 0);
  found.sort((a, b) => a.depth - b.depth || Number(b.canonical) - Number(a.canonical) || a.file.localeCompare(b.file));
  return found[0]?.file ?? null;
}

/** `testDir: './e2e'` or `testDir: path.join(__dirname, 'e2e')`; anything computed is left unknown. */
export function parseTestDir(configText: string, rootDir: string): string | null {
  const literal = configText.match(/\btestDir\s*:\s*['"`]([^'"`$]+)['"`]/);
  if (literal?.[1]) return path.resolve(rootDir, literal[1]);
  const joined = configText.match(/\btestDir\s*:\s*path\.(?:join|resolve)\(\s*__dirname\s*,\s*['"`]([^'"`$]+)['"`]\s*\)/);
  if (joined?.[1]) return path.resolve(rootDir, joined[1]);
  return null;
}

/** Converts the simple globs people put in testMatch (`**\/*.e2e.ts`) to a RegExp. */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`(^|/)${re}$`);
}

/**
 * The first top-level `testMatch` in the config, as a regex literal or a
 * glob string. Array forms and per-project values fall back to the default,
 * which errs toward including more files, never fewer.
 */
export function parseTestMatch(configText: string): RegExp | null {
  const regex = configText.match(/\btestMatch\s*:\s*\/((?:\\\/|[^/\n])+)\/([a-z]*)/);
  if (regex?.[1]) {
    try { return new RegExp(regex[1], regex[2]); } catch { /* fall through */ }
  }
  const glob = configText.match(/\btestMatch\s*:\s*['"`]([^'"`$]+)['"`]/);
  if (glob?.[1]) return globToRegExp(glob[1]);
  return null;
}

/**
 * Without an explicit testDir Playwright searches the whole config directory,
 * which in an app repository also holds Jest/Vitest unit tests with the same
 * suffixes. Those are recognised by not looking like Playwright at all.
 */
const LOOKS_PLAYWRIGHT = /@playwright\/test|\bpage\.(goto|locator|getBy\w+|click|fill)\(|\{\s*page\b[^}]*\}/;

function collectSpecs(repoDir: string, searchDir: string, match: RegExp, requirePlaywrightShape: boolean): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    if (out.length >= MAX_SPEC_FILES) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) visit(abs);
      } else if (e.isFile() && match.test(toPosix(path.relative(searchDir, abs)))) {
        if (requirePlaywrightShape && !LOOKS_PLAYWRIGHT.test(readText(abs))) continue;
        out.push(toPosix(path.relative(repoDir, abs)));
      }
    }
  };
  visit(searchDir);
  return out.sort();
}

/**
 * The repository's Playwright CLI, looked up from the config directory up to
 * (never above) the checkout root - above it is this backend's own
 * node_modules, whose Playwright version the repository never agreed to.
 */
function findRepoCli(rootDir: string, repoDir: string): string | null {
  const top = path.resolve(repoDir);
  let dir = path.resolve(rootDir);
  for (;;) {
    for (const pkg of ['playwright', '@playwright/test']) {
      const cli = path.join(dir, 'node_modules', pkg, 'cli.js');
      if (fs.existsSync(cli)) return cli;
    }
    if (dir === top) return null;
    const parent = path.dirname(dir);
    if (parent === dir || !parent.startsWith(top)) return null;
    dir = parent;
  }
}

export function detectRepoPlaywrightSuite(repoDir: string): RepoPlaywrightSuite | null {
  const configFile = findConfig(repoDir);
  if (!configFile) return null;
  const rootDir = path.dirname(configFile);
  const configText = readText(configFile);
  const testDir = parseTestDir(configText, rootDir);
  const explicitMatch = parseTestMatch(configText);
  const searchDir = testDir && fs.existsSync(testDir) ? testDir : rootDir;
  const specFiles = collectSpecs(repoDir, searchDir, explicitMatch ?? DEFAULT_TEST_MATCH, !testDir && !explicitMatch);
  return { repoDir, configFile, rootDir, testDir, specFiles, cliPath: findRepoCli(rootDir, repoDir) };
}

/* -------------------------------------------------------------------------- */
/* Selecting the specs a change affects                                        */
/* -------------------------------------------------------------------------- */

export interface SelectRelatedInput {
  repoDir: string;
  changedFiles: string[];
  affectedRoutes: string[];
  affectedFeatureNames: string[];
  affectedComponents: string[];
  max?: number;
}

/** Relative module specifiers from import/export-from/require/dynamic import. */
function relativeImports(text: string): string[] {
  const out = new Set<string>();
  const patterns = [
    /\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\b(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) if (m[1]?.startsWith('.')) out.add(m[1]);
  }
  return [...out];
}

/** Resolves a relative specifier the way TypeScript/Node would, including `.js` written for a `.ts` file. */
function resolveImport(fromFile: string, spec: string): string | null {
  const base = path.resolve(path.dirname(fromFile), spec);
  const stem = base.replace(/\.[cm]?jsx?$/, '');
  const candidates = [
    base,
    ...SOURCE_EXTS.map((e) => base + e),
    ...(stem !== base ? SOURCE_EXTS.map((e) => stem + e) : []),
    ...SOURCE_EXTS.map((e) => path.join(base, 'index' + e)),
  ];
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* next */ }
  }
  return null;
}

/** Route → matcher. `:id`, `[id]`, `[...slug]`, `{id}` and `*` are parameters. */
interface RouteMatcher { route: string; exact: RegExp; prefix: string | null }

const isParamSegment = (s: string) => /^(:|\[|\{|\*)/.test(s);

function routeMatcher(route: string): RouteMatcher | null {
  const clean = route.trim().replace(/[?#].*$/, '');
  if (!clean.startsWith('/')) return null;
  const segments = clean.split('/').filter(Boolean);
  const parts = segments.map((s) =>
    /^\[\.\.\./.test(s) || /\*$/.test(s) ? '.+' : isParamSegment(s) ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const exact = new RegExp(`^/${parts.join('/')}/?$`, 'i');
  const firstParam = segments.findIndex(isParamSegment);
  // `/users/:id` matches anything under `/users/`; a route that starts with a
  // parameter has no usable prefix and only matches exactly.
  const prefix = firstParam > 0 ? '/' + segments.slice(0, firstParam).join('/') + '/' : null;
  return { route, exact, prefix };
}

/** The path part of a URL literal: origin, query and hash stripped, template holes made concrete. */
function urlPath(literal: string): string | null {
  let p = literal.trim().replace(/^(?:https?:)?\/\/[^/]+/i, '').replace(/^\$\{[^}]*\}/, '');
  p = p.replace(/[?#].*$/, '').replace(/\$\{[^}]*\}/g, 'x');
  return p.startsWith('/') ? p : null;
}

function routeHit(literal: string, m: RouteMatcher): boolean {
  const p = urlPath(literal);
  if (!p) return false;
  if (m.exact.test(p)) return true;
  return Boolean(m.prefix && p.toLowerCase().startsWith(m.prefix.toLowerCase()) && p.length > m.prefix.length);
}

const GOTO_LITERAL = /\.goto\(\s*['"`]([^'"`]*)['"`]/g;
const ANY_PATH_LITERAL = /['"`]((?:https?:\/\/[^/'"`\s]+)?\/[^'"`\s]*)['"`]/g;

/** Words too generic to count as evidence that a spec and a feature are related. */
const GENERIC = new Set([
  'page', 'pages', 'test', 'tests', 'spec', 'specs', 'e2e', 'index', 'the', 'a', 'an', 'and', 'or', 'of', 'for',
  'to', 'in', 'on', 'with', 'component', 'components', 'view', 'screen', 'feature', 'features', 'management',
  'flow', 'app', 'ui', 'main', 'default', 'should', 'can', 'is', 'setup', 'ts', 'tsx', 'js', 'jsx',
]);

export function nameTokens(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !GENERIC.has(t))
    // Crude singularisation so "users" meets "user".
    .map((t) => (t.length > 3 && t.endsWith('ies') ? t.slice(0, -3) + 'y' : t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t));
}

const DESCRIBE_TITLE = /\bdescribe(?:\.\w+)*\(\s*['"`]([^'"`]+)['"`]/g;

/** Strength of each kind of reason; a spec ranks by its strongest one. */
const SCORE = { changed: 100, importDirect: 90, importIndirect: 80, goto: 70, route: 60, name: 30 } as const;

export function selectRelatedRepoSpecs(suite: RepoPlaywrightSuite, input: SelectRelatedInput): RelatedRepoSpec[] {
  const max = input.max ?? 20;
  const repoDir = path.resolve(input.repoDir);
  const changed = new Set(input.changedFiles.map((f) => toPosix(path.normalize(f)).replace(/^\.\//, '')));
  const matchers = input.affectedRoutes.map(routeMatcher).filter((m): m is RouteMatcher => m !== null);
  const names = [
    ...input.affectedFeatureNames.map((n) => ({ label: `feature "${n}"`, tokens: [...new Set(nameTokens(n))] })),
    ...input.affectedComponents.map((n) => ({ label: `component ${n}`, tokens: [...new Set(nameTokens(n))] })),
  ].filter((n) => n.tokens.length > 0);
  const rel = (abs: string) => toPosix(path.relative(repoDir, abs));

  const ranked: { spec: string; reasons: string[]; score: number; index: number }[] = [];

  suite.specFiles.forEach((spec, index) => {
    const specAbs = path.join(repoDir, spec);
    const text = readText(specAbs);
    const reasons: string[] = [];
    let score = 0;
    const add = (s: number, reason: string) => { if (!reasons.includes(reason)) { reasons.push(reason); score = Math.max(score, s); } };

    if (changed.has(spec)) add(SCORE.changed, 'spec changed in this pull request');

    // Imports, two levels deep: the spec, then the page objects / helpers it
    // imports. Only relative imports - path aliases would need tsconfig resolution.
    const level1 = relativeImports(text).map((s) => resolveImport(specAbs, s)).filter((f): f is string => f !== null);
    const level1Texts = new Map<string, string>();
    for (const dep of level1) {
      const depRel = rel(dep);
      if (changed.has(depRel)) add(SCORE.importDirect, `imports changed file ${depRel}`);
      const depText = readText(dep);
      level1Texts.set(dep, depText);
      for (const s of relativeImports(depText)) {
        const dep2 = resolveImport(dep, s);
        if (dep2 && changed.has(rel(dep2))) add(SCORE.importIndirect, `imports changed file ${rel(dep2)} via ${depRel}`);
      }
    }

    // Routes: a goto() into the route is stronger than merely mentioning its
    // path. Page objects often own the navigation, so their text counts too.
    const sources: [string, string | null][] = [[text, null], ...[...level1Texts].map(([f, t]) => [t, rel(f)] as [string, string])];
    for (const m of matchers) {
      for (const [src, via] of sources) {
        const suffix = via ? ` via ${via}` : '';
        const gotos = [...src.matchAll(GOTO_LITERAL)].map((x) => x[1] ?? '');
        if (gotos.some((g) => routeHit(g, m))) { add(SCORE.goto, `navigates to affected route ${m.route}${suffix}`); break; }
        const literals = [...src.matchAll(ANY_PATH_LITERAL)].map((x) => x[1] ?? '');
        if (literals.some((l) => routeHit(l, m))) { add(SCORE.route, `references affected route ${m.route}${suffix}`); break; }
      }
    }

    // Names: token overlap between the spec's path/describe titles and a
    // feature or component name. At least half the name's tokens must appear.
    if (names.length) {
      const specRelToTests = suite.testDir ? toPosix(path.relative(suite.testDir, specAbs)) : spec;
      const haystack = new Set([
        ...nameTokens(specRelToTests.replace(/\.(spec|test)\.[cm]?[jt]sx?$/, '')),
        ...[...text.matchAll(DESCRIBE_TITLE)].flatMap((x) => nameTokens(x[1] ?? '')),
      ]);
      for (const n of names) {
        const hits = n.tokens.filter((t) => haystack.has(t));
        if (hits.length && hits.length / n.tokens.length >= 0.5) {
          add(SCORE.name + Math.round(20 * hits.length / n.tokens.length), `name matches ${n.label} (${hits.join(', ')})`);
        }
      }
    }

    if (reasons.length) ranked.push({ spec, reasons, score, index });
  });

  // Strongest reason first; more corroborating reasons next; then detection
  // order, which is sorted, so the result is stable across runs.
  ranked.sort((a, b) => b.score - a.score || b.reasons.length - a.reasons.length || a.index - b.index);
  return ranked.slice(0, Math.max(0, max)).map(({ spec, reasons }) => ({ spec, reasons }));
}

/* -------------------------------------------------------------------------- */
/* JSON report                                                                 */
/* -------------------------------------------------------------------------- */

interface JsonAttachment { name: string; contentType: string; path?: string }
interface JsonResult {
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
  duration: number;
  retry?: number;
  error?: { message?: string };
  errors?: { message?: string }[];
  attachments?: JsonAttachment[];
}
interface JsonTest { projectName?: string; results: JsonResult[]; status: 'skipped' | 'expected' | 'unexpected' | 'flaky' }
interface JsonSpec { title: string; file: string; tests: JsonTest[] }
interface JsonSuite { title: string; file: string; specs?: JsonSpec[]; suites?: JsonSuite[] }
export interface RepoPlaywrightJsonReport {
  config?: { rootDir?: string };
  suites?: JsonSuite[];
  errors?: { message?: string }[];
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

function outcomeOf(test: JsonTest, last: JsonResult | undefined): RepoTestOutcome {
  if (test.status === 'flaky') return 'flaky';
  if (test.status === 'skipped' || !last || last.status === 'skipped') return 'skipped';
  return test.status === 'expected' ? 'passed' : 'failed';
}

/** Absolute attachment path, only if the file is actually on disk. */
function existing(p: string | undefined, base: string): string | null {
  if (!p) return null;
  const abs = path.resolve(base, p);
  return fs.existsSync(abs) ? abs : null;
}

/**
 * Flattens the repository run's JSON report. The report's `config.rootDir` is
 * the config's testDir, and spec `file`s are relative to it; results are
 * re-expressed relative to the checkout root. Exported for tests.
 */
export function parseRepoJsonReport(
  report: RepoPlaywrightJsonReport, where: { repoDir: string; rootDir: string },
): RepoTestResult[] {
  const reportRoot = report.config?.rootDir ?? where.rootDir;
  const results: RepoTestResult[] = [];

  const walk = (suite: JsonSuite, titles: string[], top: boolean) => {
    // The top-level suite is the file; its title is the path, not a describe.
    const own = top && suite.file && suite.title === suite.file ? titles : [...titles, suite.title].filter(Boolean);
    for (const spec of suite.specs ?? []) {
      const specFile = toPosix(path.relative(where.repoDir, path.resolve(reportRoot, spec.file)));
      for (const test of spec.tests) {
        const last = test.results[test.results.length - 1];
        // For a flaky test the evidence worth keeping is from the failing
        // attempt, so the newest attempt that recorded something wins.
        const attempts = [...test.results].reverse();
        const pick = (pred: (a: JsonAttachment) => boolean) => {
          for (const r of attempts) {
            for (const a of r.attachments ?? []) {
              const p = pred(a) ? existing(a.path, where.rootDir) : null;
              if (p) return p;
            }
          }
          return null;
        };
        const screenshotsFrom = attempts.find((r) => (r.attachments ?? []).some((a) => a.name === 'screenshot' && existing(a.path, where.rootDir)));
        const failure = attempts.find((r) => r.error || r.errors?.length);
        const error = failure?.error ?? failure?.errors?.[0];

        results.push({
          specFile,
          title: [...own, spec.title].join(' › '),
          project: test.projectName || null,
          outcome: outcomeOf(test, last),
          durationMs: Math.round(test.results.reduce((sum, r) => sum + (r.duration ?? 0), 0)),
          errorMessage: error?.message ? error.message.replace(ANSI, '') : null,
          videoPath: pick((a) => a.name === 'video' || a.contentType?.startsWith('video/')),
          screenshotPaths: (screenshotsFrom?.attachments ?? [])
            .filter((a) => a.name === 'screenshot')
            .map((a) => existing(a.path, where.rootDir))
            .filter((p): p is string => p !== null),
          tracePath: pick((a) => a.name === 'trace'),
          retries: Math.max(0, test.results.length - 1),
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, own, false);
  };

  for (const suite of report.suites ?? []) walk(suite, [], true);
  return results;
}

/* -------------------------------------------------------------------------- */
/* Running                                                                     */
/* -------------------------------------------------------------------------- */

export interface RunRepoSpecsOptions {
  suite: RepoPlaywrightSuite;
  /** Repository-relative spec paths, typically from selectRelatedRepoSpecs. */
  specs: string[];
  baseUrl: string;
  /** Absolute; created if missing. */
  outputDir: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Extra variables for the run (test credentials, say). Passed as given, on top of the scrubbed parent env. */
  env?: NodeJS.ProcessEnv;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function runRepoSpecs(opts: RunRepoSpecsOptions): Promise<RunRepoSpecsResult> {
  const { suite } = opts;
  const skip = (skippedReason: string, stderrTail = ''): RunRepoSpecsResult =>
    ({ ran: false, skippedReason, results: [], reportDir: null, stderrTail });

  if (!suite.cliPath) {
    return skip('The repository\'s own Playwright is not installed in the checkout (its dependencies were not installed), so its existing tests cannot be run with its own configuration.');
  }
  // An empty filter would run the whole repository suite, which is never what
  // "run the related specs" means.
  if (opts.specs.length === 0) return skip('No existing repository specs were selected to run.');

  fs.mkdirSync(opts.outputDir, { recursive: true });
  const reportFile = path.join(opts.outputDir, 'results.json');
  const reportDir = path.join(opts.outputDir, 'report');
  fs.rmSync(reportFile, { force: true });

  const childEnv: NodeJS.ProcessEnv = {
    ...withoutSecrets(process.env),
    ...(opts.env ?? {}),
    FORCE_COLOR: '0',
    // Configs read their base URL from any of these; use.baseURL itself is
    // left to the config so its own defaulting logic still applies.
    BASE_URL: opts.baseUrl,
    PLAYWRIGHT_BASE_URL: opts.baseUrl,
    PW_BASE_URL: opts.baseUrl,
    // Both spellings: older Playwright versions read the first of each pair.
    PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile,
    PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile,
    PLAYWRIGHT_HTML_REPORT: reportDir,
    PLAYWRIGHT_HTML_OUTPUT_DIR: reportDir,
    PLAYWRIGHT_HTML_OPEN: 'never',
    PW_TEST_HTML_REPORT_OPEN: 'never',
  };

  // Video cannot be forced from the CLI without editing the repository's
  // config, which we never do; whatever `use.video` says is what we get.
  const args = [suite.cliPath, 'test', '--reporter=json,html', '--output', path.join(opts.outputDir, 'test-results')];
  // CLI filters are regular expressions matched against the file path.
  for (const spec of opts.specs) args.push(escapeRegExp(toPosix(path.relative(suite.rootDir, path.join(suite.repoDir, spec)))));

  log.info(`Running ${opts.specs.length} existing repository spec(s) with the repository's own Playwright against ${opts.baseUrl}.`);
  let exit: { code: number | null; stderr: string } | null = null;
  let failure: string | null = null;
  try {
    exit = await runProcess(process.execPath, args, suite.rootDir, childEnv, opts.timeoutMs, opts.signal);
  } catch (e) {
    failure = (e as Error).message;
    log.warn(`Repository Playwright run did not finish: ${failure}`);
  }
  const stderrTail = exit?.stderr.slice(-2000) ?? '';

  let report: RepoPlaywrightJsonReport;
  try {
    report = JSON.parse(fs.readFileSync(reportFile, 'utf8')) as RepoPlaywrightJsonReport;
  } catch {
    // No report: the run was killed, or Playwright could not start (config
    // error, missing browsers, a webServer that never came up).
    return skip(failure ?? `The repository's Playwright produced no report (exit code ${exit?.code ?? 'unknown'}).`, stderrTail);
  }

  const results = parseRepoJsonReport(report, { repoDir: suite.repoDir, rootDir: suite.rootDir });
  log.info(`Repository specs: ${results.filter((r) => r.outcome === 'passed').length} passed, ${results.filter((r) => r.outcome === 'failed').length} failed, ${results.filter((r) => r.outcome === 'flaky').length} flaky.`);
  return {
    ran: true,
    skippedReason: null,
    results,
    reportDir: fs.existsSync(reportDir) ? reportDir : null,
    stderrTail,
  };
}

/** Same pattern as runner.ts: own process group, whole tree killed on timeout or abort. */
function runProcess(
  command: string, args: string[], cwd: string, childEnv: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    // Its own process group: Playwright's workers, the browsers they launch and
    // any webServer the config starts are separate processes.
    const child = spawn(command, args, {
      cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stderr = '';
    let settled = false;
    child.stdout.on('data', (d: Buffer) => log.debug(d.toString().trim()));
    child.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-4000); });

    const killTree = (sig: NodeJS.Signals) => {
      if (child.pid === undefined || child.exitCode !== null) return;
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
        else process.kill(-child.pid, sig);
      } catch { /* already gone */ }
    };
    const stop = () => {
      // SIGTERM first so Playwright can close its browsers, then insist.
      killTree('SIGTERM');
      setTimeout(() => killTree('SIGKILL'), 5000).unref();
    };

    const timer = setTimeout(() => {
      if (settled) return;
      stop();
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(`The repository's Playwright run timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    const onAbort = () => {
      if (settled) return;
      stop();
      settled = true;
      clearTimeout(timer);
      reject(new Error('The repository\'s Playwright run was stopped.'));
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    child.on('error', (e) => finish(() => reject(e)));
    // Exit code 1 means tests failed; whether the run happened is decided by the report.
    child.on('close', (code) => finish(() => resolve({ code, stderr })));
  });
}
