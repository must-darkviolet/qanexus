/**
 * Playwright execution and evidence collection (spec sections 16 and 19).
 *
 * Runs the generated suite with the Playwright Test CLI in a child process and
 * reads its JSON report, which carries per-test status, errors and the paths
 * of the video, screenshots and trace Playwright recorded. The console,
 * network and DOM evidence gathered by the qa fixture arrives as an attachment
 * on the same result.
 *
 * Each run writes into its own output directory, so recordings from earlier
 * runs are never overwritten and can be linked from reports and PR comments.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import type { ExecutionSummary, TestResult, TestOutcome } from '@qa-agent/shared';
import { env } from '../config/env.js';
import { createLogger } from '../util/logger.js';
import { uuid } from '../util/ids.js';
import { SPEC_SUFFIX, type SuiteLayout } from './scaffold.js';
import { withoutSecrets } from '../util/process.js';

const log = createLogger('playwright:runner');

export interface RunSuiteOptions {
  layout: SuiteLayout;
  runId: string;
  baseUrl: string;
  /** Spec paths relative to the suite root. Empty means "run everything". */
  specs: string[];
  credentials?: Record<string, string>;
  retries?: number;
  timeoutMs?: number;
  /** Stopping the run kills Playwright and the browsers it launched. */
  signal?: AbortSignal;
  /** Only run tests whose title matches (Playwright --grep); preflight passes the valid ones. */
  grep?: string;
  /** Verified signed-in session (auth/session.ts); every test starts with it. */
  storageState?: string | null;
  /** The affected routes need a signed-in user: tests must not fall back to signing in themselves. */
  authRequired?: boolean;
  startupTimeoutMs?: number;
}

export interface RunSuiteResult {
  results: TestResult[];
  summary: ExecutionSummary;
  /** Set when the suite could not be executed at all. */
  executionError: string | null;
  /** Where this run's videos, screenshots and traces were written. */
  outputDir: string;
  /** index.html of the Playwright HTML report, when one was written. */
  htmlReport: string | null;
  /** Whether the tests really signed in, as recorded by the suite's login helper. */
  authentication: AuthenticationOutcome;
  /** The exact command run, the tests Playwright discovered, and its exit code. */
  command?: string;
  discovered?: number | null;
  exitCode?: number | null;
}

export interface AuthenticationOutcome {
  /** real: signed in through the app's login; stubbed: the session API was faked; none: no test signed in. */
  mode: 'real' | 'stubbed' | 'none';
  attempts: number;
  succeeded: number;
  failed: number;
  roles: string[];
  /** Distinct reasons a sign-in failed (never containing the password). */
  failures: string[];
  /** Roles that had no account of their own and were tested as the ordinary user. */
  fallbacks: string[];
}

interface AuthRecord { mode: 'real' | 'stubbed'; role: string; ok: boolean; reason?: string; fallbackFrom?: string }

/** The scenario id is carried in the test title: "[SC-007] title". */
export function scenarioIdFromTitle(title: string): string | null {
  return title.match(/^\[([A-Z]{2}-\d+)\]/)?.[1] ?? null;
}

/* -------------------------------------------------------------------------- */
/* The subset of Playwright's JSON report this runner reads                    */
/* -------------------------------------------------------------------------- */
interface JsonAttachment { name: string; contentType: string; path?: string; body?: string }
interface JsonResult {
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
  duration: number;
  error?: { message?: string; stack?: string };
  errors?: { message?: string; stack?: string }[];
  attachments?: JsonAttachment[];
  annotations?: { type: string; description?: string }[];
}
interface JsonTest {
  annotations?: { type: string; description?: string }[];
  results: JsonResult[];
  status: 'skipped' | 'expected' | 'unexpected' | 'flaky';
}
interface JsonSpec { title: string; file: string; tests: JsonTest[] }
interface JsonSuite { title: string; file: string; specs?: JsonSpec[]; suites?: JsonSuite[] }
export interface PlaywrightJsonReport {
  config?: { rootDir?: string };
  suites?: JsonSuite[];
  errors?: { message?: string }[];
  stats?: { startTime?: string; duration?: number };
}

interface EvidenceBundle {
  console?: string[];
  network?: string[];
  dom?: string[];
  url?: string[];
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
const clean = (text: string | undefined | null): string | null => (text ? text.replace(ANSI, '') : null);
const plog = createLogger('PLAYWRIGHT');
const cleanupLog = createLogger('CLEANUP');

/**
 * Rebuilds a JSON-report-shaped object from the progress reporter's lines, for
 * a run that was killed before Playwright wrote its own report. Tests that had
 * not finished are left out rather than guessed at.
 */
export function reportFromProgress(file: string): PlaywrightJsonReport | null {
  interface EndLine {
    type: 'testEnd'; title: string; titlePath: string[]; file: string; retry: number; status: JsonResult['status'];
    outcome: JsonTest['status']; duration: number; error?: { message?: string; stack?: string };
    annotations?: { type: string; description?: string }[]; attachments?: JsonAttachment[];
  }
  const ends = readProgress(file).filter((l): l is ProgressLine & EndLine => l.type === 'testEnd');
  if (ends.length === 0) return null;
  const byTest = new Map<string, EndLine[]>();
  for (const e of ends) {
    const key = `${e.file}\u0000${e.titlePath.join('\u0000')}`;
    byTest.set(key, [...(byTest.get(key) ?? []), e]);
  }
  const files = new Map<string, JsonSuite>();
  for (const attempts of byTest.values()) {
    attempts.sort((a, b) => a.retry - b.retry);
    const last = attempts[attempts.length - 1]!;
    const suite = files.get(last.file) ?? { title: last.file, file: last.file, specs: [] };
    files.set(last.file, suite);
    suite.specs!.push({
      title: last.title, file: last.file,
      tests: [{
        annotations: last.annotations, status: last.outcome,
        results: attempts.map((a) => ({ status: a.status, duration: a.duration, error: a.error, attachments: a.attachments, annotations: a.annotations })),
      }],
    });
  }
  return { suites: [...files.values()] };
}

/** Playwright can name an attachment it failed to write; the report must never link to it. */
const onDisk = (file: string | undefined): file is string => Boolean(file && fs.existsSync(file));

function readAuth(attachments: JsonAttachment[]): AuthRecord[] {
  const out: AuthRecord[] = [];
  for (const a of attachments.filter((x) => x.name === 'qa-auth')) {
    try {
      const raw = a.body ? Buffer.from(a.body, 'base64').toString('utf8') : a.path ? fs.readFileSync(a.path, 'utf8') : '';
      if (raw) out.push(JSON.parse(raw) as AuthRecord);
    } catch { /* unreadable: not evidence either way */ }
  }
  return out;
}

/** Sign-in attempts across every attempt of every test in the report. */
export function summarizeAuthentication(report: PlaywrightJsonReport): AuthenticationOutcome {
  const records: AuthRecord[] = [];
  const walk = (suite: JsonSuite) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) for (const r of test.results) records.push(...readAuth(r.attachments ?? []));
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);
  const real = records.filter((r) => r.mode === 'real');
  const unique = (xs: string[]) => [...new Set(xs)];
  return {
    mode: real.length ? 'real' : records.length ? 'stubbed' : 'none',
    attempts: records.length,
    succeeded: records.filter((r) => r.ok).length,
    failed: records.filter((r) => !r.ok).length,
    roles: unique(records.map((r) => r.role)),
    failures: unique(records.filter((r) => !r.ok).map((r) => `${r.role}: ${r.reason ?? 'unknown'}`)).slice(0, 5),
    fallbacks: unique(records.filter((r) => r.fallbackFrom).map((r) => r.fallbackFrom!)),
  };
}

function emptySummary(startedAt: string): ExecutionSummary {
  return {
    total: 0, passed: 0, failed: 0, skipped: 0, pending: 0,
    durationMs: 0, specsRun: 0, startedAt, finishedAt: new Date().toISOString(),
  };
}

function readEvidence(attachments: JsonAttachment[]): EvidenceBundle {
  const attachment = attachments.find((a) => a.name === 'qa-evidence');
  if (!attachment) return {};
  try {
    const raw = attachment.body
      ? Buffer.from(attachment.body, 'base64').toString('utf8')
      : attachment.path ? fs.readFileSync(attachment.path, 'utf8') : '';
    return raw ? (JSON.parse(raw) as EvidenceBundle) : {};
  } catch (e) {
    log.debug(`Could not read qa evidence: ${(e as Error).message}`);
    return {};
  }
}

function outcomeOf(test: JsonTest, last: JsonResult | undefined): TestOutcome {
  if (!last) return 'skipped';
  if (last.status === 'passed') return 'passed';
  if (last.status === 'skipped') {
    // test.fixme() marks a scenario no template could implement - "pending",
    // which is different from a test that skipped itself at runtime.
    const annotations = [...(test.annotations ?? []), ...(last.annotations ?? [])];
    return annotations.some((a) => a.type === 'fixme') ? 'pending' : 'skipped';
  }
  return 'failed';
}

/**
 * Flattens a JSON report into TestResults. Exported for tests: the report
 * format is Playwright's, the mapping is ours.
 */
export function parseJsonReport(report: PlaywrightJsonReport, suiteRoot: string): TestResult[] {
  const rootDir = report.config?.rootDir ?? path.join(suiteRoot, 'tests');
  const results: TestResult[] = [];

  const walk = (suite: JsonSuite, titles: string[]) => {
    // The top-level suite is the file; its title is the file path, not a describe.
    const isFileSuite = titles.length === 0 && suite.file && suite.title === suite.file;
    const path_ = isFileSuite ? titles : [...titles, suite.title].filter(Boolean);

    for (const spec of suite.specs ?? []) {
      const specFile = path.relative(suiteRoot, path.resolve(rootDir, spec.file)).split(path.sep).join('/');
      for (const test of spec.tests) {
        const last = test.results[test.results.length - 1];
        const attachments = last?.attachments ?? [];
        const evidence = readEvidence(attachments);
        const error = last?.error ?? last?.errors?.[0];
        const fullTitle = [...path_, spec.title].join(' > ');

        results.push({
          id: uuid(),
          specFile,
          title: spec.title,
          fullTitle,
          scenarioId: scenarioIdFromTitle(spec.title),
          outcome: outcomeOf(test, last),
          durationMs: Math.round(last?.duration ?? 0),
          errorMessage: clean(error?.message),
          errorStack: clean(error?.stack),
          screenshotPaths: attachments.filter((a) => a.name === 'screenshot' && onDisk(a.path)).map((a) => a.path!),
          videoPath: attachments.find((a) => a.name === 'video' && onDisk(a.path))?.path ?? null,
          tracePath: attachments.find((a) => a.name === 'trace' && onDisk(a.path))?.path ?? null,
          consoleLogs: evidence.console ?? [],
          networkLogs: evidence.network ?? [],
          domSnapshot: evidence.dom?.[evidence.dom.length - 1] ?? null,
          attempts: Math.max(1, test.results.length),
          // Failed, then passed on retry: not a pass to trust, and not a defect either.
          flaky: test.status === 'flaky',
          pageUrl: evidence.url?.[0] ?? null,
          skipReason: last?.status === 'skipped'
            ? [...(test.annotations ?? []), ...(last.annotations ?? [])].find((a) => a.type === 'skip' || a.type === 'fixme')?.description ?? null
            : null,
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, path_);
  };

  for (const suite of report.suites ?? []) walk(suite, []);
  return results;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Absolute path of the Playwright CLI this backend depends on, or null. */
function playwrightCli(): string | null {
  try {
    const require = createRequire(import.meta.url);
    return path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js');
  } catch {
    return null;
  }
}

export async function runSuite(opts: RunSuiteOptions): Promise<RunSuiteResult> {
  const startedAt = new Date().toISOString();
  const { layout } = opts;
  const outputDir = path.join(layout.runsDir, opts.runId);
  const reportFile = path.join(outputDir, 'results.json');
  // Playwright empties its outputDir and refuses an HTML report inside it, so
  // the test output and the report are siblings under the run's directory.
  const testOutputDir = path.join(outputDir, 'test-results');
  const htmlReportDir = path.join(outputDir, 'report');
  const noAuth: AuthenticationOutcome = { mode: 'none', attempts: 0, succeeded: 0, failed: 0, roles: [], failures: [], fallbacks: [] };
  const fail = (executionError: string): RunSuiteResult =>
    ({ results: [], summary: emptySummary(startedAt), executionError, outputDir, htmlReport: null, authentication: noAuth });

  const hasSpecs = fs.existsSync(layout.testsDir)
    && fs.readdirSync(layout.testsDir).some((f) => f.endsWith(SPEC_SUFFIX));
  if (!hasSpecs) return fail('No spec files exist in the generated suite. Generate tests before running them.');

  const cli = playwrightCli();
  if (!cli) return fail('Playwright is not installed. Run "npm install" and then "npx playwright install chromium".');

  fs.mkdirSync(outputDir, { recursive: true });

  // Credentials reach the suite as QA_CRED_* variables of the child process
  // only; they are never written into a generated file.
  const credentials: Record<string, string> = {
    userEmail: env.TEST_USER_EMAIL ?? '',
    userPassword: env.TEST_USER_PASSWORD ?? '',
    adminEmail: env.TEST_ADMIN_EMAIL ?? '',
    adminPassword: env.TEST_ADMIN_PASSWORD ?? '',
    loginPath: env.TEST_LOGIN_PATH ?? '',
    ...(opts.credentials ?? {}),
  };

  const childEnv: NodeJS.ProcessEnv = {
    ...scrubbedParentEnv(),
    FORCE_COLOR: '0',
    QA_BASE_URL: opts.baseUrl,
    QA_OUTPUT_DIR: testOutputDir,
    QA_REPORT_FILE: reportFile,
    QA_HTML_REPORT_DIR: htmlReportDir,
    QA_BROWSER: env.PLAYWRIGHT_BROWSER,
    QA_WORKERS: String(env.PLAYWRIGHT_WORKERS),
    QA_HEADED: env.PLAYWRIGHT_HEADED ? '1' : '0',
    QA_VIDEO: env.PLAYWRIGHT_VIDEO,
    QA_SCREENSHOT: env.PLAYWRIGHT_SCREENSHOT,
    QA_TRACE: env.PLAYWRIGHT_TRACE,
    QA_RETRIES: String(opts.retries ?? 0),
    QA_COMMAND_TIMEOUT: '8000',
    QA_MOCK_API: env.TEST_MOCK_API ? '1' : '0',
    ...(opts.storageState ? { QA_STORAGE_STATE: opts.storageState } : {}),
    ...(opts.authRequired ? { QA_AUTH_REQUIRED: '1' } : {}),
    ...Object.fromEntries(Object.entries(credentials).map(([k, v]) => [`QA_CRED_${k}`, v])),
  };

  const args = [cli, 'test', '--config', path.join(layout.root, 'playwright.config.ts')];
  // CLI filters are regular expressions matched against the file path.
  for (const spec of opts.specs) args.push(escapeRegExp(spec));
  if (opts.grep) args.push('--grep', opts.grep);

  const command = ['playwright', ...args.slice(1)].join(' ');
  const progressFile = path.join(outputDir, 'progress.jsonl');
  fs.rmSync(progressFile, { force: true });
  childEnv['QA_PROGRESS_FILE'] = progressFile;
  plog.info(`Running against ${opts.baseUrl}: ${opts.specs.length ? `${opts.specs.length} spec(s)` : 'all specs'}${opts.storageState ? ', signed in with the verified session' : ''}.`);
  plog.info(`Command: ${command}`);

  let exit: { code: number | null; stderr: string } | null = null;
  let runError: string | null = null;
  try {
    exit = await runPlaywrightProcess(process.execPath, args, layout.root, childEnv, opts.timeoutMs ?? env.PLAYWRIGHT_TIMEOUT_MS, opts.signal, {
      progressFile, startupTimeoutMs: opts.startupTimeoutMs ?? env.PLAYWRIGHT_STARTUP_TIMEOUT_MS,
    });
  } catch (e) {
    runError = (e as Error).message;
    plog.error(runError);
  }

  const progress = readProgress(progressFile);
  const discovered = progress.find((l) => l.type === 'begin')?.total ?? null;
  if (discovered !== null) plog.info(`${discovered} test(s) discovered.`);

  let report: PlaywrightJsonReport | null = null;
  if (!runError) {
    try { report = JSON.parse(fs.readFileSync(reportFile, 'utf8')) as PlaywrightJsonReport; } catch { /* fall through */ }
  }
  // Killed before it could write its report: what finished is still evidence.
  if (!report) report = reportFromProgress(progressFile);
  const meta = { command, discovered, exitCode: exit?.code ?? null };
  if (!report) {
    // No report means Playwright could not start (bad config, missing
    // browser) - an environment problem, distinct from tests failing.
    return { ...fail(runError ?? `Playwright produced no report (exit code ${exit?.code}). ${exit?.stderr.slice(-800) ?? ''}`.trim()), ...meta };
  }
  if (discovered === 0) {
    return { ...fail('0 tests were discovered in the selected spec(s): nothing could be executed.'), ...meta };
  }

  const results = parseJsonReport(report, layout.root);
  const count = (o: TestOutcome) => results.filter((r) => r.outcome === o).length;
  const topLevelError = (report.errors ?? []).map((e) => clean(e.message)).filter(Boolean)[0] ?? null;

  const summary: ExecutionSummary = {
    total: results.length,
    passed: count('passed'),
    failed: count('failed'),
    skipped: count('skipped'),
    pending: count('pending'),
    durationMs: Math.round(report.stats?.duration ?? 0),
    specsRun: new Set(results.map((r) => r.specFile)).size,
    startedAt,
    finishedAt: new Date().toISOString(),
  };

  plog.info(`${results.filter((r) => r.outcome === 'passed' || r.outcome === 'failed').length} test(s) executed${runError ? ' before the run was cut short' : ''}.`);
  log.info(`Execution complete: ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped, ${summary.pending} pending across ${summary.specsRun} spec(s).`);
  const htmlIndex = path.join(htmlReportDir, 'index.html');
  return {
    results, summary, outputDir,
    htmlReport: fs.existsSync(htmlIndex) ? htmlIndex : null,
    authentication: summarizeAuthentication(report),
    // Errors outside any test (a spec that does not compile) are reported, not hidden.
    executionError: runError ?? (results.length === 0 && topLevelError ? topLevelError : null),
    ...meta,
  };
}

/** The suite must not inherit this backend's own secrets. */
function scrubbedParentEnv(): NodeJS.ProcessEnv {
  return withoutSecrets(process.env);
}

export interface ProcessWatch {
  /** JSON-lines file the suite's progress reporter appends to. */
  progressFile?: string;
  /** No test may take longer than this to begin (browser launch, config, compilation). */
  startupTimeoutMs?: number;
}

export class PlaywrightTimeoutError extends Error {
  constructor(message: string, readonly phase: 'startup' | 'execution') {
    super(message);
    this.name = 'PlaywrightTimeoutError';
  }
}

interface ProgressLine { type: string; title?: string; titlePath?: string[]; file?: string; total?: number; retry?: number }

export function readProgress(file: string | undefined): ProgressLine[] {
  if (!file || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as ProgressLine]; } catch { return []; }
  });
}

/**
 * Runs the Playwright CLI and watches it. Two deadlines, each with its own
 * message: nothing started within startupTimeoutMs (the browser, the config or
 * the TypeScript compilation hung), and the whole run exceeding timeoutMs -
 * which names how far it got and which test was running. On either, or on a
 * stop, the whole process group (workers, browsers, ffmpeg) is terminated:
 * SIGTERM first so Playwright can close its browsers, then SIGKILL.
 */
export function runPlaywrightProcess(
  command: string, args: string[], cwd: string, childEnv: NodeJS.ProcessEnv, timeoutMs: number,
  signal?: AbortSignal, watch: ProcessWatch = {},
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    // Its own process group: Playwright's workers and the browsers they launch
    // are separate processes, and killing only the CLI would orphan them.
    const child = spawn(command, args, {
      cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const started = Date.now();
    let stderr = '';
    let settled = false;
    child.stdout.on('data', (d: Buffer) => log.debug(d.toString().trim()));
    child.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-4000); });

    const killTree = (sig: NodeJS.Signals) => {
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
        else process.kill(-child.pid, sig);
      } catch { /* already gone */ }
    };
    const terminate = (reason: string) => {
      killTree('SIGTERM');
      setTimeout(() => {
        killTree('SIGKILL');
        cleanupLog.info(`Playwright process group ${child.pid} terminated (${reason}).`);
      }, 5000).unref();
    };
    const stopWith = (error: Error, reason: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      signal?.removeEventListener('abort', onAbort);
      terminate(reason);
      reject(error);
    };

    const progressSummary = () => {
      const lines = readProgress(watch.progressFile);
      const total = lines.find((l) => l.type === 'begin')?.total;
      const ended = lines.filter((l) => l.type === 'testEnd' && (l.retry ?? 0) === 0).length;
      const begun = lines.filter((l) => l.type === 'testBegin');
      const current = begun.length ? begun[begun.length - 1] : null;
      return { lines, total, ended, current };
    };

    const timer = setTimeout(() => {
      const p = progressSummary();
      const where = p.total === undefined
        ? 'no test had started'
        : `${p.ended} of ${p.total} test(s) finished${p.current?.title ? `; still running "${p.current.title}"` : ''}`;
      stopWith(new PlaywrightTimeoutError(`Playwright execution timeout after ${Math.round(timeoutMs / 1000)}s: ${where}.`, 'execution'), 'execution timeout');
    }, timeoutMs);

    // Startup watchdog: the progress reporter writes "begin" once discovery is done.
    const poll = setInterval(() => {
      if (!watch.progressFile || !watch.startupTimeoutMs) return;
      if (Date.now() - started < watch.startupTimeoutMs) return;
      if (progressSummary().lines.some((l) => l.type === 'begin')) { clearInterval(poll); return; }
      stopWith(new PlaywrightTimeoutError(
        `Playwright startup timeout: no test began within ${Math.round(watch.startupTimeoutMs / 1000)}s (browser launch, configuration or test compilation hung).`
        + (stderr ? ` Last output: ${stderr.slice(-300).trim()}` : ''), 'startup'), 'startup timeout');
    }, 1000);

    const onAbort = () => stopWith(new Error('Playwright was stopped.'), 'stopped');
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    child.on('error', (e) => finish(() => reject(e)));
    // Playwright exits 1 when tests fail, which is not a runner error; whether
    // the run really happened is decided by the presence of the report.
    child.on('close', (code) => finish(() => {
      // Workers or browsers left behind by a crashed CLI go with it.
      killTree('SIGKILL');
      resolve({ code, stderr });
    }));
  });
}

/** True when the Playwright test runner can be launched. */
export async function playwrightRunnerAvailable(): Promise<boolean> {
  const cli = playwrightCli();
  return Boolean(cli && fs.existsSync(cli));
}
