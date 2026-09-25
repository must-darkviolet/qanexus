/**
 * The review's own behaviour in the situations that broke it before: a
 * protected module behind a login, credentials that are missing or wrong, a
 * session that signs in but cannot open the page, Playwright hanging, nothing
 * executing, and a PR that should only test the modules it touches.
 *
 * The authentication cases drive a real Chromium against a small local app
 * with a login form, a cookie session and a protected route that redirects
 * signed-out visitors client-side, the way single-page apps do.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test, describe, before, after } from 'node:test';
import type { AddressInfo } from 'node:net';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-agent-scenarios-'));
process.env.DATABASE_URL = 'sqlite::memory:';
process.env.WORKSPACE_ROOT = path.join(tmp, 'workspaces');
process.env.ARTIFACT_ROOT = path.join(tmp, 'artifacts');

const { establishAuthentication } = await import('../src/auth/session.js');
const { runPlaywrightProcess, PlaywrightTimeoutError, reportFromProgress, parseJsonReport } = await import('../src/playwright/runner.js');
const { reviewVerdict, renderPrComment } = await import('../src/pipeline/prComment.js');
const { selectTieredSpecs } = await import('../src/pipeline/testSelection.js');
type RunDetails = import('../src/pipeline/orchestrator.js').RunDetails;
type AuthCheck = import('../src/auth/session.js').AuthCheck;

/* -------------------------------------------------------------------------- */
/* A protected application                                                     */
/* -------------------------------------------------------------------------- */

const ACCOUNT = { email: 'qa@example.test', password: 'correct-horse' };
let mode: 'normal' | 'deny' = 'normal';

const page = (body: string) => `<!doctype html><html><head><title>Admin</title></head><body>${body}</body></html>`;
const LOGIN = page(`
  <h2>Sign in to your account</h2>
  <form id="f">
    <label>Email address <input type="text" id="input_login_email"></label>
    <label>Password <input type="password" id="input_login_password"></label>
    <button type="submit">Sign In</button>
  </form>
  <div id="msg"></div>
  <script>
    document.getElementById('f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const res = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: input_login_email.value, password: input_login_password.value }) });
      if (res.ok) {
        // Like the real app: a success toast in an alert region, then the redirect.
        document.getElementById('msg').innerHTML = '<div role="alert">Login successful</div>';
        setTimeout(() => { location.href = '/dashboard'; }, 800);
      }
      else document.getElementById('msg').innerHTML = '<div role="alert">Invalid email or password</div>';
    });
  </script>`);
// Signed-out visitors are sent to the login after the page has loaded, as a SPA does.
const REDIRECT = page(`<p>Loading…</p><script>setTimeout(() => location.replace('/login?returnUrl=' + encodeURIComponent(location.pathname)), 300)</script>`);

const requested: string[] = [];
const server = http.createServer((req, res) => {
  requested.push(req.url ?? '');
  const signedIn = /(^|;\s*)session=ok/.test(req.headers.cookie ?? '');
  const url = new URL(req.url ?? '/', 'http://x');
  const html = (body: string) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(body); };
  if (url.pathname === '/api/login' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as { email?: string; password?: string };
      if (body.email === ACCOUNT.email && body.password === ACCOUNT.password) {
        res.writeHead(200, { 'set-cookie': 'session=ok; Path=/; HttpOnly' });
        res.end('{}');
      } else {
        res.writeHead(401);
        res.end('{}');
      }
    });
    return;
  }
  if (url.pathname === '/login') return html(LOGIN);
  if (url.pathname === '/public') return html(page('<h1>Public page</h1>'));
  if (url.pathname === '/with-welcome') {
    // Like MUI: while the modal is open the rest of the page is aria-hidden.
    const close = "document.getElementById('tour').remove(); document.getElementById('app').removeAttribute('aria-hidden')";
    return html(page(`<div id="app" aria-hidden="true"><h1>Education</h1><button>Reset Education</button></div>
      <div role="dialog" aria-modal="true" id="tour"><h2>Welcome to MSQ Dashboard!</h2><button onclick="${close}">Let's get started</button>
      <button aria-label="close" onclick="${close}">×</button></div>
      <div role="dialog" id="history" style="margin-top:300px"><h2>Education History</h2></div>`));
  }
  if (url.pathname === '/dashboard') return html(signedIn ? page('<h1>Dashboard</h1>') : REDIRECT);
  if (url.pathname === '/education-management') {
    return html(signedIn && mode === 'normal' ? page('<h1>Education Management</h1>') : REDIRECT);
  }
  res.writeHead(404);
  res.end();
});

let baseUrl = '';
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const auth = (credentials: { email?: string; password?: string }, name: string) => establishAuthentication({
  baseUrl, routes: ['/education-management'], credentials,
  statePath: path.join(tmp, `${name}.json`), evidenceDir: path.join(tmp, name),
  timeouts: { navigationMs: 10_000, loginMs: 5_000 },
});

/* -------------------------------------------------------------------------- */
/* Report fixtures                                                             */
/* -------------------------------------------------------------------------- */

const pr = { number: 2577, title: 'Fix super save refresh', body: '', url: null, headRef: 'fix', baseRef: 'main' };
const run = { id: 'run00001', status: 'completed', error: null } as never;
const linker = { link: () => null, where: 'Stored locally.', exists: () => true };

const result = (title: string, outcome: 'passed' | 'failed' | 'skipped', spec = 'tests/education-management.spec.ts') => ({
  id: title, specFile: spec, title, fullTitle: title, scenarioId: null, outcome, durationMs: 100,
  errorMessage: outcome === 'failed' ? 'expect(locator).toBeVisible() failed' : null, errorStack: null,
  screenshotPaths: [], videoPath: null, tracePath: null, consoleLogs: [], networkLogs: [], domSnapshot: null, attempts: 1,
});

const verifiedAuth: AuthCheck = {
  state: 'VERIFIED', protectedRoutes: ['/education-management'], publicRoutes: [], loginPath: '/login', loginAttempted: true,
  source: 'login-form', role: 'user', reason: 'Signed in as user and /education-management opened.', storageStatePath: '/s.json',
  evidence: { screenshot: null, url: null }, durationMs: 900,
};

function details(overrides: Partial<RunDetails> = {}): RunDetails {
  const results = (overrides.results ?? []) as RunDetails['results'];
  const count = (o: string) => results.filter((r) => r.outcome === o).length;
  return {
    commitSha: 'b3d94d98e13eb050', previousCommitSha: 'f1f49fe59cde4716',
    changedFiles: [
      { path: 'src/sections/super-save/education-management/components/EducationHistoryDialog/EducationHistoryDialog.tsx', status: 'modified', additions: 5, deletions: 7 },
      { path: 'src/sections/super-save/education-management/educationManagementPage.tsx', status: 'modified', additions: 4, deletions: 2 },
    ],
    impact: {
      summary: 'Refresh is now conditional on the selected user.', fullRegressionAdvised: false, fullRegressionReason: null,
      affectedFeatures: [
        { key: 'education-management', name: 'Education Management', risk: 'high', changedFiles: ['src/sections/super-save/education-management/educationManagementPage.tsx'], reasons: ['Owns the changed page.'], relatedTests: [], scenarioCount: 4, rulesAffected: 1 },
        { key: 'basicinformationtab', name: 'Basicinformationtab', risk: 'medium', changedFiles: [], reasons: ['Renders EducationHistoryDialog.'], relatedTests: [], scenarioCount: 2, rulesAffected: 0 },
      ],
      traces: [], recommendations: [], historicalFindings: [], coverage: { gaps: [] }, ai: { source: 'fallback' },
    } as never,
    changeAnalysis: null, testChanges: [], rejectedTests: [], selectedSpecs: ['tests/education-management.spec.ts'],
    changeAreas: { ui: 2, routes: 0, apis: 0, validations: 2, businessLogic: 1, auth: 0, tests: 0 },
    scenarios: {},
    execution: { total: results.length, passed: count('passed'), failed: count('failed'), skipped: count('skipped'), pending: 0, durationMs: 1000, specsRun: 1, startedAt: '', finishedAt: '' },
    executionError: null, htmlReport: null, authentication: null, mockApi: false, repoTests: null,
    authCheck: verifiedAuth,
    executionMeta: { command: 'playwright test tests/education-management\\.spec\\.ts', discovered: results.length, exitCode: 0 },
    selection: [
      { specFile: 'tests/education-management.spec.ts', tier: 1, reasons: ['Education Management owns the changed file(s).'], feature: 'education-management' },
      { specFile: 'tests/basicinformationtab.spec.ts', tier: 2, reasons: ['Basicinformationtab is reached indirectly.'], feature: 'basicinformationtab' },
    ],
    moduleRoutes: { 'education-management': ['/education-management'], basicinformationtab: [] },
    specFeatures: { 'tests/education-management.spec.ts': 'education-management', 'tests/basicinformationtab.spec.ts': 'basicinformationtab' },
    preflight: [], repairs: [], behaviorMap: [], changedBehaviors: [],
    failures: [], exploration: { enabled: false, reason: 'n/a', pages: [], discrepancies: [] }, coverage: null,
    ...overrides,
    results,
  } as RunDetails;
}

const render = (d: RunDetails) => renderPrComment({ pr, run, details: d, baseUrl, artifacts: linker });

/* -------------------------------------------------------------------------- */
/* Cases 1-4: authentication                                                   */
/* -------------------------------------------------------------------------- */

describe('authentication as a hard prerequisite', () => {
  test('case 1: login succeeds, is verified, and the protected route opens with the saved session', async () => {
    mode = 'normal';
    const check = await auth(ACCOUNT, 'ok');
    assert.equal(check.state, 'VERIFIED', check.reason);
    assert.deepEqual(check.protectedRoutes, ['/education-management']);
    assert.equal(check.loginPath, '/login');
    assert.ok(check.storageStatePath && fs.existsSync(check.storageStatePath));

    // The saved session is what the walkthrough and the tests start with.
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ storageState: check.storageStatePath! });
      const p = await context.newPage();
      await p.goto(`${baseUrl}/education-management`);
      await p.waitForTimeout(800);
      assert.equal(new URL(p.url()).pathname, '/education-management');
      assert.equal(await p.locator('h1').textContent(), 'Education Management');
    } finally {
      await browser.close();
    }

    // A second check reuses the session instead of signing in again.
    const again = await establishAuthentication({
      baseUrl, routes: ['/education-management'], credentials: {},
      statePath: check.storageStatePath!, evidenceDir: path.join(tmp, 'ok2'), timeouts: { navigationMs: 10_000, loginMs: 5_000 },
    });
    assert.equal(again.state, 'VERIFIED');
    assert.equal(again.source, 'saved-session');
  });

  test('case 2: missing credentials are AUTHENTICATION_REQUIRED, and the review is BLOCKED with 0 executed', async () => {
    const check = await auth({}, 'missing');
    assert.equal(check.state, 'AUTHENTICATION_REQUIRED');
    assert.equal(check.loginAttempted, false);

    const d = details({ authCheck: check, execution: null, executionError: `Blocked before execution (${check.state}): ${check.reason}` });
    assert.equal(reviewVerdict(run, d), 'blocked');
    const body = render(d);
    assert.match(body, /\*\*Status:\*\* ⚠️ BLOCKED/);
    assert.match(body, /### Blocker\n> ⛔ AUTHENTICATION_REQUIRED/);
    assert.match(body, /- \*\*Executed: 0\*\*/);
    assert.match(body, /\| Education Management \| 🔴 high \| 1 \| 1 \| — \| 0 \| — \| ⚠️ BLOCKED \| ❌ REQUIRED/);
  });

  test('case 3: wrong credentials are AUTHENTICATION_FAILED with what the page said', async () => {
    const check = await auth({ email: ACCOUNT.email, password: 'wrong-password' }, 'invalid');
    assert.equal(check.state, 'AUTHENTICATION_FAILED');
    assert.ok(check.loginAttempted);
    assert.match(check.reason, /Invalid email or password/);
    assert.doesNotMatch(check.reason, /wrong-password/);
    assert.ok(check.evidence.screenshot && fs.existsSync(check.evidence.screenshot));
    assert.equal(reviewVerdict(run, details({ authCheck: check, execution: null, executionError: 'Blocked before execution' })), 'blocked');
  });

  test('case 4: signed in but still redirected to the login is AUTHENTICATED_ACCESS_FAILED', async () => {
    mode = 'deny';
    try {
      const check = await auth(ACCOUNT, 'deny');
      assert.equal(check.state, 'AUTHENTICATED_ACCESS_FAILED', check.reason);
      assert.match(check.reason, /still redirected to \/login/);
      const body = render(details({ authCheck: check, execution: null, executionError: 'Blocked before execution' }));
      assert.match(body, /❌ \*\*AUTHENTICATED_ACCESS_FAILED\*\*/);
      assert.match(body, /Protected tests were \*\*not run\*\*/);
    } finally {
      mode = 'normal';
    }
  });

  test('a configured login URL (e.g. a CAPTCHA bypass token) is used, and its token is never reported', async () => {
    const check = await establishAuthentication({
      baseUrl, routes: ['/education-management'], credentials: ACCOUNT, loginPath: '/login?token=BYPASS-SECRET-1',
      statePath: path.join(tmp, 'bypass.json'), evidenceDir: path.join(tmp, 'bypass'), timeouts: { navigationMs: 10_000, loginMs: 5_000 },
    });
    assert.equal(check.state, 'VERIFIED', check.reason);
    assert.equal(check.loginPath, '/login');
    assert.doesNotMatch(JSON.stringify(check), /BYPASS-SECRET-1/);
    assert.ok(requested.some((u) => u === '/login?token=BYPASS-SECRET-1'), 'the bypass URL was the one opened');
  });

  test('the login page itself is public, not a protected module', async () => {
    const check = await establishAuthentication({
      baseUrl, routes: ['/login', '/public'], credentials: {}, statePath: path.join(tmp, 'login.json'),
      evidenceDir: path.join(tmp, 'login'), timeouts: { navigationMs: 10_000, loginMs: 5_000 },
    });
    assert.equal(check.state, 'NOT_REQUIRED');
    assert.deepEqual(check.publicRoutes, ['/login', '/public']);
  });

  test('a first-run welcome dialog is dismissed; any other dialog is left alone', async () => {
    const { dismissOnboarding } = await import('../src/auth/session.js');
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    try {
      const p = await (await browser.newContext()).newPage();
      await p.goto(`${baseUrl}/with-welcome`);
      assert.equal(await p.getByRole('button', { name: 'Reset Education' }).count(), 0, 'hidden behind the modal');
      assert.match((await dismissOnboarding(p)) ?? '', /Welcome to MSQ Dashboard/);
      assert.equal(await p.getByRole('button', { name: 'Reset Education' }).count(), 1);
      assert.equal(await p.locator('#history').isVisible(), true, 'the dialog under test stays');
      assert.equal(await dismissOnboarding(p), null);
    } finally {
      await browser.close();
    }
  });

  test('a public route needs no sign-in', async () => {
    const check = await establishAuthentication({
      baseUrl, routes: ['/public'], credentials: {}, statePath: path.join(tmp, 'public.json'),
      evidenceDir: path.join(tmp, 'public'), timeouts: { navigationMs: 10_000, loginMs: 5_000 },
    });
    assert.equal(check.state, 'NOT_REQUIRED');
  });
});

/* -------------------------------------------------------------------------- */
/* Case 5: Playwright hangs                                                    */
/* -------------------------------------------------------------------------- */

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitUntil = async (fn: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 100)); }
  return fn();
};

describe('Playwright process lifecycle', { skip: process.platform === 'win32' }, () => {
  test('case 5: a startup that never begins a test is a named startup timeout, and the process group is killed', async () => {
    const pidFile = path.join(tmp, 'grandchild.pid');
    // A "Playwright" that starts a worker and then hangs before any test begins.
    const script = `const { spawn } = require('child_process');
      const w = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(w.pid));
      setInterval(() => {}, 1000);`;
    const started = Date.now();
    await assert.rejects(
      runPlaywrightProcess(process.execPath, ['-e', script], tmp, process.env, 60_000, undefined,
        { progressFile: path.join(tmp, 'never.jsonl'), startupTimeoutMs: 1500 }),
      (e: Error) => e instanceof PlaywrightTimeoutError && e.phase === 'startup' && /Playwright startup timeout: no test began within 2s/.test(e.message),
    );
    assert.ok(Date.now() - started < 10_000, 'fails fast instead of waiting for the overall timeout');
    const worker = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(await waitUntil(() => !alive(worker), 8000), 'the worker process was cleaned up');
  });

  test('an execution timeout says how far the run got and which test was running', async () => {
    const progress = path.join(tmp, 'progress.jsonl');
    const script = `const fs = require('fs');
      fs.appendFileSync(${JSON.stringify(progress)}, JSON.stringify({ type: 'begin', total: 2 }) + '\\n');
      fs.appendFileSync(${JSON.stringify(progress)}, JSON.stringify({ type: 'testBegin', title: 'opens Education Management', titlePath: [], file: 'x', retry: 0 }) + '\\n');
      setInterval(() => {}, 1000);`;
    await assert.rejects(
      runPlaywrightProcess(process.execPath, ['-e', script], tmp, process.env, 2500, undefined, { progressFile: progress, startupTimeoutMs: 60_000 }),
      /Playwright execution timeout after 3s: 0 of 2 test\(s\) finished; still running "opens Education Management"/,
    );
  });

  test('results of a run cut short are recovered from the progress file', () => {
    const progress = path.join(tmp, 'partial.jsonl');
    const line = (title: string, status: string, outcome: string) => JSON.stringify({
      type: 'testEnd', title, titlePath: ['Education Management', title], file: '/suite/tests/education-management.spec.ts',
      retry: 0, status, outcome, duration: 1200, attachments: [],
    });
    fs.writeFileSync(progress, [JSON.stringify({ type: 'begin', total: 3 }), line('lists students', 'passed', 'expected'), line('refreshes', 'failed', 'unexpected')].join('\n') + '\n');
    const report = reportFromProgress(progress);
    assert.ok(report);
    const results = parseJsonReport(report, '/suite');
    assert.deepEqual(results.map((r) => [r.title, r.outcome, r.specFile]), [
      ['lists students', 'passed', 'tests/education-management.spec.ts'],
      ['refreshes', 'failed', 'tests/education-management.spec.ts'],
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Cases 6-8: the verdict never calls unexecuted work a pass                   */
/* -------------------------------------------------------------------------- */

describe('execution states', () => {
  test('case 6: 0 tests discovered is BLOCKED, never PASSED, and claims no findings', () => {
    const d = details({ execution: null, executionError: '0 tests were discovered in the selected spec(s): nothing could be executed.', executionMeta: { command: 'playwright test', discovered: 0, exitCode: 0 } });
    assert.equal(reviewVerdict(run, d), 'blocked');
    const body = render(d);
    assert.doesNotMatch(body, /PASSED|every executed test passed|No findings:/);
    assert.match(body, /No product findings can be concluded/);
  });

  test('a timeout before any test finished is BLOCKED with the timeout as the blocker', () => {
    const d = details({ execution: null, executionError: 'Playwright execution timeout after 600s: 0 of 57 test(s) finished; still running "Navigate to admin".' });
    assert.equal(reviewVerdict(run, d), 'blocked');
    assert.match(render(d), /### Blocker\n> ⛔ Playwright execution timeout after 600s/);
  });

  test('case 7: the required tests executing and passing is PASSED', () => {
    const d = details({ results: [result('lists students', 'passed'), result('refresh is conditional', 'passed')] as never });
    assert.equal(reviewVerdict(run, d), 'passed');
    const body = render(d);
    assert.match(body, /\*\*Status:\*\* ✅ PASSED/);
    assert.match(body, /\| Education Management \| 🔴 high \| 1 \| 1 \| — \| 2 \| ✅ \| ✅ PASS \| ✅ VERIFIED/);
    assert.match(body, /\| Basicinformationtab \| 🟠 medium \| 2 \| 1 \| — \| 0 \| — \| ⚪ UNVERIFIED/);
  });

  test('case 8: some passing and some failing is FAILED when the failure is diagnosed as an application defect', () => {
    const failures = [{ id: 'f1', testResultId: 'refresh is conditional', testTitle: 'refresh is conditional', specFile: 'tests/education-management.spec.ts',
      classification: 'APPLICATION_BUG', confidence: 0.9, rootCause: 'Refetch fires without user_id.', recommendedAction: null, affectedArea: null }];
    const d = details({ results: [result('lists students', 'passed'), result('refresh is conditional', 'failed')] as never, failures: failures as never });
    assert.equal(reviewVerdict(run, d), 'failed');
    assert.match(render(d), /\*\*Status:\*\* ❌ FAILED — 1 of 2 executed tests failed/);
  });

  test('an unexplained failure is not a verdict: PARTIAL, with the defect only suspected', () => {
    const d = details({ results: [result('lists students', 'passed'), result('refresh is conditional', 'failed')] as never });
    assert.equal(reviewVerdict(run, d), 'partial');
    assert.match(render(d), /\| UNVERIFIED \| DEFECT SUSPECTED \|/);
  });

  test('some tests executed before the run was cut short is PARTIAL, not PASSED', () => {
    const d = details({ results: [result('lists students', 'passed')] as never, executionError: 'Playwright execution timeout after 600s: 1 of 5 test(s) finished.' });
    assert.equal(reviewVerdict(run, d), 'partial');
    const body = render(d);
    assert.match(body, /\*\*Status:\*\* 🟡 PARTIAL/);
    assert.match(body, /this is not a pass/);
  });
});

/* -------------------------------------------------------------------------- */
/* Case 9: impact-aware selection                                              */
/* -------------------------------------------------------------------------- */

describe('targeted regression selection', () => {
  const available = [
    'tests/admin.spec.ts', 'tests/ads-management.spec.ts', 'tests/basicinformationtab.spec.ts',
    'tests/education-management.spec.ts', 'tests/kwt-management.spec.ts', 'tests/news.spec.ts', 'tests/platform-admin.spec.ts',
  ];
  const changed = [
    'src/sections/super-save/education-management/components/EducationHistoryDialog/EducationHistoryDialog.tsx',
    'src/sections/super-save/education-management/educationManagementPage.tsx',
  ];
  const affected = [
    { key: 'education-management', name: 'Education Management', files: changed },
    { key: 'basicinformationtab', name: 'Basicinformationtab', files: ['src/sections/users/BasicInformationTab.tsx'] },
  ];

  test('case 9: a change to Education Management selects it (tier 1) and Basicinformationtab (tier 2), nothing else', () => {
    const sel = selectTieredSpecs({ availableSpecs: available, changedFiles: changed, affectedFeatures: affected, traced: [], related: [], broadReason: null });
    assert.deepEqual(sel.specs.map((s) => [s.specFile, s.tier]), [
      ['tests/education-management.spec.ts', 1],
      ['tests/basicinformationtab.spec.ts', 2],
    ]);
    assert.equal(sel.depth, 2);
  });

  test('specs that have never passed are not pulled in by that alone', () => {
    // The old rule selected every never-passed spec; with a login in the way, that was all of them.
    const sel = selectTieredSpecs({ availableSpecs: available, changedFiles: changed, affectedFeatures: affected.slice(0, 1), traced: [], related: [], broadReason: null });
    assert.deepEqual(sel.specs.map((s) => s.specFile), ['tests/education-management.spec.ts']);
  });

  test('tier 3 runs only for a cross-cutting change', () => {
    const sel = selectTieredSpecs({ availableSpecs: available, changedFiles: ['package.json'], affectedFeatures: [], traced: [], related: [], broadReason: 'the change touches shared infrastructure' });
    assert.equal(sel.specs.length, available.length);
    assert.ok(sel.specs.every((s) => s.tier === 3));
  });

  test('the registry decides which module a spec belongs to when its name does not say', () => {
    const sel = selectTieredSpecs({
      availableSpecs: ['tests/super-save.spec.ts', 'tests/news.spec.ts'], changedFiles: changed, affectedFeatures: affected.slice(0, 1),
      traced: [], related: [], broadReason: null,
      featureOf: (s) => (s === 'tests/super-save.spec.ts' ? 'education-management' : 'news'),
    });
    assert.deepEqual(sel.specs.map((s) => s.specFile), ['tests/super-save.spec.ts']);
  });
});

describe('secrets in the report', () => {
  test("a login URL's bypass token is masked wherever it appears", async () => {
    const { redactSecrets } = await import('../src/util/redact.js');
    const text = 'AUTHENTICATION_FAILED: could not sign in as user at /login?token=MS-TEST.123: timeout';
    assert.equal(redactSecrets(text, ['token=MS-TEST.123', 'MS-TEST.123']), 'AUTHENTICATION_FAILED: could not sign in as user at /login?[redacted]: timeout');
  });
});
