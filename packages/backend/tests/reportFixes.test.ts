/**
 * Fixes from the PR #2577 report: preflight rejections that were wrong, one
 * loophole that let a vacuous test through, a page-object method that could
 * only crash, and duplicate scenarios reported as "not implemented".
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, describe, before, after } from 'node:test';

process.env.DATABASE_URL = 'sqlite::memory:';

const { preflightSpec, readPageObjects } = await import('../src/playwright/preflight.js');
const { QA_HELPERS } = await import('../src/playwright/scaffold.js');
const { runMigrations } = await import('../src/db/migrate.js');
const { createProject } = await import('../src/db/repos/projects.js');
const { upsertScenarios, collapseDuplicateScenarios, listScenarios } = await import('../src/knowledge/store.js');
type PreflightContext = import('../src/playwright/preflight.js').PreflightContext;

const suite = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-report-fixes-'));
for (const d of ['tests', 'pages', 'support']) fs.mkdirSync(path.join(suite, d), { recursive: true });
fs.writeFileSync(path.join(suite, 'support', 'qa.ts'), 'export const test = base.extend<{ qa: Qa; qaEvidence: void }>({});\n');
before(async () => { await runMigrations(); });
after(() => fs.rmSync(suite, { recursive: true, force: true }));

const API = ['/super-save/get_user_details', '/super-save/get_user_education_history', '/super-save/get_users_educations', '/super-save/reset_education_manual'];
const SCENARIOS: PreflightContext['scenarios'] = {
  'SC-523': { title: 'Display offline error toast on network error during education management actions', expectedResult: 'An offline error toast notification appears with the localized message.' },
  'SC-542': { title: 'Trigger offline error toast on network error in education management', expectedResult: "toast.error is called with 'super_save_user_community_offline_error' and autoClose set to 1500" },
  'SC-530': { title: 'Verify Promise.all refetch execution in EducationHistoryDialog when user fields are present', expectedResult: 'Both user details and history are refetched.' },
  'SC-545': { title: 'Verify conditional refetch in handleOnSaveSuperSave with user email and id checks', expectedResult: 'refresh() is skipped when user_email or user_id is missing.' },
};
const ctx = (): PreflightContext => ({
  suiteRoot: suite, pageObjects: readPageObjects(path.join(suite, 'pages')), qaHelpers: QA_HELPERS, scenarios: SCENARIOS,
  changedTerms: ['user_email', 'user_id', 'EducationHistoryDialog'], apiPaths: API, mockApi: false,
});
const check = (id: string, body: string, imports = '') => preflightSpec('tests/e.spec.ts', `import { test, expect } from '../support/qa';
${imports}
test('[${id}] ${SCENARIOS[id]?.title ?? id}', async ({ page, qa }) => {
${body}
});`, ctx()).tests[0]!;

describe('preflight rejections that were wrong', () => {
  test('"on a network error" is the trigger: a toast test asserting the error is valid', () => {
    const t = check('SC-523', `  // strategy: API_MOCK · evidence: API_RESPONSE + DOM
  await qa.intercept('GET', '/super-save/get_users_educations', { statusCode: 500, body: { message: 'Network Error' } }, 'list');
  await page.goto('/education-management');
  await qa.waitFor('list');
  await qa.expectErrorShown();`);
    assert.deepEqual(t.problems, []);
    assert.equal(t.executable, true);
  });

  test('a translation key in the expected result is not a data field the test must use', () => {
    const t = check('SC-542', `  // strategy: API_MOCK · evidence: API_RESPONSE + DOM
  await qa.intercept('GET', '/super-save/get_users_educations', { statusCode: 500, body: { code: 'ERR_NETWORK' } }, 'list');
  await page.goto('/education-management');
  await qa.waitFor('list');
  await qa.expectErrorShown();`);
    assert.ok(!t.problems.some((p) => /super_save_user_community_offline_error/.test(p)), t.problems.join(' | '));
    assert.equal(t.executable, true);
  });

  test('a valid network test declared under a neighbouring strategy is relabelled, not blocked', () => {
    const t = check('SC-530', `  // strategy: API_MOCK · evidence: API_RESPONSE + UI_ACTION + NETWORK
  qa.observe('history', 'GET', '/get_user_education_history');
  await page.goto('/education-management');
  await page.getByRole('button', { name: 'View History' }).first().click();
  await qa.expectRequestMade('history');`);
    assert.deepEqual(t.problems, []);
    assert.equal(t.strategy, 'UI_AND_NETWORK');
    assert.equal(t.executable, true);
  });
});

describe('loopholes', () => {
  test('"no request was made" with no action that could make one is vacuous', () => {
    const t = check('SC-545', `  // strategy: API_MOCK · evidence: API_RESPONSE + NETWORK
  qa.observe('details', 'GET', '/get_user_details');
  await page.goto('/education-management');
  await qa.expectRequestNotMade('details');`);
    assert.equal(t.executable, false);
    assert.ok(t.problems.some((p) => /without performing any action/.test(p)));
  });

  test('a page-object method using a locator its class does not define is caught before it crashes', () => {
    fs.writeFileSync(path.join(suite, 'pages', 'education-management.page.ts'), `import type { Page } from 'playwright/test';
export class EducationManagementPage {
  readonly locators = { resetButton: 'Reset Education' } as const;
  constructor(readonly page: Page) {}
  el(name: string) { return this.page.getByText(name); }
  async clickResetEducation(): Promise<void> { await this.el('resetEducationButton').click(); }
}
`);
    const t = check('SC-523', `  // strategy: API_MOCK · evidence: API_RESPONSE + DOM
  const educationManagementPage = new EducationManagementPage(page);
  await qa.intercept('GET', '/super-save/reset_education_manual', { statusCode: 500, body: {} }, 'resetFail');
  await page.goto('/education-management');
  await educationManagementPage.clickResetEducation();
  await qa.expectRequestMade('resetFail');
  await qa.expectErrorShown();`, "import { EducationManagementPage } from '../pages/education-management.page';");
    assert.equal(t.gates.page_objects_valid, false);
    assert.ok(t.problems.some((p) => /clickResetEducation\(\) uses locator "resetEducationButton", which EducationManagementPage does not define/.test(p)));
  });
});

describe('false passes from the second PR #2577 run', () => {
  test('asserting a request the page makes on every load is not evidence of the behaviour', () => {
    // SC-545 as generated: observe the list, open the page, assert the list was requested.
    const t = check('SC-545', `  // strategy: API_MOCK · evidence: API_RESPONSE + NETWORK
  await qa.observe('getEdu', 'GET', '/super-save/get_users_educations'); await page.goto('/education-management'); await qa.expectRequestMade('getEdu');`);
    assert.equal(t.executable, false);
    assert.equal(t.gates.strategy_valid, false);
  });

  test('clicking before any page is open is caught', () => {
    // SC-523 as generated: the click happens on about:blank.
    const t = check('SC-523', `  // strategy: API_MOCK · evidence: API_RESPONSE + DOM
  await qa.intercept('GET', '/super-save/reset_education_manual', { statusCode: 500, body: {} }, 'resetErr');
  await page.getByRole('button', { name: 'Reset Education' }).click();
  await qa.expectRequestMade('resetErr');
  await qa.expectErrorShown();`);
    assert.ok(t.problems.some((p) => /before opening any page/.test(p)), t.problems.join(' | '));
    assert.equal(t.executable, false);
  });

  test('a controlled response that is triggered but never checked gets the check added', async () => {
    const { repairGeneratedOutput } = await import('../src/playwright/repairGenerated.js');
    const output = { pageObjects: [], fixtures: [], reusedExistingArtifacts: [], notes: [], behaviorMap: [], unimplemented: [],
      specs: [{ fileName: 'e.spec.ts', feature: 'education-management', describe: 'x', imports: [], tests: [{ scenarioId: 'SC-543', title: 't', tags: [],
        body: "await qa.intercept('GET', '/super-save/reset_education_manual', { statusCode: 500, body: {} }, 'resetFail');\nawait page.goto('/education-management');\nawait page.getByRole('button', { name: 'Reset Education' }).click();\nawait qa.expectErrorShown();" }] }] };
    const { output: repaired, repairs } = repairGeneratedOutput(output as never, { existingPageObjects: [], route: null });
    assert.match(repaired.specs[0]!.tests[0]!.body, /await qa\.expectRequestMade\('resetFail'\);$/);
    assert.equal(repairs.length, 1);
  });
});

describe('third PR #2577 run', () => {
  test('a scenario blocked in one spec is never run through a valid copy in another', async () => {
    const { executionPlan } = await import('../src/pipeline/generation.js');
    const valid = check('SC-530', `  qa.observe('history', 'GET', '/get_user_education_history');
  await page.goto('/education-management');
  await page.getByRole('button', { name: 'View History' }).first().click();
  await qa.expectRequestMade('history');`);
    const blocked = { ...valid, specFile: 'tests/other.spec.ts', executable: false, problems: ['blocked'] };
    const plan = executionPlan([{ specFile: 'tests/e.spec.ts', fileProblems: [], tests: [valid] }, { specFile: 'tests/other.spec.ts', fileProblems: [], tests: [blocked] }]);
    assert.equal(plan.grep, null, 'SC-530 is not selected at all');
    assert.deepEqual(plan.specs, []);
  });

  test('clicking a control that saves data needs that request intercepted', () => {
    const t = check('SC-530', `  qa.observe('userDetails', 'GET', '/get_user_details');
  await page.goto('/education-management');
  await page.getByRole('button', { name: 'Super Save' }).click();
  await qa.expectRequestMade('userDetails');`);
    assert.equal(t.gates.safe_to_run, false);
  });

  test('a skip guard that only hides an intercept-based test is removed', async () => {
    const { repairGeneratedOutput } = await import('../src/playwright/repairGenerated.js');
    const body = "test.skip(!qa.mockApi, 'Requires API mocking');\nawait qa.intercept('GET', '/get_users_educations', { statusCode: 200, body: {} }, 'list');\nawait page.goto('/education-management');";
    const out = repairGeneratedOutput({ pageObjects: [], fixtures: [], reusedExistingArtifacts: [], notes: [], behaviorMap: [], unimplemented: [],
      specs: [{ fileName: 'e.spec.ts', feature: 'x', describe: 'x', imports: [], tests: [{ scenarioId: 'SC-529', title: 't', tags: [], body }] }] } as never, { existingPageObjects: [], route: null });
    assert.doesNotMatch(out.output.specs[0]!.tests[0]!.body, /test\.skip/);
  });

  test('one spec per feature: a spec under another name covering the same scenarios is superseded', async () => {
    const { writeGeneratedSuite } = await import('../src/playwright/codegen.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-onespec-'));
    const layout = { root, testsDir: path.join(root, 'tests'), pagesDir: path.join(root, 'pages'), fixturesDir: path.join(root, 'fixtures'), supportDir: path.join(root, 'support'), utilsDir: path.join(root, 'utils'), artifactsDir: root, runsDir: root, screenshotsDir: root };
    for (const d of [layout.testsDir, layout.pagesDir, layout.fixturesDir]) fs.mkdirSync(d, { recursive: true });
    const spec = (fileName: string) => ({ pageObjects: [], fixtures: [], reusedExistingArtifacts: [], notes: [], behaviorMap: [], unimplemented: [],
      specs: [{ fileName, feature: 'Education Management', describe: 'x', imports: [], tests: [
        { scenarioId: 'SC-080', title: 'Navigate', tags: [], body: "await page.goto('/education-management');\nawait expect(page).toHaveURL(/education/);" }] }] });
    writeGeneratedSuite(layout as never, 'education-management', spec('education-management.spec.ts') as never);
    writeGeneratedSuite(layout as never, 'education-management', spec('educationManagement.spec.ts') as never);
    assert.deepEqual(fs.readdirSync(layout.testsDir), ['education-management.spec.ts']);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('duplicate scenarios', () => {
  test('rephrased repeats collapse into the original instead of being reported as not implemented', async () => {
    const project = await createProject({ name: 'dup', repoUrl: '/tmp/dup-repo', branch: 'main' });
    const base = { feature: 'education-management', category: 'regression' as const, description: '', preconditions: [], steps: ['s'],
      businessRuleIds: [], sourceEvidence: [], confidence: 0.8, priority: 'high' as const, relatedTestIds: [], approvalState: 'ai_generated' as const };
    await upsertScenarios(project.id, 'c1', [{ ...base, title: 'Verify conditional refetch in handleOnSaveSuperSave with user email and id checks', expectedResult: 'refresh is skipped.' }]);
    // A later run, same scenario, slightly different wording: no new id.
    const again = await upsertScenarios(project.id, 'c2', [{ ...base, title: 'Verify conditional refetch in handleOnSaveSuperSave with user email and id check', expectedResult: 'educationHistoryDialogRef.current?.refresh() is skipped.' }]);
    assert.equal(again.created.length, 0);
    assert.equal((await listScenarios(project.id)).length, 1);
    // Duplicates already stored are collapsed into the oldest.
    await upsertScenarios(project.id, 'c3', [{ ...base, category: 'error_handling' as const, title: 'Display offline error toast on network error during education management actions', expectedResult: 'a' }]);
    const dropped = await collapseDuplicateScenarios(project.id, 'education-management');
    assert.deepEqual(dropped, []);
    assert.equal((await listScenarios(project.id)).length, 2);
  });
});
