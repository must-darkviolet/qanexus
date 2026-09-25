/**
 * Pull-request review: reading Playwright's report, deciding a verdict,
 * rendering the comment, and accepting only genuine webhook deliveries.
 *
 * No test talks to GitHub, starts a browser, or runs a pipeline.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, describe, afterEach } from 'node:test';

process.env.DATABASE_URL = 'sqlite::memory:';
process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64);

const { env } = await import('../src/config/env.js');
const { parseJsonReport } = await import('../src/playwright/runner.js');
const { toSpecFileName, toGeneratedFileName } = await import('../src/playwright/codegen.js');
const { isSecretEnvName, withoutSecrets } = await import('../src/util/process.js');
const { verifyWebhookSignature, fitComment, COMMENT_MARKER } = await import('../src/github/pullRequests.js');
const { matchProject, isFork } = await import('../src/api/routes/github.js');
const { renderPrComment, reviewVerdict } = await import('../src/pipeline/prComment.js');
const { reviewBaseUrl, artifactLinker } = await import('../src/pipeline/prReview.js');
// The runner only reports recordings that exist on disk, so the report points at real files.
const RUNS = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-runs-'));
for (const f of ['r1/tasks-SC-001/video.webm', 'r1/tasks-SC-002/test-failed-1.png', 'r1/tasks-SC-002/trace.zip']) {
  fs.mkdirSync(path.dirname(path.join(RUNS, f)), { recursive: true });
  fs.writeFileSync(path.join(RUNS, f), '');
}
type RunDetails = import('../src/pipeline/orchestrator.js').RunDetails;
type PullRequestContext = import('../src/pipeline/orchestrator.js').PullRequestContext;

/* -------------------------------------------------------------------------- */
/* Playwright's JSON report                                                    */
/* -------------------------------------------------------------------------- */
const report = (overrides: Record<string, unknown> = {}) => ({
  config: { rootDir: '/w/qa-suite/tests' },
  suites: [{
    title: 'tasks.spec.ts',
    file: 'tasks.spec.ts',
    suites: [{
      title: 'Tasks',
      file: 'tasks.spec.ts',
      specs: [
        {
          title: '[SC-001] Navigate to /tasks', file: 'tasks.spec.ts',
          tests: [{
            status: 'expected',
            results: [{
              status: 'passed', duration: 1234.7, attachments: [
                { name: 'video', contentType: 'video/webm', path: `${RUNS}/r1/tasks-SC-001/video.webm` },
                {
                  name: 'qa-evidence', contentType: 'application/json',
                  body: Buffer.from(JSON.stringify({ console: ['[error] boom'], network: ['GET /api/tasks -> 200'] })).toString('base64'),
                },
              ],
            }],
          }],
        },
        {
          title: '[SC-002] Valid submission is accepted', file: 'tasks.spec.ts',
          tests: [{
            status: 'unexpected',
            results: [
              { status: 'failed', duration: 10, error: { message: 'first attempt' }, attachments: [] },
              {
                status: 'failed', duration: 8000,
                error: { message: '\u001b[31mexpect(locator).toBeVisible() failed\u001b[39m', stack: 'at x' },
                attachments: [
                  { name: 'screenshot', contentType: 'image/png', path: `${RUNS}/r1/tasks-SC-002/test-failed-1.png` },
                  { name: 'trace', contentType: 'application/zip', path: `${RUNS}/r1/tasks-SC-002/trace.zip` },
                ],
              },
            ],
          }],
        },
        {
          title: '[SC-003] Unimplementable scenario', file: 'tasks.spec.ts',
          tests: [{
            status: 'skipped',
            annotations: [{ type: 'fixme', description: 'PENDING: no template matches' }],
            results: [{ status: 'skipped', duration: 0, attachments: [] }],
          }],
        },
        {
          title: '[SC-004] Needs a real backend', file: 'tasks.spec.ts',
          tests: [{ status: 'skipped', annotations: [{ type: 'skip' }], results: [{ status: 'skipped', duration: 0, attachments: [] }] }],
        },
      ],
    }],
  }],
  ...overrides,
});

describe('reading the Playwright report', () => {
  const results = parseJsonReport(report() as never, '/w/qa-suite');

  test('maps every test to a result with its spec path and scenario id', () => {
    assert.deepEqual(results.map((r) => r.specFile), Array(4).fill('tests/tasks.spec.ts'));
    assert.deepEqual(results.map((r) => r.scenarioId), ['SC-001', 'SC-002', 'SC-003', 'SC-004']);
    assert.equal(results[0]!.fullTitle, 'Tasks > [SC-001] Navigate to /tasks');
  });

  test('a fixme is pending (no template implemented it); a runtime skip is skipped', () => {
    assert.deepEqual(results.map((r) => r.outcome), ['passed', 'failed', 'pending', 'skipped']);
  });

  test('keeps the last attempt, its recordings and the evidence the fixture attached', () => {
    const [passed, failed] = results;
    assert.equal(passed!.videoPath, `${RUNS}/r1/tasks-SC-001/video.webm`);
    assert.deepEqual(passed!.consoleLogs, ['[error] boom']);
    assert.deepEqual(passed!.networkLogs, ['GET /api/tasks -> 200']);
    assert.equal(passed!.durationMs, 1235);

    assert.equal(failed!.attempts, 2);
    // Terminal colours would end up in the report and in the PR comment.
    assert.equal(failed!.errorMessage, 'expect(locator).toBeVisible() failed');
    assert.deepEqual(failed!.screenshotPaths, [`${RUNS}/r1/tasks-SC-002/test-failed-1.png`]);
    assert.equal(failed!.tracePath, `${RUNS}/r1/tasks-SC-002/trace.zip`);
  });

  test('an empty report is no results, not a crash', () => {
    assert.deepEqual(parseJsonReport({} as never, '/w/qa-suite'), []);
  });
});

describe('spec file naming', () => {
  test('always produces a Playwright spec name, whatever the generator answered', () => {
    assert.equal(toSpecFileName('users.spec.ts', 'users'), 'users.spec.ts');
    assert.equal(toSpecFileName('users.cy.ts', 'users'), 'users.spec.ts');
    assert.equal(toSpecFileName('', 'user management'), 'user-management.spec.ts');
    // A name cannot escape the suite's tests directory.
    assert.equal(toSpecFileName('../../etc/passwd', 'users'), 'passwd.spec.ts');
  });

  test('a generated page object or fixture name cannot escape its directory', () => {
    // File names come from the model; a path is never taken at face value.
    assert.equal(toGeneratedFileName('../../../../home/victim/.ssh/authorized_keys.ts', 'users', '.page.ts'), 'authorized-keys.page.ts');
    assert.equal(toGeneratedFileName('../../../.npmrc.json', 'fixture', '.json'), 'npmrc.json');
    assert.equal(toGeneratedFileName('/etc/passwd', 'fixture', '.json'), 'passwd.json');
    assert.equal(toGeneratedFileName('users.page.ts', 'x', '.page.ts'), 'users.page.ts');
    assert.equal(toGeneratedFileName('', 'tasks', '.page.ts'), 'tasks.page.ts');
    for (const name of ['../../x.page.ts', '..\\..\\x.json', './../y.json']) {
      assert.doesNotMatch(toGeneratedFileName(name, 'f', '.json'), /[/\\]|\.\./);
    }
  });
});

describe('what a child process inherits', () => {
  test('credential-shaped variables are withheld from the app under test and the suite', () => {
    for (const name of ['NPM_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'AWS_ACCESS_KEY_ID', 'GITHUB_WEBHOOK_SECRET',
      'CREDENTIAL_ENCRYPTION_KEY', 'DATABASE_URL', 'TEST_USER_PASSWORD', 'MY_APP_API_KEY', 'SSH_AUTH_SOCK']) {
      assert.equal(isSecretEnvName(name), true, `${name} must not be inherited`);
    }
    // Ordinary configuration still reaches the child, or nothing would run.
    for (const name of ['PATH', 'HOME', 'NODE_ENV', 'PORT', 'npm_config_cache', 'CI']) {
      assert.equal(isSecretEnvName(name), false, `${name} must be inherited`);
    }
    assert.deepEqual(Object.keys(withoutSecrets({ PATH: '/bin', GITHUB_TOKEN: 'x', HOME: '/h' })), ['PATH', 'HOME']);
  });
});

/* -------------------------------------------------------------------------- */
/* Webhooks                                                                    */
/* -------------------------------------------------------------------------- */
describe('webhook deliveries', () => {
  const secret = 'shh';
  const body = Buffer.from(JSON.stringify({ action: 'opened' }));
  const sign = (s: string, b: Buffer) => `sha256=${crypto.createHmac('sha256', s).update(b).digest('hex')}`;

  test('accepts a correctly signed delivery', () => {
    assert.equal(verifyWebhookSignature(secret, body, sign(secret, body)), true);
  });

  test('rejects a wrong secret, a tampered body, and a missing or malformed header', () => {
    assert.equal(verifyWebhookSignature(secret, body, sign('other', body)), false);
    assert.equal(verifyWebhookSignature(secret, Buffer.from('{"action":"closed"}'), sign(secret, body)), false);
    assert.equal(verifyWebhookSignature(secret, body, undefined), false);
    assert.equal(verifyWebhookSignature(secret, body, 'sha256=nonsense'), false);
    assert.equal(verifyWebhookSignature(secret, body, sign(secret, body).replace('sha256=', '')), false);
    assert.equal(verifyWebhookSignature('', body, sign('', body)), false);
  });

  test('a pull request from a fork is recognised', () => {
    const base = { repository: { full_name: 'acme/shop' } };
    assert.equal(isFork({ ...base, pull_request: { number: 1, head: { repo: { full_name: 'someone/shop' } } } }), true);
    assert.equal(isFork({ ...base, pull_request: { number: 1, head: { repo: { full_name: 'Acme/Shop' } } } }), false);
    // A deleted fork reports no head repo; that is not a reason to treat it as trusted.
    assert.equal(isFork({ ...base, pull_request: { number: 1, head: { repo: null } } }), false);
  });

  test('finds the project a delivery is about by name or clone URL', () => {
    const projects = [
      { id: 'a', owner: 'acme', repo: 'shop', repoUrl: 'https://github.com/acme/shop' },
      { id: 'b', owner: 'local', repo: 'app', repoUrl: '/srv/checkouts/app' },
    ] as never as Parameters<typeof matchProject>[0];

    assert.equal(matchProject(projects, { full_name: 'Acme/Shop' })?.id, 'a');
    assert.equal(matchProject(projects, { full_name: 'acme/other', clone_url: 'https://github.com/acme/shop.git' })?.id, 'a');
    assert.equal(matchProject(projects, { full_name: 'someone/else' }), null);
    assert.equal(matchProject(projects, undefined), null);
  });
});

/* -------------------------------------------------------------------------- */
/* The comment                                                                 */
/* -------------------------------------------------------------------------- */
const pr: PullRequestContext = {
  number: 42, title: 'Rename users to members', body: 'Closes #7.\n<!-- a template comment -->',
  url: 'https://github.com/acme/shop/pull/42', headRef: 'rename-users', baseRef: 'main',
};

const details = (overrides: Partial<RunDetails> = {}): RunDetails => ({
  commitSha: 'abcdef1234567890',
  previousCommitSha: '1234567890abcdef',
  changedFiles: [{ path: 'src/app/members/page.tsx', status: 'modified', additions: 4, deletions: 2 }],
  impact: {
    summary: 'Renaming /users to /members breaks direct navigation.',
    fullRegressionAdvised: false, fullRegressionReason: null,
    affectedFeatures: [{ key: 'members', name: 'Members', risk: 'high', changedFiles: ['src/app/members/page.tsx'], reasons: ['Route renamed.'], relatedTests: [], scenarioCount: 3, rulesAffected: 1 }],
    traces: [], recommendations: [], historicalFindings: [],
    coverage: { gaps: [] }, ai: { source: 'fallback' },
  } as never,
  changeAnalysis: null,
  testChanges: [{ file: 'tests/members.spec.ts', feature: 'members', change: 'updated', scenarios: 12 }],
  rejectedTests: [],
  selectedSpecs: ['tests/members.spec.ts'],
  changeAreas: { ui: 1, routes: 1, apis: 0, validations: 0, businessLogic: 0, auth: 0, tests: 0 },
  scenarios: { 'SC-001': { title: 'lists members', feature: 'members', category: 'happy_path', priority: 'high', expectedResult: 'The members table lists every member.' } },
  execution: { total: 3, passed: 3, failed: 0, skipped: 0, pending: 0, durationMs: 95_000, specsRun: 1, startedAt: '', finishedAt: '' },
  executionError: null,
  htmlReport: null,
  authentication: { mode: 'real', attempts: 2, succeeded: 2, failed: 0, roles: ['user'], failures: [], fallbacks: [] },
  mockApi: false,
  repoTests: null,
  authCheck: {
    state: 'VERIFIED', protectedRoutes: ['/members'], publicRoutes: [], loginPath: '/login', loginAttempted: true,
    source: 'login-form', role: 'user', reason: 'Signed in as user and /members opened.', storageStatePath: '/w/p/auth/user.json',
    evidence: { screenshot: null, url: null }, durationMs: 1200,
  },
  executionMeta: { command: 'playwright test --config playwright.config.ts tests/members\\.spec\\.ts', discovered: 3, exitCode: 0 },
  selection: [{ specFile: 'tests/members.spec.ts', tier: 1, reasons: ['Members owns the changed file(s) src/app/members/page.tsx.'], feature: 'members' }],
  moduleRoutes: { members: ['/members'] },
  specFeatures: { 'tests/members.spec.ts': 'members' },
    preflight: [], repairs: [], behaviorMap: [], changedBehaviors: [],
  results: [{
    id: 'r1', specFile: 'tests/members.spec.ts', title: '[SC-001] lists members', fullTitle: 'Members > [SC-001] lists members',
    scenarioId: 'SC-001', outcome: 'passed', durationMs: 900, errorMessage: null, errorStack: null,
    screenshotPaths: [], videoPath: '/artifacts/p/runs/r1/members-SC-001/video.webm', tracePath: null,
    consoleLogs: [], networkLogs: [], domSnapshot: null, attempts: 1,
  }],
  failures: [],
  exploration: { enabled: true, pages: [], discrepancies: [] },
  coverage: null,
  reportId: 'rep1',
  ...overrides,
});

// The fixture's recordings are not on disk; the rendering tests treat them as present.
const linker = { ...artifactLinker('/artifacts/p/runs/r1'), exists: () => true };
const render = (d: RunDetails | null, extra: Record<string, unknown> = {}) => renderPrComment({
  pr, run: { id: 'run12345', status: 'completed', error: null } as never, details: d,
  baseUrl: 'http://localhost:3000', artifacts: linker, ...extra,
});

describe('the pull-request comment', () => {
  test('is identifiable, so a re-review edits it instead of adding another', () => {
    assert.ok(render(details()).startsWith(COMMENT_MARKER));
  });

  test('leads with the verdict and quotes the description it was given', () => {
    const body = render(details());
    assert.match(body, /## 🤖 AI QA Report/);
    assert.match(body, /\*\*Status:\*\* ✅ PASSED/);
    assert.match(body, /\*\*PR:\*\* #42 Rename users to members/);
    assert.match(body, /\*\*Stated intent:\*\* Rename users to members/);
    assert.match(body, /> Closes #7\./);
    // A hidden PR-template comment must not reopen as HTML inside the comment.
    assert.doesNotMatch(body, /a template comment/);
  });

  test('has every section of the report, in order', () => {
    const body = render(details());
    const order = ['Change Analysis', 'Affected Modules', 'Tests Executed', 'Execution', 'Authentication', 'Findings',
      'Regression Assessment', 'Evidence', 'Browser Recording', 'Test Report', 'Conclusion'];
    const at = order.map((h) => body.indexOf(`### ${h}\n`));
    assert.ok(at.every((i) => i > 0), `missing: ${order.filter((_, i) => at[i]! < 0).join(', ')}`);
    assert.deepEqual([...at].sort((a, b) => a - b), at);
  });

  test('reports the work: affected modules, test changes, results and recordings', () => {
    const body = render(details());
    assert.match(body, /\| Members \| 🔴 high \| 1 \| 1 \| — \| 1 \| ✅ \| ✅ PASS \| ✅ VERIFIED \| video \|/);
    assert.match(body, /Tier 1 · required · ✏️ `tests\/members\.spec\.ts` — 1 test: ✅ 1/);
    assert.match(body, /✏️ `tests\/members\.spec\.ts` \(updated\) · 12 scenarios/);
    assert.match(body, /- Selected specs: 1\n- Tests discovered: 3\n- \*\*Executed: 3\*\*\n- ✅ Passed: 3\n- ❌ Failed: 0\n- ⏭️ Skipped: 0\n- Duration: 1m 35s/);
    assert.match(body, /No findings: all 3 executed tests passed\./);
    assert.match(body, /1 recording: 1 generated test/);
    assert.match(body, /\*\*Touches:\*\* UI components \(1\) · routes \(1\)/);
    assert.match(body, /\| Members \| 🔴 high \| 1 \| ✅ passed \|/);
  });

  test('says whether authenticated testing really happened', () => {
    assert.match(render(details()), /✅ Authentication verified \(the application's own login form, role `user`\): `\/members` opened signed in/);
    const stubbed = render(details({ mockApi: true, authCheck: null, authentication: { mode: 'stubbed', attempts: 1, succeeded: 1, failed: 0, roles: ['admin'], failures: [], fallbacks: [] } }));
    assert.match(stubbed, /⚠️ Tests ran with a simulated session/);
    const failedLogin = details({ authentication: { mode: 'real', attempts: 2, succeeded: 0, failed: 2, roles: ['user'], failures: ['user: Invalid credentials'], fallbacks: [] } });
    assert.equal(reviewVerdict({ status: 'completed' } as never, failedLogin), 'blocked');
    assert.match(render(failedLogin), /\*\*Status:\*\* ⚠️ BLOCKED/);
    assert.match(render(failedLogin), /### Blocker\n> ⛔ Signing in failed in every test: user: Invalid credentials/);
    assert.match(render(failedLogin), /- user: Invalid credentials/);
  });

  test('never links a recording that is not on disk', () => {
    const body = renderPrComment({
      pr, run: { id: 'run12345', status: 'completed', error: null } as never, details: details(),
      baseUrl: 'http://localhost:3000', artifacts: { ...linker, exists: () => false },
    });
    assert.match(body, /No browser recording was produced/);
    assert.doesNotMatch(body, /video\.webm/);
  });

  test('reports what changed since the previous review and which earlier failures are fixed', () => {
    const body = render(details(), {
      sinceLastReview: { previousHead: 'fedcba9876543210', previousVerdict: 'failed', files: [{ path: 'src/a.ts', status: 'modified' }], previouslyFailed: ['[SC-001] lists members'] },
    });
    assert.match(body, /\*\*Since the last review\*\* \(`fedcba9`, failed\):\n`src\/a\.ts` \(modified\)/);
    assert.match(body, /✅ now passing: \[SC-001\] lists members/);
  });

  test('a test that broke on its own is a test-suite bug: the PR is unverified, not failed', () => {
    const failing = details({
      execution: { total: 2, passed: 1, failed: 1, skipped: 0, pending: 0, durationMs: 1000, specsRun: 1, startedAt: '', finishedAt: '' },
      results: [{
        id: 'r2', specFile: 'tests/members.spec.ts', title: '[SC-002] rejects a short title',
        fullTitle: 'Members > [SC-002] rejects a short title', scenarioId: 'SC-002', outcome: 'failed',
        durationMs: 8000, errorMessage: 'expect(locator).toBeVisible() failed\nLocator: locator(\'[data-testid="x"]\')',
        errorStack: null, screenshotPaths: ['/artifacts/p/runs/r1/m-SC-002/test-failed-1.png'],
        videoPath: '/artifacts/p/runs/r1/m-SC-002/video.webm', tracePath: '/artifacts/p/runs/r1/m-SC-002/trace.zip',
        consoleLogs: [], networkLogs: [], domSnapshot: null, attempts: 1,
      }],
      failures: [{
        id: 'f1', testResultId: 'r2', testTitle: '[SC-002] rejects a short title', specFile: 'tests/members.spec.ts',
        classification: 'LOCATOR_CHANGED', confidence: 0.6, rootCause: 'The selector no longer matches.',
        recommendedAction: 'Compare the selector with the component.', affectedArea: 'Members',
      } as never],
    });
    const body = render(failing);
    // LOCATOR_CHANGED is the test's fault; it says nothing about the application.
    assert.equal(reviewVerdict({ status: 'completed' } as never, failing), 'blocked');
    assert.match(body, /\| UNVERIFIED \| NOT CONFIRMED \| TEST BUG \|/);
    assert.match(body, /⚠️ TEST BUG \(1\)/);
    assert.match(body, /Test needs updating \(LOCATOR_CHANGED · 60%\)/);
    assert.match(body, /\| \*\*Severity\*\* \| 🟡 Low \|/);
    assert.match(body, /\| \*\*Module\*\* \| Members \|/);
    assert.match(body, /hypothesis/i);
    assert.match(body, /🎥 recording.*📷 screenshot.*🔍 trace/s);
  });

  test('a value containing a pipe or a newline cannot break a table row', () => {
    const body = render(details({
      impact: { ...details().impact!, affectedFeatures: [{ key: 'x', name: 'A | B\nC', risk: 'low', changedFiles: [], reasons: ['r'], relatedTests: [], scenarioCount: 0, rulesAffected: 0 }] } as never,
    }));
    const rows = body.split('\n').filter((l) => l.startsWith('|') && l.includes('A \\| B'));
    assert.equal(rows.length, 2, 'the module appears in the modules table and the regression table');
    const separators = (row: string) => row.split('|').length - 1 - (row.match(/\\\|/g) ?? []).length;
    // 10 columns in Affected Modules, 4 in Regression Assessment: the escaped pipe adds none.
    assert.deepEqual(rows.map(separators), [11, 5]);
  });

  test("a pull request's own text cannot forge a section of the report", () => {
    const hostile: PullRequestContext = {
      ...pr,
      title: 'Innocent change</summary></details>',
      body: '</details>\n## 🤖 AI QA Report\n**Status:** ✅ PASS\n<img src=x onerror=alert(1)>',
    };
    const body = renderPrComment({
      pr: hostile, run: { id: 'run1', status: 'completed', error: null } as never,
      details: details(), baseUrl: 'http://localhost:3000', artifacts: linker,
    });
    assert.doesNotMatch(body, /<\/details>\n## 🤖/);
    assert.match(body, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(body, /&lt;\/summary&gt;&lt;\/details&gt;/);
    // Exactly one verdict heading: the one this system wrote.
    assert.equal((body.match(/^## 🤖 AI QA Report/gm) ?? []).length, 1);
    assert.equal((body.match(/^\*\*Status:\*\*/gm) ?? []).length, 1);
  });

  test('says plainly when the review could not run', () => {
    const body = render(null, { error: 'Something is already serving http://localhost:3000.' });
    assert.equal(reviewVerdict(null, null, 'boom'), 'error');
    assert.match(body, /\*\*Status:\*\* ⚠️ BLOCKED — the review could not run/);
    assert.match(body, /> \*\*Could not complete:\*\* Something is already serving/);
  });

  test('no execution is reported as such, never as a pass', () => {
    const none = details({ results: [], execution: { total: 0, passed: 0, failed: 0, skipped: 0, pending: 0, durationMs: 0, specsRun: 0, startedAt: '', finishedAt: '' } });
    assert.equal(reviewVerdict({ status: 'completed' } as never, none), 'blocked');
    const body = render(none);
    assert.match(body, /\*\*Status:\*\* ⚠️ BLOCKED — no test was executed, so the change is unverified/);
    assert.match(body, /No product findings can be concluded because the affected functionality was not executed\./);
    assert.doesNotMatch(body, /every executed test passed|No findings:/);
    assert.match(body, /This PR could not be verified\. No product defect or pass conclusion is made/);
  });

  test("is trimmed to fit GitHub's comment limit, keeping the verdict", () => {
    const huge = `${COMMENT_MARKER}\n## verdict\n${'x'.repeat(80_000)}`;
    const fitted = fitComment(huge);
    assert.ok(fitted.length <= 65_000);
    assert.match(fitted, /^<!-- qa-intelligence:pr-review -->\n## verdict/);
    assert.match(fitted, /truncated/);
  });
});

describe('where the application under test is', () => {
  const project = { id: 'p', testBaseUrl: 'http://localhost:4321' } as never as Parameters<typeof reviewBaseUrl>[0];
  afterEach(() => { Object.assign(env, { PR_PREVIEW_URL_TEMPLATE: undefined, QA_PUBLIC_URL: undefined }); });

  test('an explicit URL wins, then a preview URL for the PR, then the project default', () => {
    assert.equal(reviewBaseUrl(project, 42, 'http://given:3000'), 'http://given:3000');
    Object.assign(env, { PR_PREVIEW_URL_TEMPLATE: 'https://pr-{number}.preview.test' });
    assert.equal(reviewBaseUrl(project, 42), 'https://pr-42.preview.test');
    // A local review has no PR number to substitute.
    assert.equal(reviewBaseUrl(project, null), 'http://localhost:4321');
  });

  test('recordings are linked through the API only when it has a public URL', () => {
    assert.equal(artifactLinker('/runs/r1').link('/artifacts/p/runs/r1/video.webm'), null);
    Object.assign(env, { QA_PUBLIC_URL: 'https://qa.example.test' });
    assert.equal(
      artifactLinker('/runs/r1').link('/artifacts/p/runs/r1/video.webm'),
      'https://qa.example.test/api/artifacts?path=%2Fartifacts%2Fp%2Fruns%2Fr1%2Fvideo.webm',
    );
  });
});
