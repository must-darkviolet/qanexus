/**
 * Healing: a test preflight rejects, or one that broke by itself, is corrected
 * and checked again instead of being reported as a test bug.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, describe, after } from 'node:test';

process.env.DATABASE_URL = 'sqlite::memory:';
process.env.AI_DISABLED = '1';

const { brokeByItself, renderTest, spliceTest, healTests } = await import('../src/pipeline/heal.js');
const { preflightSpec, readPageObjects } = await import('../src/playwright/preflight.js');
const { QA_HELPERS } = await import('../src/playwright/scaffold.js');

const suite = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-heal-'));
after(() => fs.rmSync(suite, { recursive: true, force: true }));
for (const d of ['tests', 'pages', 'support']) fs.mkdirSync(path.join(suite, d), { recursive: true });
fs.writeFileSync(path.join(suite, 'support', 'qa.ts'), 'export const test = base.extend<{ qa: Qa; qaEvidence: void }>({});\n');
fs.writeFileSync(path.join(suite, 'pages', 'education-management.flows.ts'), `import type { Page } from 'playwright/test';
export class EducationManagementFlows {
  constructor(readonly page: Page, readonly qa: Qa) {}
  async superSaveInRowConfirm(opts = {}): Promise<void> {}
  async viewHistoryInRowSuperSaveConfirm(opts = {}): Promise<void> {}
}
`);

const SPEC = `import { test, expect } from '../support/qa';

test.describe('Education Management', () => {
  test('[SC-080] Navigate to /education-management', async ({ page, qa }) => {
    await page.goto('/education-management');
    await qa.expectPath('/education-management');
  });

  test('[SC-578] handleOnSaveSuperSave skips the history dialog refresh when user_email or user_id is missing', async ({ page, qa }) => {
    // strategy: NETWORK
    await page.goto('/education-management');
    qa.observe('details', 'GET', '/super-save/get_user_details');
    await qa.expectRequestNotMade('details');
  });
});
`;

const TRIGGERS = [{
  paths: ['/super-save/get_user_details'], method: 'GET', steps: 2, summary: 'switch -> confirm',
  flows: ['superSaveInRowConfirm', 'viewHistoryInRowSuperSaveConfirm'],
  aliases: { superSaveInRowConfirm: ['change_super_save_status'], viewHistoryInRowSuperSaveConfirm: ['change_super_save_status'] },
  conditions: {
    superSaveInRowConfirm: ['handleOnSaveSuperSave: selectedUserForHistory?.user_email && selectedUserForHistory?.user_id'],
    viewHistoryInRowSuperSaveConfirm: ['handleOnSaveSuperSave: selectedUserForHistory?.user_email && selectedUserForHistory?.user_id'],
  },
  expected: {
    superSaveInRowConfirm: { sent: false, why: 'NOT expected in this journey: nothing in this journey sets selectedUserForHistory' },
    viewHistoryInRowSuperSaveConfirm: { sent: true, why: 'expected in this journey: selectedUserForHistory is set by handleViewHistory' },
  },
  proven: {},
}];

describe('healing', () => {
  test('a test that broke by itself is told apart from one that found a problem', () => {
    const r = (errorMessage: string) => ({ errorMessage }) as never;
    assert.equal(brokeByItself(r('ReferenceError: educationManagementPage is not defined')), true);
    assert.equal(brokeByItself(r("Error: strict mode violation: getByRole('button') resolved to 2 elements")), true);
    assert.equal(brokeByItself(r('Error: Flow superSaveInRowConfirm did not complete: step 1 (...)')), true);
    assert.equal(brokeByItself(r("TimeoutError: locator.click: Timeout 8000ms exceeded.\nwaiting for getByRole('button', { name: 'Reset' })")), true);
    // An assertion about the application is a finding, never healed.
    assert.equal(brokeByItself(r('Error: expected no request aliased "details" after the flow\'s final step')), false);
    assert.equal(brokeByItself(r('Error: expect(locator).toBeVisible() failed')), false);
  });

  test('a corrected test replaces the old one in its spec, with what it uses imported and constructed', () => {
    const pos = readPageObjects(path.join(suite, 'pages'));
    const { code, uses } = renderTest({ scenarioId: 'SC-578', title: 'Row switch does not refresh', body: "await educationManagementFlows.superSaveInRowConfirm();\nawait qa.expectRequestMade('change_super_save_status');", strategy: 'UI_AND_NETWORK' }, pos);
    const out = spliceTest(SPEC, 'SC-578', code, uses);
    assert.match(out, /import \{ EducationManagementFlows \} from '\.\.\/pages\/education-management\.flows';/);
    assert.match(out, /test\('\[SC-578\] Row switch does not refresh', async \(\{ page, qa \}\) => \{\n {4}\/\/ strategy: UI_AND_NETWORK\n {4}const educationManagementFlows = new EducationManagementFlows\(page, qa\);/);
    assert.doesNotMatch(out, /expectRequestNotMade\('details'\)/);
    assert.match(out, /\[SC-080\] Navigate/, 'the other tests are untouched');
    // A scenario with no test yet is added inside the describe.
    const added = spliceTest(SPEC, 'SC-999', "  test('[SC-999] New', async ({ page, qa }) => {\n    await page.goto('/');\n  });", []);
    assert.match(added, /\[SC-999\] New[\s\S]*\n\}\);\n$/);
  });

  test('a condition test preflight rejects is healed from the traced journeys, and passes preflight', async () => {
    fs.writeFileSync(path.join(suite, 'tests', 'education-management.spec.ts'), SPEC);
    const ctx = {
      suiteRoot: suite, pageObjects: readPageObjects(path.join(suite, 'pages')), qaHelpers: QA_HELPERS, changedTerms: [],
      scenarios: { 'SC-578': { title: 'handleOnSaveSuperSave skips the history dialog refresh when user_email or user_id is missing' } },
      triggers: TRIGGERS,
    };
    const before = preflightSpec('tests/education-management.spec.ts', SPEC, ctx).tests.find((t) => t.scenarioId === 'SC-578')!;
    assert.equal(before.executable, false);
    const outcomes = await healTests({
      layout: { root: suite, pagesDir: path.join(suite, 'pages') } as never,
      inputFor: () => null,
      scenario: (id) => (id === 'SC-578' ? { id, title: 'handleOnSaveSuperSave skips the history dialog refresh when user_email or user_id is missing', expectedResult: 'refresh is not called' } as never : undefined),
      preflight: ctx as never,
      flowsInstanceFor: () => 'educationManagementFlows',
    }, [{ specFile: 'tests/education-management.spec.ts', scenarioId: 'SC-578', kind: 'preflight', diagnostic: before }]);
    assert.deepEqual(outcomes.map((o) => [o.scenarioId, o.healed]), [['SC-578', true]]);
    assert.match(outcomes[0]!.how, /superSaveInRowConfirm/);
    const healed = fs.readFileSync(path.join(suite, 'tests', 'education-management.spec.ts'), 'utf8');
    assert.match(healed, /await educationManagementFlows\.superSaveInRowConfirm\(\);\n {4}await qa\.expectRequestNotMadeAfterFlow\('observed_get_user_details'\);/);
    const after_ = preflightSpec('tests/education-management.spec.ts', healed, { ...ctx, pageObjects: readPageObjects(path.join(suite, 'pages')) }).tests;
    assert.ok(after_.every((t) => t.executable), after_.map((t) => `${t.scenarioId}: ${t.problems.join(' | ')}`).join('\n'));
  });

  test('a selector string asserted as if it were a locator, and an empty catch, are repaired - and an empty catch is rejected', async () => {
    const { repairGeneratedOutput } = await import('../src/playwright/repairGenerated.js');
    const output = { pageObjects: [], fixtures: [], notes: [], unimplemented: [], behaviorMap: [], specs: [{ fileName: 'x', feature: 'x', describe: 'x', imports: [], tests: [{
      scenarioId: 'SC-111', title: 'Click copy icon button', tags: [],
      body: "await page.goto('/users/user-details');\nawait expect('[aria-label=\"copy icon\"]').toBeVisible();\ntry {\n  await educationManagementFlows.superSaveInRowConfirm();\n} catch (e) {}\nawait qa.expectRequestMade('change_super_save_status');",
    }] }] };
    const { output: fixed, repairs } = repairGeneratedOutput(output as never, { existingPageObjects: [], route: null });
    const body = fixed.specs[0]!.tests[0]!.body;
    assert.match(body, /await expect\(page\.locator\('\[aria-label="copy icon"\]'\)\)\.toBeVisible\(\);/);
    assert.match(body, /\nawait educationManagementFlows\.superSaveInRowConfirm\(\);\nawait qa\.expectRequestMade/);
    assert.doesNotMatch(body, /try|catch/);
    assert.equal(repairs.length, 2);
    assert.equal(brokeByItself({ errorMessage: 'Error: toBeVisible can be only used with Locator object, was called with [aria-label="copy icon"]' } as never), true);
    const [swallowing] = preflightSpec('tests/e.spec.ts', `import { test, expect } from '../support/qa';
test('[SC-578] x', async ({ page, qa }) => {
  await page.goto('/education-management');
  await page.getByRole('button', { name: 'Reset' }).click().catch(() => {});
  await expect(page.getByText('Done')).toBeVisible();
});`, { suiteRoot: suite, pageObjects: [], qaHelpers: QA_HELPERS, scenarios: {}, changedTerms: [] }).tests;
    assert.equal(swallowing!.executable, false);
    assert.ok(swallowing!.problems.some((p) => /Swallows errors/.test(p)));
  });

  test('a test missing a journey\'s steps is refactored onto the journey, keeping its set-up and assertions', async () => {
    const { refactorOntoFlow } = await import('../src/pipeline/heal.js');
    const testCode = `test('[SC-523] Offline toast on approve', async ({ page, qa }) => {
    // strategy: API_MOCK
    await qa.intercept('GET', '/super-save/approve_all_education', { statusCode: 500, body: { code: 'ERR_NETWORK' } }, 'approve');
    await page.goto('/education-management');
    await page.getByRole('button', { name: 'Approve All' }).click();
    await qa.expectRequestMade('approve');
    await qa.expectErrorShown();
  });`;
    const diagnostic = { problems: ['Expects /super-save/approve_all_education, which the application sends only after the user: click the button "Approve All" -> confirm "Approve Education?" with "Yes". The test performs 1 of these 2 steps, so the request is never sent - call approveAllConfirm instead.'] } as never;
    const triggers = [{ paths: ['/super-save/approve_all_education'], steps: 2, summary: '', flows: ['approveAllConfirm'], proven: { approveAllConfirm: true } }] as never;
    const out = refactorOntoFlow(testCode, diagnostic, triggers, 'educationManagementFlows')!;
    assert.equal(out.flow, 'approveAllConfirm');
    assert.equal(out.body, [
      '// strategy: API_MOCK',
      "await qa.intercept('GET', '/super-save/approve_all_education', { statusCode: 500, body: { code: 'ERR_NETWORK' } }, 'approve');",
      'await educationManagementFlows.approveAllConfirm();',
      "await qa.expectRequestMade('approve');",
      'await qa.expectErrorShown();',
    ].join('\n'));
  });

  test('an error scenario is written from the journey it is about, with its request failing', async () => {
    const { synthesizeErrorTest } = await import('../src/pipeline/conditionTests.js');
    const triggers = [
      { paths: ['/super-save/reset_education_manual'], method: 'GET', steps: 3, summary: 'click the button "Reset Education" -> complete the form -> confirm "Reset Education?"', flows: ['resetEducationSubmitConfirm'], aliases: { resetEducationSubmitConfirm: ['reset_education_manual'] }, conditions: { resetEducationSubmitConfirm: [] }, expected: {}, proven: { resetEducationSubmitConfirm: true } },
      { paths: ['/super-save/approve_all_education'], method: 'GET', steps: 2, summary: 'click the button "Approve All" -> confirm "Approve Education?"', flows: ['approveAllConfirm'], aliases: { approveAllConfirm: ['approve_all_education'] }, conditions: { approveAllConfirm: [] }, expected: {}, proven: { approveAllConfirm: true } },
    ] as never;
    const t = synthesizeErrorTest('Handle education reset failure with error notification and loading state reset — toastError(error) is executed', triggers, 'educationManagementFlows')!;
    assert.equal(t.flow, 'resetEducationSubmitConfirm');
    assert.match(t.body, /await educationManagementFlows\.resetEducationSubmitConfirm\(\{ respond: \{ reset_education_manual: \{ statusCode: 500/);
    assert.match(t.body, /await qa\.expectRequestMadeAfterFlow\('reset_education_manual'\);\nawait qa\.expectErrorShown\(\);$/);
    const offline = synthesizeErrorTest('Display offline error toast on network error when approving all', triggers, 'educationManagementFlows')!;
    assert.equal(offline.flow, 'approveAllConfirm');
    assert.match(offline.body, /ERR_NETWORK/);
    // Not about an error: nothing is written.
    assert.equal(synthesizeErrorTest('Navigate to /education-management', triggers, 'educationManagementFlows'), null);
  });

  test('a journey that failed its live proof is swapped for the proven one, and qa.stub for qa.intercept', async () => {
    const triggers = [{
      ...TRIGGERS[0]!, flows: ['viewHistoryInRowSuperSaveConfirm', 'viewHistoryInRowSuperSaveSubmit'],
      aliases: { viewHistoryInRowSuperSaveConfirm: [], viewHistoryInRowSuperSaveSubmit: [] },
      conditions: { viewHistoryInRowSuperSaveConfirm: [], viewHistoryInRowSuperSaveSubmit: [] },
      expected: { viewHistoryInRowSuperSaveConfirm: { sent: true, why: '' }, viewHistoryInRowSuperSaveSubmit: { sent: true, why: '' } },
      proven: { viewHistoryInRowSuperSaveConfirm: false, viewHistoryInRowSuperSaveSubmit: true },
      proofFailures: { viewHistoryInRowSuperSaveConfirm: 'the next step never appeared: confirm "Super Save" (row 11)' },
    }];
    fs.writeFileSync(path.join(suite, 'pages', 'education-management.flows.ts'), `import type { Page } from 'playwright/test';
export class EducationManagementFlows {
  constructor(readonly page: Page, readonly qa: Qa) {}
  async viewHistoryInRowSuperSaveConfirm(opts = {}): Promise<void> {}
  async viewHistoryInRowSuperSaveSubmit(opts = {}): Promise<void> {}
}
`);
    const spec = `import { test, expect } from '../support/qa';
import { EducationManagementFlows } from '../pages/education-management.flows';

test.describe('Education Management', () => {
  test('[SC-579] The dialog refresh runs after saving', async ({ page, qa }) => {
    // strategy: UI_AND_NETWORK
    const educationManagementFlows = new EducationManagementFlows(page, qa);
    qa.observe('details', 'GET', '/super-save/get_user_details');
    await educationManagementFlows.viewHistoryInRowSuperSaveConfirm();
    await qa.expectRequestMadeAfterFlow('details');
  });

  test('[SC-109] User details are requested after saving', async ({ page, qa }) => {
    // strategy: API_MOCK
    const educationManagementFlows = new EducationManagementFlows(page, qa);
    await qa.stub('GET', '/super-save/get_user_details', { statusCode: 200, body: {} }, 'details');
    await educationManagementFlows.viewHistoryInRowSuperSaveSubmit();
    await qa.expectRequestMadeAfterFlow('details');
  });
});
`;
    fs.writeFileSync(path.join(suite, 'tests', 'education-management.spec.ts'), spec);
    const ctx = { suiteRoot: suite, pageObjects: readPageObjects(path.join(suite, 'pages')), qaHelpers: QA_HELPERS, changedTerms: [], scenarios: {}, triggers, mockApi: false };
    const blocked = preflightSpec('tests/education-management.spec.ts', spec, ctx).tests.filter((t) => !t.executable);
    assert.deepEqual(blocked.map((t) => t.scenarioId).sort(), ['SC-109', 'SC-579']);
    assert.ok(blocked.find((t) => t.scenarioId === 'SC-579')!.problems.some((p) => /failed its live proof .* - use viewHistoryInRowSuperSaveSubmit/.test(p)));
    const outcomes = await healTests({
      layout: { root: suite, pagesDir: path.join(suite, 'pages') } as never, inputFor: () => null,
      scenario: (id) => ({ id, title: id, expectedResult: '' }) as never, preflight: ctx as never, flowsInstanceFor: () => 'educationManagementFlows',
    }, blocked.map((t) => ({ specFile: 'tests/education-management.spec.ts', scenarioId: t.scenarioId!, kind: 'preflight' as const, diagnostic: t })));
    assert.deepEqual(outcomes.map((o) => [o.scenarioId, o.healed]).sort(), [['SC-109', true], ['SC-579', true]]);
    const healed = fs.readFileSync(path.join(suite, 'tests', 'education-management.spec.ts'), 'utf8');
    assert.match(healed, /\[SC-579\][\s\S]*?educationManagementFlows\.viewHistoryInRowSuperSaveSubmit\(\);/);
    assert.match(healed, /\[SC-109\][\s\S]*?await qa\.intercept\('GET'/);
    assert.doesNotMatch(healed, /qa\.stub|test\.skip\(!qa\.mockApi/);
  });
});
