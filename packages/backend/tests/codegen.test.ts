/**
 * Quality gate for generated Playwright code: blocking rules keep a spec from
 * being written, warnings are reported but do not block.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, describe } from 'node:test';
import type { TestGeneratorOutput } from '@qa-agent/shared';
import { lintGeneratedSource, writeGeneratedSuite } from '../src/playwright/codegen.js';
import type { SuiteLayout } from '../src/playwright/scaffold.js';

const spec = (body: string) => `import { test, expect } from '../support/qa';

test.describe('tasks', () => {
  test('[SC-1] creates a task', async ({ page, qa }) => {
${body}
  });
});
`;

const lint = (body: string) => lintGeneratedSource('tests/tasks.spec.ts', spec(body));
const rules = (body: string, severity: 'error' | 'warning') =>
  lint(body).filter((i) => i.severity === severity).map((i) => i.rule);

describe('generated code lint: clean code', () => {
  test('a clean spec using the suite helpers passes', () => {
    const issues = lint([
      "    await qa.stub('POST', '/api/tasks', { statusCode: 201, body: { id: 1 } }, 'create');",
      "    await page.goto('/tasks/new');",
      "    await qa.fill('[data-testid=\"title\"]', 'Write the report');",
      "    await page.getByRole('button', { name: 'Save' }).click();",
      "    await qa.waitFor('create');",
      "    await expect.poll(() => page.url(), { timeout: 15000 }).toContain('/tasks');",
      "    await expect(page.getByTestId('task-row').nth(1)).toBeVisible({ timeout: 10_000 });",
      "    test.setTimeout(60000);",
    ].join('\n'));
    assert.deepEqual(issues, []);
  });

  test('rules do not fire on comments', () => {
    const issues = lint([
      '    // never page.waitForTimeout(1000) or { force: true } here, and no test.only(',
      "    /* xpath: '//div[@id]' */",
      "    await page.goto('/tasks');",
    ].join('\n'));
    assert.deepEqual(issues, []);
  });

  test('non-code files are not linted', () => {
    assert.deepEqual(lintGeneratedSource('fixtures/a.json', '{"timeout": 99999}'), []);
  });
});

describe('generated code lint: blocking rules', () => {
  test('no-hard-wait: waitForTimeout and setTimeout sleeps', () => {
    assert.deepEqual(rules('    await page.waitForTimeout(2000);', 'error'), ['no-hard-wait']);
    assert.deepEqual(rules('    await new Promise((r) => setTimeout(r, 500));', 'error'), ['no-hard-wait']);
  });

  test('no-only: test.only, describe.only, test.describe.only', () => {
    assert.deepEqual(rules("    test.only('x', async () => {});", 'error'), ['no-only']);
    assert.deepEqual(rules("    test.describe.only('x', () => {});", 'error'), ['no-only']);
    assert.deepEqual(rules("    describe.only('x', () => {});", 'error'), ['no-only']);
  });

  test('no-force: blocked unless justified by a qa-allow-force comment', () => {
    assert.deepEqual(rules("    await page.getByTestId('x').click({ force: true });", 'error'), ['no-force']);
    assert.deepEqual(rules("    await page.getByTestId('x').check({ force: true });", 'error'), ['no-force']);
    assert.deepEqual(rules("    await page.getByTestId('x').click({ force: true }); // qa-allow-force: covered by a toast by design", 'error'), []);
    assert.deepEqual(rules([
      '    // qa-allow-force: the native input is visually hidden behind a styled label',
      "    await page.getByTestId('x').check({ force: true });",
    ].join('\n'), 'error'), []);
    // A marker without a reason does not count.
    assert.deepEqual(rules("    await page.getByTestId('x').click({ force: true }); // qa-allow-force:", 'error'), ['no-force']);
  });

  test('no-xpath: xpath= and // selectors', () => {
    assert.deepEqual(rules("    await page.locator('//div[@id=\"a\"]').click();", 'error'), ['no-xpath']);
    assert.deepEqual(rules("    await page.locator('xpath=/html/body/div').click();", 'error'), ['no-xpath']);
    assert.deepEqual(rules("    await page.goto('https://example.com/tasks');", 'error'), []);
  });

  test('no-serial: describe.serial and configure({ mode: serial })', () => {
    assert.deepEqual(rules("    test.describe.serial('x', () => {});", 'error'), ['no-serial']);
    assert.deepEqual(rules("    test.describe.configure({ mode: 'serial' });", 'error'), ['no-serial']);
    assert.deepEqual(rules("    test.describe.configure({ mode: 'parallel' });", 'error'), []);
  });

  test('no-long-timeout: step timeouts above 30s', () => {
    assert.deepEqual(rules("    await page.getByTestId('x').click({ timeout: 60000 });", 'error'), ['no-long-timeout']);
    assert.deepEqual(rules("    await expect(page.getByTestId('x')).toBeVisible({ timeout: 45_000 });", 'error'), ['no-long-timeout']);
    assert.deepEqual(rules("    await expect(page.getByTestId('x')).toBeVisible({ timeout: 30000 });", 'error'), []);
  });

  test('issues carry the line number', () => {
    const issue = lint('    await page.goto(\'/\');\n    await page.waitForTimeout(100);').find((i) => i.rule === 'no-hard-wait');
    assert.equal(issue?.line, 6);
  });
});

describe('generated code lint: warnings', () => {
  test('positional selectors', () => {
    assert.deepEqual(rules("    await page.locator('ul > li:nth-child(3)').click();", 'warning'), ['fragile-nth-selector']);
    assert.deepEqual(rules("    await page.locator('li').nth(2).click();", 'warning'), ['fragile-nth-index']);
  });

  test('generated class names and long CSS chains', () => {
    assert.deepEqual(rules("    await page.locator('.css-1x2y3z4').click();", 'warning'), ['fragile-generated-class']);
    assert.deepEqual(rules("    await page.locator('[class*=\"Button_root\"]').click();", 'warning'), ['fragile-generated-class']);
    assert.deepEqual(rules("    await page.locator('#app .main div.card ul li a').click();", 'warning'), ['fragile-css-chain']);
  });

  test('long exact copy in text selectors', () => {
    assert.deepEqual(
      rules("    await expect(page.getByText('Your task has been created successfully and saved to the list')).toBeVisible();", 'warning'),
      ['fragile-long-text'],
    );
  });

  test('conditional assertions stay a warning', () => {
    assert.deepEqual(rules("    if (await page.getByTestId('x').isVisible()) { await expect(page.getByTestId('x')).toHaveText('a'); }", 'warning'), ['no-conditional-assertion']);
    assert.deepEqual(rules("    if (await page.getByTestId('x').isVisible()) { await expect(page.getByTestId('x')).toHaveText('a'); }", 'error'), []);
  });
});

describe('writeGeneratedSuite quality gate', () => {
  const setup = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-codegen-'));
    const layout = {
      root, testsDir: path.join(root, 'tests'), pagesDir: path.join(root, 'pages'),
      fixturesDir: path.join(root, 'fixtures'), supportDir: path.join(root, 'support'),
      utilsDir: path.join(root, 'utils'), artifactsDir: path.join(root, 'artifacts'),
      runsDir: path.join(root, 'runs'), screenshotsDir: path.join(root, 'shots'),
    } satisfies SuiteLayout;
    for (const dir of [layout.testsDir, layout.pagesDir, layout.fixturesDir]) fs.mkdirSync(dir, { recursive: true });
    return layout;
  };
  const output = (body: string): TestGeneratorOutput => ({
    pageObjects: [], fixtures: [], reusedExistingArtifacts: [], notes: [],
    specs: [{
      fileName: 'tasks.spec.ts', feature: 'tasks', describe: 'Tasks', imports: [],
      tests: [{ scenarioId: 'SC-1', title: 'creates a task', body, tags: [] }],
    }],
  });

  test('a spec with a blocking issue is rejected and the previous version kept', () => {
    const layout = setup();
    const abs = path.join(layout.testsDir, 'tasks.spec.ts');
    fs.writeFileSync(abs, '// previous version\n');
    const result = writeGeneratedSuite(layout, 'tasks', output("await page.goto('/');\nawait page.waitForTimeout(1000);"));
    assert.deepEqual(result.rejected, ['tests/tasks.spec.ts']);
    assert.deepEqual(result.files, []);
    const blocking = result.issues.filter((i) => i.severity === 'error');
    assert.deepEqual(blocking.map((i) => i.rule), ['no-hard-wait']);
    assert.ok(blocking[0]!.line);
    assert.equal(fs.readFileSync(abs, 'utf8'), '// previous version\n');
  });

  test('a spec with only warnings is written and the warnings are returned', () => {
    const layout = setup();
    const result = writeGeneratedSuite(layout, 'tasks', output("await page.goto('/');\nawait page.locator('li:nth-child(2)').click();"));
    assert.deepEqual(result.rejected, []);
    assert.equal(result.files.length, 1);
    assert.deepEqual(result.issues.map((i) => [i.rule, i.severity]), [['fragile-nth-selector', 'warning']]);
    assert.ok(fs.existsSync(path.join(layout.testsDir, 'tasks.spec.ts')));
  });
});
