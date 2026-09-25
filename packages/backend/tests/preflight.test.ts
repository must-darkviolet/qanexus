/**
 * Preflight validation of generated tests, and what the report concludes
 * from what did or did not run.
 *
 * The broken spec below is the one PR #2577's review generated: every test
 * used an educationManagementPage nobody declared, and three only navigated
 * while claiming to verify refetch behaviour and conditional rendering.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, describe, after } from 'node:test';

process.env.DATABASE_URL = 'sqlite::memory:';

const { preflightSpec, readPageObjects, readCustomFixtures, describeDiagnostic } = await import('../src/playwright/preflight.js');
const { repairGeneratedOutput } = await import('../src/playwright/repairGenerated.js');
const { triggerPath } = await import('../src/analysis/behaviorEvidence.js');
const { QA_HELPERS } = await import('../src/playwright/scaffold.js');
const { executionPlan, merge } = await import('../src/pipeline/generation.js');
const { assess, reviewVerdict, renderPrComment, rootCauseKey } = await import('../src/pipeline/prComment.js');
type RunDetails = import('../src/pipeline/orchestrator.js').RunDetails;
type PreflightContext = import('../src/playwright/preflight.js').PreflightContext;

const suite = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-preflight-'));
fs.mkdirSync(path.join(suite, 'tests'), { recursive: true });
fs.mkdirSync(path.join(suite, 'pages'), { recursive: true });
fs.mkdirSync(path.join(suite, 'support'), { recursive: true });
fs.writeFileSync(path.join(suite, 'support', 'qa.ts'), 'export const test = base.extend<{ qa: Qa; qaEvidence: void }>({});\n');
after(() => fs.rmSync(suite, { recursive: true, force: true }));

const SCENARIOS: PreflightContext['scenarios'] = {
  'SC-080': { title: 'Navigate to /education-management', expectedResult: 'The Education Management page opens.' },
  'SC-525': { title: 'Conditionally render Cron settings save action based on userRole or userRoleV2 settings', expectedResult: 'The save action is shown only for permitted roles.' },
  'SC-529': { title: 'Verify conditional refetch in EducationHistoryDialog and EducationManagementPage with user email and id checks', expectedResult: 'refresh only refetches when user_email and user_id are present.' },
  'SC-530': { title: 'Verify Promise.all refetch execution in EducationHistoryDialog when user fields are present', expectedResult: 'Both user details and history are refetched in parallel.' },
};

const ctx = (extra: Partial<PreflightContext> = {}): PreflightContext => ({
  suiteRoot: suite, pageObjects: readPageObjects(path.join(suite, 'pages')), qaHelpers: QA_HELPERS,
  scenarios: SCENARIOS, changedTerms: ['user_email', 'user_id', 'EducationHistoryDialog', 'refetch'],
  customFixtures: readCustomFixtures(path.join(suite, 'support', 'qa.ts')),
  ...extra,
});

const BROKEN = `import { test, expect } from '../support/qa';

test.describe('Education Management page and features', () => {
  test('[SC-080] Navigate to /education-management', async ({ page, qa }) => {
    await educationManagementPage.goto();
    await expect(page).toHaveURL(/\\/education-management/);
  });

  test('[SC-525] Conditionally render Cron settings save action based on userRole or userRoleV2 settings', async ({ page, qa }) => {
    await educationManagementPage.goto();
  });

  test('[SC-529] Verify conditional refetch in EducationHistoryDialog and EducationManagementPage with user email and id checks', async ({ page, qa }) => {
    await educationManagementPage.goto();
  });

  test('[SC-530] Verify Promise.all refetch execution in EducationHistoryDialog when user fields are present', async ({ page, qa }) => {
    await educationManagementPage.goto();
  });
});
`;

describe('preflight validation', () => {
  test('case A: an undefined page object fails preflight, and nothing is launched', () => {
    const result = preflightSpec('tests/education-management.spec.ts', BROKEN, ctx());
    assert.equal(result.tests.length, 4);
    for (const t of result.tests) {
      assert.equal(t.executable, false);
      assert.equal(t.gates.dependencies_valid, false);
      assert.equal(t.declared['educationManagementPage'], 'MISSING');
      assert.match(t.problems[0]!, /ReferenceError: educationManagementPage is not defined/);
    }
    const plan = executionPlan([result]);
    assert.deepEqual(plan.specs, [], 'no spec is handed to Playwright');
    assert.equal(plan.grep, null);
    assert.equal(plan.blocked.length, 4);
  });

  test('case A: repair uses the page fixture for a goto-only reference, and leaves anything else for preflight to reject', () => {
    const output = {
      pageObjects: [], fixtures: [], reusedExistingArtifacts: [], notes: [],
      specs: [{
        fileName: 'education-management.spec.ts', feature: 'education-management', describe: 'Education Management', imports: [],
        tests: [
          { scenarioId: 'SC-080', title: 'Navigate', tags: [], body: 'await educationManagementPage.goto();\nawait expect(page).toHaveURL(/education-management/);' },
          { scenarioId: 'SC-529', title: 'Refetch', tags: [], body: 'await educationManagementPage.goto();\nawait educationManagementPage.openHistory();' },
        ],
      }],
    };
    const { output: repaired, repairs } = repairGeneratedOutput(output as never, { existingPageObjects: [], route: '/education-management' });
    assert.equal(repaired.specs[0]!.tests[0]!.body.split('\n')[0], 'await page.goto("/education-management");');
    // openHistory() cannot be supplied safely: left as it was, preflight rejects it.
    assert.match(repaired.specs[0]!.tests[1]!.body, /educationManagementPage\.openHistory/);
    assert.equal(repairs.length, 1);
  });

  test('a misspelt reference to an existing page object is pointed at it', () => {
    const output = {
      pageObjects: [{ className: 'EducationManagementPage', fileName: 'education-management.page.ts', locators: [], methods: [{ name: 'goto', params: [], body: '' }] }],
      fixtures: [], reusedExistingArtifacts: [], notes: [],
      specs: [{ fileName: 'x.spec.ts', feature: 'x', describe: 'x', imports: [], tests: [{ scenarioId: 'SC-080', title: 'Navigate', tags: [], body: 'await educationMgmtPage.goto();' }] }],
    };
    const loose = repairGeneratedOutput(output as never, { existingPageObjects: [], route: null });
    // Not the same name after normalisation: no guess is made.
    assert.equal(loose.repairs.length, 0);
    const close = repairGeneratedOutput({ ...output, specs: [{ ...output.specs[0]!, tests: [{ ...output.specs[0]!.tests[0]!, body: 'await EducationManagement_page.goto();'.replace('EducationManagement_page', 'educationmanagementPage') }] }] } as never, { existingPageObjects: [], route: null });
    assert.match(close.output.specs[0]!.tests[0]!.body, /educationManagementPage\.goto/);
  });

  test('case B: a placeholder that claims to verify refetch behaviour fails semantic validation', () => {
    const source = `import { test, expect } from '../support/qa';
test('[SC-529] Verify conditional refetch in EducationHistoryDialog and EducationManagementPage with user email and id checks', async ({ page, qa }) => {
  await page.goto('/education-management');
});`;
    const [t] = preflightSpec('tests/p.spec.ts', source, ctx()).tests;
    assert.equal(t!.gates.dependencies_valid, true);
    assert.equal(t!.gates.assertions_present, false);
    assert.equal(t!.gates.behavior_covered, false);
    assert.equal(t!.executable, false);
    assert.deepEqual(t!.actions, ['goto']);
  });

  test('case B: asserting the URL does not make a refetch scenario covered', () => {
    const source = `import { test, expect } from '../support/qa';
test('[SC-530] Verify Promise.all refetch execution in EducationHistoryDialog when user fields are present', async ({ page, qa }) => {
  await page.goto('/education-management');
  await expect(page).toHaveURL(/education-management/);
});`;
    const [t] = preflightSpec('tests/p.spec.ts', source, ctx()).tests;
    assert.equal(t!.gates.behavior_covered, false);
    assert.match(t!.semanticReason!, /does not verify any request or refetch/);
  });

  test('a real refetch test - the fields in the data, the request stubbed and asserted - passes', () => {
    const source = `import { test, expect } from '../support/qa';
test('[SC-529] Verify conditional refetch in EducationHistoryDialog and EducationManagementPage with user email and id checks', async ({ page, qa }) => {
  await qa.stub('GET', '/api/users/\\\\d+', { statusCode: 200, body: { user_email: 'a@b.test', user_id: 7 } }, 'user');
  await qa.stub('GET', '/api/education-history', { statusCode: 200, body: [] }, 'history');
  await page.goto('/education-management');
  await page.getByRole('button', { name: 'History' }).click();
  await qa.waitFor('history');
});`;
    const [t] = preflightSpec('tests/p.spec.ts', source, ctx()).tests;
    assert.deepEqual(t!.problems, []);
    assert.equal(t!.executable, true);
    assert.equal(t!.gates.pr_relevant, true);
  });

  test('case C: a page object the suite defines, constructed the suite\'s way, passes', () => {
    fs.writeFileSync(path.join(suite, 'pages', 'education-management.page.ts'), `import type { Page } from 'playwright/test';
export class EducationManagementPage {
  readonly locators = { heading: 'h1' } as const;
  constructor(readonly page: Page) {}
  async goto(): Promise<void> { await this.page.goto('/education-management'); }
}
`);
    const source = `import { test, expect } from '../support/qa';
import { EducationManagementPage } from '../pages/education-management.page';
test('[SC-080] Navigate to /education-management', async ({ page, qa }) => {
  const educationManagementPage = new EducationManagementPage(page);
  await educationManagementPage.goto();
  await expect(educationManagementPage.el('heading')).toBeVisible();
  await expect(page).toHaveURL(/education-management/);
});`;
    const [t] = preflightSpec('tests/e.spec.ts', source, ctx()).tests;
    assert.deepEqual(t!.problems, []);
    assert.equal(t!.executable, true);
    assert.equal(t!.declared['educationManagementPage'], 'page-object EducationManagementPage');

    // A method or locator the class does not have is caught.
    const wrong = preflightSpec('tests/e.spec.ts', source.replace('.goto()', '.open()').replace("el('heading')", "el('missing')"), ctx()).tests[0]!;
    assert.equal(wrong.gates.page_objects_valid, false);
    assert.ok(wrong.problems.some((p) => /open\(\) does not exist/.test(p)));
    assert.ok(wrong.problems.some((p) => /el\('missing'\) names a locator/.test(p)));
  });

  test('case C: a page object the suite exposes as a fixture passes', () => {
    fs.writeFileSync(path.join(suite, 'support', 'qa.ts'), 'export const test = base.extend<{ qa: Qa; educationManagementPage: EducationManagementPage }>({});\n');
    const source = `import { test, expect } from '../support/qa';
test('[SC-080] Navigate to /education-management', async ({ page, educationManagementPage }) => {
  await educationManagementPage.goto();
  await expect(page).toHaveURL(/education-management/);
});`;
    const [t] = preflightSpec('tests/e.spec.ts', source, ctx()).tests;
    assert.equal(t!.gates.fixtures_valid, true);
    assert.equal(t!.declared['educationManagementPage'], 'fixture');
    assert.equal(t!.executable, true);
    // An unknown fixture is not.
    const bad = preflightSpec('tests/e.spec.ts', source.replace('educationManagementPage }', 'somethingElse }'), ctx()).tests[0]!;
    assert.equal(bad.gates.fixtures_valid, false);
  });

  test('a navigation test that never navigates is rejected (it would only check about:blank)', () => {
    const source = `import { test, expect } from '../support/qa';
test('[SC-080] Navigate to /education-management', async ({ page, qa }) => {
  await expect(page).toHaveURL(/.*education-management/);
});`;
    const [t] = preflightSpec('tests/e.spec.ts', source, ctx()).tests;
    assert.equal(t!.gates.behavior_covered, false);
    assert.match(t!.semanticReason!, /never navigates to or interacts with the application/);
  });

  test('against the real backend, a stub-dependent test that clicks a destructive control is not safe to run', () => {
    // SC-524 as generated for PR #2577: with TEST_MOCK_API=0 the stub is inactive and the click is real.
    const source = `import { test, expect } from '../support/qa';
test('[SC-524] Display error notification and reset loading state on education reset failure', async ({ page, qa }) => {
  await page.goto('/education-management');
  await qa.stub('POST', '/education-management/reset', { statusCode: 400, body: { error: 'failed' } }, 'resetFail');
  await page.getByRole('button', { name: 'Reset Education' }).click();
  await qa.expectErrorShown();
});`;
    const real = preflightSpec('tests/e.spec.ts', source, ctx({ mockApi: false })).tests[0]!;
    assert.equal(real.gates.safe_to_run, false);
    assert.equal(real.executable, false);
    assert.ok(real.problems.some((p) => /qa\.stub, which is inactive against the real backend/.test(p)));
    assert.ok(real.problems.some((p) => /Performs "Reset Education" against the real backend/.test(p)));
    // With the API stubbed, the same test is safe.
    assert.equal(preflightSpec('tests/e.spec.ts', source, ctx({ mockApi: true })).tests[0]!.gates.safe_to_run, true);
    // Guarded by the standard skip, it is safe either way.
    const guarded = source.replace("await page.goto", "test.skip(!qa.mockApi, 'needs stubbed data');\n  await page.goto");
    assert.equal(preflightSpec('tests/e.spec.ts', guarded, ctx({ mockApi: false })).tests[0]!.gates.safe_to_run, true);
  });

  test('a qa helper that does not exist is caught', () => {
    const source = `import { test, expect } from '../support/qa';
test('[SC-080] Navigate to /education-management', async ({ page, qa }) => {
  await page.goto('/education-management');
  await qa.expectToastSaying('saved');
});`;
    const [t] = preflightSpec('tests/e.spec.ts', source, ctx()).tests;
    assert.ok(t!.problems.some((p) => /qa\.expectToastSaying\(\), which the qa fixture does not have/.test(p)));
    assert.equal(t!.executable, false);
  });
});

/* -------------------------------------------------------------------------- */
/* Reporting: root causes and status semantics                                 */
/* -------------------------------------------------------------------------- */

const run = { id: 'run00001', status: 'completed', error: null } as never;
const linker = { link: () => null, where: 'Stored locally.', exists: () => true };
const pr = { number: 2577, title: 'Fix super save refresh', body: '', url: null, headRef: 'fix', baseRef: 'main' };

const result = (id: string, outcome: 'passed' | 'failed', spec: string, error: string | null = null, pageUrl: string | null = 'https://app.test/education-management') => ({
  id, specFile: spec, title: `[${id}] ${id}`, fullTitle: id, scenarioId: id, outcome, durationMs: 100, errorMessage: error,
  errorStack: null, screenshotPaths: [], videoPath: null, tracePath: null, consoleLogs: [], networkLogs: [], domSnapshot: null,
  attempts: 2, pageUrl,
});
const diagnosis = (id: string, classification: string, spec: string, confidence = 0.95) => ({
  id: `f-${id}`, testResultId: id, testTitle: `[${id}] ${id}`, specFile: spec, classification, confidence,
  rootCause: 'See the error.', recommendedAction: null, affectedArea: null,
});

function details(overrides: Partial<RunDetails>): RunDetails {
  const results = (overrides.results ?? []) as RunDetails['results'];
  return {
    commitSha: 'b3d94d98', previousCommitSha: 'f1f49fe5', changedFiles: [],
    impact: { summary: '', fullRegressionAdvised: false, fullRegressionReason: null, affectedFeatures: [
      { key: 'education-management', name: 'Education Management', risk: 'high', changedFiles: [], reasons: ['r'], relatedTests: [], scenarioCount: 0, rulesAffected: 0 },
    ], traces: [], recommendations: [], historicalFindings: [], coverage: { gaps: [] }, ai: { source: 'gemini' } } as never,
    changeAnalysis: null, testChanges: [], rejectedTests: [], selectedSpecs: [],
    changeAreas: { ui: 0, routes: 0, apis: 0, validations: 0, businessLogic: 0, auth: 0, tests: 0 }, scenarios: {},
    execution: { total: results.length, passed: results.filter((r) => r.outcome === 'passed').length, failed: results.filter((r) => r.outcome === 'failed').length, skipped: 0, pending: 0, durationMs: 1000, specsRun: 1, startedAt: '', finishedAt: '' },
    executionError: null, htmlReport: null, authentication: null, mockApi: false, repoTests: null, authCheck: null,
    executionMeta: { command: null, discovered: results.length, exitCode: 1 },
    selection: [
      { specFile: 'tests/education-management.spec.ts', tier: 1, reasons: ['owns the change'], feature: 'education-management' },
      { specFile: 'tests/news.spec.ts', tier: 2, reasons: ['related'], feature: 'news' },
    ],
    moduleRoutes: {}, specFeatures: { 'tests/education-management.spec.ts': 'education-management', 'tests/news.spec.ts': 'news' },
    preflight: [], repairs: [], behaviorMap: [], changedBehaviors: ['EducationHistoryDialog (EducationHistoryDialog.tsx) modified'],
    failures: [], exploration: { enabled: false, pages: [], discrepancies: [] }, coverage: null,
    ...overrides, results,
  } as RunDetails;
}

describe('failure aggregation and status semantics', () => {
  const EM = 'tests/education-management.spec.ts';

  test('case D: four failures with one root cause are one finding with four scenarios', () => {
    const error = 'ReferenceError: educationManagementPage is not defined\n    at tests/education-management.spec.ts:5:5';
    const rs = ['SC-080', 'SC-525', 'SC-529', 'SC-530'].map((id) => result(id, 'failed', EM, error, 'about:blank'));
    assert.equal(new Set(rs.map((r) => rootCauseKey(r.errorMessage))).size, 1);
    const d = details({ results: rs as never, failures: rs.map((r) => diagnosis(r.id, 'TEST_BUG', EM)) as never });
    const body = renderPrComment({ pr, run, details: d, baseUrl: 'https://app.test', artifacts: linker });
    const findings = body.slice(body.indexOf('### Findings'), body.indexOf('### Regression Assessment'));
    assert.equal((findings.match(/<details>/g) ?? []).length, 1, 'one finding, not four');
    assert.match(findings, /TEST SUITE BUG<\/b> — 4 scenarios failed from one cause: <b>ReferenceError: educationManagementPage is not defined/);
    assert.match(findings, /\*\*Affected scenarios:\*\* SC-080, SC-525, SC-529, SC-530/);
    assert.match(findings, /Application interaction: \*\*NOT REACHED\*\* · Application defect: \*\*NOT CONFIRMED\*\* · PR verification: \*\*UNVERIFIED\*\*/);
    const a = assess(d);
    assert.deepEqual([a.prVerification, a.application, a.testSuite], ['UNVERIFIED', 'NOT CONFIRMED', 'TEST BUG']);
    assert.notEqual(reviewVerdict(run, d), 'failed', 'a Playwright exit code of 1 is not a PR failure');
  });

  test('tests blocked in preflight are reported as test-suite defects, and the PR is unverified', () => {
    const blocked = preflightSpec(EM, BROKEN, ctx()).tests;
    const d = details({ results: [], execution: null, preflight: blocked,
      executionError: 'Blocked before execution (UNEXECUTABLE_TEST): none of the 4 selected test(s) passed preflight validation, so no browser was launched.' });
    const a = assess(d);
    assert.equal(a.execution, 'BLOCKED_BY_TEST_BUG');
    assert.equal(a.prVerification, 'UNVERIFIED');
    assert.equal(reviewVerdict(run, d), 'blocked');
    const body = renderPrComment({ pr, run, details: d, baseUrl: 'https://app.test', artifacts: linker });
    assert.match(body, /\| UNVERIFIED \| NOT CONFIRMED \| TEST BUG \| BLOCKED_BY_TEST_BUG \| NOT RUN \|/);
    assert.match(body, /TEST SUITE BUG<\/b> — 4 scenarios blocked before execution \(UNEXECUTABLE_TEST\)/);
    assert.match(body, /### PR Behavior Coverage[\s\S]*\| Scenario \| Strategy \| Evidence \| Status \| Reason \|/);
    assert.match(body, /\| SC-080 Navigate to \/education-management \| UI \| DOM \| ⛔ BLOCKED \| preflight: educationManagementPage is used but never declared/);
    assert.match(body, /\| Education Management \| 🔴 high \| 1 \| 4 \| 0 \| 0 \| — \| ⚠️ BLOCKED/);
  });

  test('case E: a valid targeted test failing on application behaviour is a confirmed defect and a failed PR', () => {
    const r = result('SC-529', 'failed', EM, 'Error: expect(received).toBe(expected)\nExpected: 0\nReceived: 1');
    const d = details({ results: [r, result('SC-080', 'passed', EM)] as never, failures: [diagnosis('SC-529', 'APPLICATION_BUG', EM)] as never });
    const a = assess(d);
    assert.deepEqual([a.prVerification, a.application], ['FAILED', 'DEFECT CONFIRMED']);
    assert.equal(reviewVerdict(run, d), 'failed');
    const body = renderPrComment({ pr, run, details: d, baseUrl: 'https://app.test', artifacts: linker });
    assert.match(body, /Application interaction: \*\*REACHED\*\* · Application defect: \*\*CONFIRMED\*\*/);

    // A less confident diagnosis only suspects a defect: the PR is unverified, not failed.
    const unsure = details({ results: [r, result('SC-080', 'passed', EM)] as never, failures: [diagnosis('SC-529', 'APPLICATION_BUG', EM, 0.85)] as never });
    assert.deepEqual([assess(unsure).prVerification, assess(unsure).application], ['UNVERIFIED', 'DEFECT SUSPECTED']);
  });

  test('case F: targeted tests pass and an unrelated regression test fails - PR passed, regression reported separately', () => {
    const d = details({
      results: [result('SC-080', 'passed', EM), result('SC-900', 'failed', 'tests/news.spec.ts', 'Error: expect(locator).toBeVisible() failed')] as never,
      failures: [diagnosis('SC-900', 'APPLICATION_BUG', 'tests/news.spec.ts')] as never,
    });
    const a = assess(d);
    assert.equal(a.prVerification, 'PASSED');
    assert.equal(a.regression, 'FAILURES DETECTED');
    assert.equal(reviewVerdict(run, d), 'passed');
    const body = renderPrComment({ pr, run, details: d, baseUrl: 'https://app.test', artifacts: linker });
    assert.match(body, /\| PASSED \| NO DEFECT FOUND \| OK \| COMPLETED \| FAILURES DETECTED \|/);
    assert.match(body, /Regression test \(outside the change\)/);
  });
});

/* -------------------------------------------------------------------------- */
/* Test strategies: behaviour first, selectors only when the effect is visual  */
/* -------------------------------------------------------------------------- */

describe('test-strategy classification and validation', async () => {
  const { classifyScenario } = await import('../src/pipeline/strategy.js');
  const { notImplemented } = await import('../src/playwright/preflight.js');
  const API = ['/super-save/get_user_details', '/super-save/get_user_education_history', '/super-save/change_super_save_status', '/super-save/get_users_educations'];
  const net = (extra: Partial<PreflightContext> = {}) => ctx({ apiPaths: API, mockApi: false, ...extra });
  const spec = (title: string, body: string) => `import { test, expect } from '../support/qa';
test('${title}', async ({ page, qa }) => {
${body}
});`;

  test('case A: a visible effect with a stable selector is a UI test', () => {
    const c = classifyScenario({ title: 'Save button is visible only for userRole === 0' });
    assert.ok(['UI', 'API_MOCK'].includes(c.strategy));
    assert.ok(c.evidence.includes('DOM'));
    const plain = classifyScenario({ title: 'Reset Education button is shown on the page' });
    assert.equal(plain.strategy, 'UI');
  });

  test('case B: a refetch scenario with no UI selector is a NETWORK-based strategy, not UNIMPLEMENTED', () => {
    const c = classifyScenario({ title: 'Do not trigger history refetch when user_email or user_id is missing' }, { networkEvidence: true });
    assert.ok(['NETWORK', 'API_MOCK'].includes(c.strategy), c.strategy);
    assert.ok(c.evidence.includes('NETWORK'));
    assert.notEqual(c.strategy, 'UNIMPLEMENTED');
  });

  test('case C: a user action causing an API request is UI_AND_NETWORK', () => {
    const c = classifyScenario({ title: 'Changing Super Save status should not trigger unrelated API calls' }, { networkEvidence: true });
    assert.equal(c.strategy, 'UI_AND_NETWORK');
    assert.deepEqual(c.evidence, ['UI_ACTION', 'NETWORK']);
  });

  test('case D: internal logic with no observable effect is UNIT_OR_COMPONENT, and not run in the Playwright suite', () => {
    const c = classifyScenario({ title: 'setResetEducationLoading(false) is called with the hook state' });
    assert.equal(c.strategy, 'UNIT_OR_COMPONENT');
    const [t] = preflightSpec('tests/e.spec.ts', spec('[SC-543] Handle education reset failure', `  // strategy: UNIT_OR_COMPONENT
  await page.goto('/education-management');
  await expect(page).toHaveURL(/education/);`), net()).tests;
    assert.equal(t!.gates.strategy_valid, false);
    assert.equal(t!.executable, false);
  });

  test('case E: no selector but stable network evidence - a network test passes preflight and is executable', () => {
    const body = `  // strategy: API_MOCK · evidence: API_RESPONSE + NETWORK
  await qa.intercept('GET', '/get_users_educations', { statusCode: 200, body: { data: [{ user_id: 7, user_name: 'no email' }] } }, 'list');
  qa.observe('details', 'GET', '/get_user_details');
  await page.goto('/education-management');
  await page.getByRole('button', { name: 'View History' }).first().click();
  await qa.expectRequestNotMade('details');`;
    const [t] = preflightSpec('tests/e.spec.ts', spec('[SC-529] Verify conditional refetch in EducationHistoryDialog and EducationManagementPage with user email and id checks', body), net()).tests;
    assert.deepEqual(t!.problems, []);
    assert.equal(t!.executable, true);
    assert.equal(t!.strategy, 'API_MOCK');
    assert.equal(t!.gates.evidence_source_valid, true);
    assert.equal(t!.gates.safe_to_run, true);
  });

  test('case E: a network test observing an invented endpoint fails evidence_source_valid', () => {
    const body = `  // strategy: NETWORK
  qa.observe('history', 'GET', '/api/education/history-v2');
  await page.goto('/education-management');
  await qa.expectRequestMade('history');`;
    const [t] = preflightSpec('tests/e.spec.ts', spec('[SC-530] Verify Promise.all refetch execution in EducationHistoryDialog when user fields are present', body), net()).tests;
    assert.equal(t!.gates.evidence_source_valid, false);
    assert.ok(t!.problems.some((p) => /matches no endpoint/.test(p)));
  });

  test('a NETWORK test owes no DOM assertion, but must assert requests', () => {
    const good = `  // strategy: NETWORK
  qa.observe('history', 'GET', '/get_user_education_history');
  await page.goto('/education-management');
  await page.getByRole('button', { name: 'View History' }).first().click();
  await qa.expectRequestMade('history');
  expect(qa.lastRequest('history')?.url).toContain('user_id=');`;
    const [ok] = preflightSpec('tests/e.spec.ts', spec('[SC-530] Verify Promise.all refetch execution in EducationHistoryDialog when user fields are present', good), net()).tests;
    assert.deepEqual(ok!.problems, []);
    const noRequestAssertion = good.replace("  await qa.expectRequestMade('history');\n  expect(qa.lastRequest('history')?.url).toContain('user_id=');", "  await expect(page).toHaveURL(/education/);");
    const [bad] = preflightSpec('tests/e.spec.ts', spec('[SC-530] Verify Promise.all refetch execution in EducationHistoryDialog when user fields are present', noRequestAssertion), net()).tests;
    assert.equal(bad!.gates.strategy_valid, false);
  });

  test('a write intercepted by qa.intercept is safe to run against the real backend', () => {
    const body = `  // strategy: UI_AND_NETWORK · evidence: UI_ACTION + NETWORK
  await qa.intercept('POST', '/change_super_save_status', { statusCode: 200, body: { success: true } }, 'save');
  qa.observe('details', 'GET', '/get_user_details');
  await page.goto('/education-management');
  await page.getByRole('switch').first().click();
  await qa.expectRequestMade('save');
  await qa.expectRequestNotMade('details');`;
    const [t] = preflightSpec('tests/e.spec.ts', spec('[SC-545] Changing Super Save status should not trigger unrelated API calls', body), net()).tests;
    assert.deepEqual(t!.problems, []);
    assert.equal(t!.executable, true);
  });

  test('false passes from the PR #2577 run are all blocked', () => {
    const check = (title: string, body: string) => preflightSpec('tests/e.spec.ts', spec(title, body), net()).tests[0]!;
    // SC-545: asserts an alias it never registered - the count is always 0.
    const neverRegistered = check('[SC-545] Verify conditional refetch in handleOnSaveSuperSave with user email and id checks', `  // strategy: API_MOCK · evidence: API_RESPONSE + NETWORK
  await qa.intercept('POST', '/super-save/change_super_save_status', { statusCode: 200, body: {} }, 'saveStatus');
  await page.goto('/education-management');
  await qa.expectRequestNotMade('getUsersEdu');`);
    assert.equal(neverRegistered.executable, false);
    assert.ok(neverRegistered.problems.some((p) => /never registers/.test(p)));
    // SC-530: intercepts the list, then asserts the list was requested - circular.
    const circular = check('[SC-530] Verify Promise.all refetch execution in EducationHistoryDialog when user fields are present', `  // strategy: API_MOCK · evidence: API_RESPONSE + UI_ACTION + NETWORK
  await qa.intercept('GET', '/super-save/get_users_educations', { statusCode: 200, body: [] }, 'list');
  await page.goto('/education-management');
  await qa.expectRequestMade('list');`);
    assert.equal(circular.executable, false);
    // SC-523: claims a toast, asserts an unrelated button.
    const unrelated = check('[SC-523] Display offline error toast on network error during education management actions', `  // strategy: API_MOCK · evidence: API_RESPONSE + DOM
  await qa.intercept('GET', '/super-save/get_users_educations', { statusCode: 500, body: {} }, 'list');
  await page.goto('/education-management');
  await qa.expectRequestMade('list');
  await expect(page.getByRole('button', { name: 'Approve All' })).toBeVisible();`);
    assert.equal(unrelated.executable, false);
    assert.ok(unrelated.problems.some((p) => /never asserts that the error or notification is shown/.test(p)));
    // SC-524: branches on page state.
    const branching = check('[SC-524] Display error notification and reset loading state on education reset failure', `  // strategy: API_MOCK · evidence: API_RESPONSE + DOM
  await qa.intercept('GET', '/super-save/reset_education_manual', { statusCode: 500, body: {} }, 'resetFail');
  const resetBtn = page.getByRole('button', { name: 'Reset Education' });
  if (await resetBtn.isVisible()) { await resetBtn.click(); }
  await qa.expectRequestMade('resetFail');
  await qa.expectErrorShown();`);
    assert.equal(branching.executable, false);
    assert.ok(branching.problems.some((p) => /Branches on page state/.test(p)));
    // SC-543: sets up a failure it never triggers.
    const unexercised = check('[SC-543] Handle education reset failure with error notification and loading state reset', `  // strategy: UI · evidence: DOM
  await qa.intercept('GET', '/super-save/reset_education_manual', { statusCode: 500, body: {} }, 'resetFail');
  await page.goto('/education-management');
  await expect(page.getByRole('button', { name: 'Reset Education' })).toBeVisible();`);
    assert.equal(unexercised.executable, false);
    assert.ok(unexercised.problems.some((p) => /never shows the application requested it/.test(p)));
  });

  test('a variable declared twice, and a destructive page-object action without its own intercept, are blocked', () => {
    fs.writeFileSync(path.join(suite, 'pages', 'education-management.page.ts'), `import type { Page } from 'playwright/test';
export class EducationManagementPage {
  readonly locators = {} as const;
  constructor(readonly page: Page) {}
  async goto(): Promise<void> { await this.page.goto('/education-management'); }
  async clickApproveAll(): Promise<void> { await this.page.getByRole('button', { name: 'Approve All' }).click(); }
}
`);
    const body = `  // strategy: API_MOCK · evidence: API_RESPONSE + DOM
  const educationManagementPage = new EducationManagementPage(page);
  const educationManagementPage = new EducationManagementPage(page);
  await qa.intercept('POST', '/super-save/change_super_save_status', { statusCode: 500, body: {} }, 'networkErr');
  await educationManagementPage.goto();
  await educationManagementPage.clickApproveAll();
  await qa.expectRequestMade('networkErr');
  await qa.expectErrorShown();`;
    const src = `import { test, expect } from '../support/qa';
import { EducationManagementPage } from '../pages/education-management.page';
test('[SC-523] Display offline error toast on network error during education management actions', async ({ page, qa }) => {
${body}
});`;
    const t = preflightSpec('tests/e.spec.ts', src, ctx({ apiPaths: [...API, '/super-save/approve_all_education'], mockApi: false })).tests[0]!;
    assert.equal(t.gates.syntax_valid, false);
    assert.ok(t.problems.some((p) => /Declares educationManagementPage more than once/.test(p)));
    assert.equal(t.gates.safe_to_run, false);
    assert.ok(t.problems.some((p) => /Performs "click Approve All" against the real backend without intercepting that action's own request/.test(p)));
    // Intercepting approve_all_education itself makes it safe.
    const safe = preflightSpec('tests/e.spec.ts', src.replace(/  const educationManagementPage = new EducationManagementPage\(page\);\n/, '').replace("'POST', '/super-save/change_super_save_status'", "'GET', '/super-save/approve_all_education'"),
      ctx({ apiPaths: [...API, '/super-save/approve_all_education'], mockApi: false })).tests[0]!;
    assert.equal(safe.gates.safe_to_run, true, safe.problems.join(' | '));
  });

  test('case F: no reliable evidence of any kind is UNIMPLEMENTED with the strategies tried', () => {
    const d = notImplemented('tests/education-management.spec.ts', 'SC-999', 'Internal cache eviction', 'No observable effect.', {
      strategy: 'UNIMPLEMENTED',
      strategiesAttempted: [{ strategy: 'NETWORK', whyNot: 'no request is made' }, { strategy: 'UI', whyNot: 'nothing is shown' }],
    });
    assert.equal(d.executable, false);
    assert.equal(d.strategiesAttempted!.length, 2);
    const details2 = details({ preflight: [d] });
    const body = renderPrComment({ pr, run, details: details2, baseUrl: 'https://app.test', artifacts: linker });
    assert.match(body, /\| SC-999 Internal cache eviction \| UNIMPLEMENTED \| — \| ⚪ NOT IMPLEMENTED \| No observable effect\. \(tried NETWORK: no request is made; UI: nothing is shown\) \|/);
  });

  describe('tests blocked by preflight that can run', () => {
    const TITLE = '[SC-524] Display error notification and reset loading state on education reset failure';
    const BODY = `    // strategy: API_MOCK · evidence: API_RESPONSE + DOM
    await qa.intercept('GET', '/super-save/reset_education_manual', { statusCode: 500, body: {} }, 'resetEdu');
    await page.getByRole('button', { name: 'Reset Education' }).click();
    await qa.expectErrorShown();
    await qa.expectRequestMade('resetEdu');`;
    const withHook = (hook: string) => `import { test, expect } from '../support/qa';
test.describe('Education Management', () => {
  test.beforeEach(async ({ page, qa }) => {
${hook}
  });

  test('${TITLE}', async ({ page, qa }) => {
${BODY}
  });
});`;

    test('a click after the beforeEach opened the page is not "before opening any page"', () => {
      const [t] = preflightSpec('tests/e.spec.ts', withHook("    await page.goto('/education-management');"), ctx()).tests;
      assert.ok(!t!.problems.some((p) => /before opening any page/.test(p)), t!.problems.join(' | '));
      assert.ok(!t!.problems.some((p) => /never navigates/.test(p)), t!.problems.join(' | '));
    });

    test('a beforeEach that opens no page still leaves the click on about:blank', () => {
      const [t] = preflightSpec('tests/e.spec.ts', withHook("    await qa.expectNoAlert();"), ctx()).tests;
      assert.ok(t!.problems.some((p) => /before opening any page/.test(p)));
    });

    test('a beforeEach in another describe does not count', () => {
      const src = `import { test, expect } from '../support/qa';
test.describe('other', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/other'); });
});
test('${TITLE}', async ({ page, qa }) => {
${BODY}
});`;
      const [t] = preflightSpec('tests/e.spec.ts', src, ctx()).tests;
      assert.ok(t!.problems.some((p) => /before opening any page/.test(p)));
    });

    test('an intercepted load request triggered by page.reload() gets its missing check', () => {
      const output = {
        pageObjects: [], fixtures: [], notes: [], unimplemented: [], behaviorMap: [],
        specs: [{ fileName: 'e.spec.ts', feature: 'e', describe: 'e', imports: [], tests: [{
          scenarioId: 'SC-523', title: 'offline toast', tags: [],
          body: "await qa.intercept('GET', '/super-save/get_users_educations', { statusCode: 500, body: {} }, 'educations');\nawait page.reload();\nawait qa.expectErrorShown();",
        }] }],
      };
      const { output: repaired, repairs } = repairGeneratedOutput(output as never, { existingPageObjects: [], route: '/education-management' });
      assert.match(repaired.specs[0]!.tests[0]!.body, /await qa\.expectRequestMade\('educations'\);$/);
      assert.equal(repairs.length, 1);
      // Nothing after the intercept opens a page or acts: nothing is added.
      const idle = { ...output, specs: [{ ...output.specs[0]!, tests: [{ ...output.specs[0]!.tests[0]!, body: "await page.reload();\nawait qa.intercept('GET', '/x', { statusCode: 500, body: {} }, 'x');\nawait qa.expectErrorShown();" }] }] };
      assert.deepEqual(repairGeneratedOutput(idle as never, { existingPageObjects: [], route: null }).repairs, []);
    });

    test('a corrected attempt keeps the locators the first attempt\'s tests use', () => {
      const loc = (name: string) => ({ name, selector: `#${name}`, strategy: 'id', rationale: 'r' });
      const base = { fixtures: [], notes: [], unimplemented: [], behaviorMap: [], specs: [] };
      const merged = merge(
        { ...base, pageObjects: [{ className: 'EducationManagementPage', fileName: 'e.page.ts', locators: [loc('resetButton'), loc('saveButton')], methods: [] }] } as never,
        { ...base, pageObjects: [{ className: 'EducationManagementPage', fileName: 'e.page.ts', locators: [loc('cronSaveButton'), { ...loc('saveButton'), selector: '#save-v2' }], methods: [] }] } as never,
      );
      const locators = merged.pageObjects[0]!.locators;
      assert.deepEqual(locators.map((l) => l.name).sort(), ['cronSaveButton', 'resetButton', 'saveButton']);
      assert.equal(locators.find((l) => l.name === 'saveButton')!.selector, '#save-v2');
    });

    test('the corrected attempt is told how to fix each rejection', () => {
      const [t] = preflightSpec('tests/e.spec.ts', `import { test, expect } from '../support/qa';
test('[SC-529] Verify conditional refetch in EducationHistoryDialog and EducationManagementPage with user email and id checks', async ({ page, qa }) => {
  qa.observe('historyCall', 'GET', '/super-save/get_user_education_history');
  await page.goto('/education-management');
  await qa.expectRequestNotMade('historyCall');
});`, ctx()).tests;
      assert.match(describeDiagnostic(t!), /How to fix: .*perform the user action that runs the changed code/);
    });
  });

  describe('tests that ran but broke themselves', () => {
    test('clicking the first element of a tag is blocked', () => {
      const [t] = preflightSpec('tests/e.spec.ts', `import { test, expect } from '../support/qa';
test('[SC-523] Display offline error toast on network error during education management actions', async ({ page, qa }) => {
  await page.goto('/education-management');
  await qa.intercept('POST', '/super-save/change_super_save_status', { statusCode: 500, body: {} }, 'offlineError');
  await page.locator('button').first().click();
  await qa.expectErrorShown();
  await qa.expectRequestMade('offlineError');
});`, ctx()).tests;
      assert.equal(t!.executable, false);
      assert.ok(t!.problems.some((p) => /chosen by tag alone \(page\.locator\('button'\)\)/.test(p)), t!.problems.join(' | '));
      assert.match(describeDiagnostic(t!), /getByRole/);
      // A role with its name is fine.
      const [ok] = preflightSpec('tests/e.spec.ts', `import { test, expect } from '../support/qa';
test('[SC-080] Navigate to /education-management', async ({ page, qa }) => {
  await page.goto('/education-management');
  await page.getByRole('button', { name: 'Reset' }).click();
  await page.locator('button#reset').click();
  await qa.expectPath('/education-management');
});`, ctx()).tests;
      assert.ok(!ok!.problems.some((p) => /tag alone/.test(p)), ok!.problems.join(' | '));
    });

    test('the API evidence says which clicks, dialogs and confirmations send a request', () => {
      const PAGE = `
const Page = () => {
  const { confirmDialog } = useDialog();
  const educationResetDialogRef = useRef(null);
  const { mutateAsync: resetEducationManualApi } = useResetEducationManual();
  const { mutateAsync: approveEducationAllApi } = useApproveEducationAll();

  const handleReset = () => {
    educationResetDialogRef.current?.open();
  };

  const handleOnResetEducation = async (submitData: IEducationResetDialogSubmitData) => {
    try {
      confirmDialog({
        title: text("education_management_reset_confirm_title"),
        onOk: async () => {
          await resetEducationManualApi({ date: submitData.date });
        },
      });
    } catch (error) {
      toastError(error);
    }
  };

  const handleApprove = async () => {
    await approveEducationAllApi(null);
  };

  return (
    <div>
      <button id={htmlIds.approve} onClick={handleApprove}>
        <span>{text("education_management_action_approve_button")}</span>
      </button>
      <button id={htmlIds.reset} onClick={handleReset} disabled={loading}>
        <span>{text("education_management_action_reset_button")}</span>
      </button>
      <EducationResetDialog
        ref={educationResetDialogRef}
        onOk={handleOnResetEducation}
      />
    </div>
  );
};`;
      assert.deepEqual(triggerPath(PAGE, 'useResetEducationManual'), [
        'click the button labelled education_management_action_reset_button (id htmlIds.reset) (onClick={handleReset})',
        'fill in and submit EducationResetDialog (its onOk calls handleOnResetEducation)',
        'confirm the confirmation dialog',
      ]);
      assert.deepEqual(triggerPath(PAGE, 'useApproveEducationAll'), [
        'click the button labelled education_management_action_approve_button (id htmlIds.approve) (onClick={handleApprove})',
      ]);
      assert.equal(triggerPath(PAGE, 'useNotUsedHere'), null);
    });
  });
});
