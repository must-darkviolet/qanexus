/**
 * Deterministic test synthesis, pinned against the bundled sample app: every
 * scenario kind must become a real interaction with a real assertion, and a
 * scenario that cannot be implemented faithfully must say why.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { test, describe, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeRepository } from '../src/analysis/staticAnalyzer.js';
import { buildAppModel, apiPattern, type AppModel } from '../src/playwright/appModel.js';
import { synthesizeTest } from '../src/playwright/synthesizer.js';
import { validateGeneratedSource } from '../src/playwright/codegen.js';

const sampleApp = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../sample-app');
let model: AppModel;

const scenario = (title: string, category = 'functional') => ({ id: 'SC-T', title, category, steps: [], expectedResult: '' });
const body = (title: string, category?: string, routes = ['/tasks', '/tasks/new']) => {
  const r = synthesizeTest(model, scenario(title, category), routes);
  assert.ok(r.ok, `expected "${title}" to be implementable: ${r.ok ? '' : r.reason}`);
  // Every synthesized body must be valid TypeScript inside a Playwright test.
  const issues = validateGeneratedSource('x.spec.ts', `test('t', async ({ page, qa }) => {\n${r.body}\n});`);
  assert.deepEqual(issues, []);
  return r.body;
};

describe('application model', () => {
  before(() => { model = buildAppModel(analyzeRepository(sampleApp).analysis); });

  test('places each form on the page that renders it, with resolved limits and its API', () => {
    const form = model.pageForRoute('/tasks/new')?.forms[0];
    assert.ok(form);
    const title = form.fields.find((f) => f.name === 'title')!;
    assert.equal(title.min, 5);
    assert.equal(title.max, 80);
    assert.equal(form.submitSelector, '[data-testid="new-task-submit"]');
    assert.equal(form.submitApi?.method, 'POST');
    assert.equal(form.submitApi?.path, '/tasks');
  });

  test('links a page to APIs it reaches through imported functions', () => {
    assert.deepEqual(model.pageForRoute('/tasks')?.readApis.map((a) => a.path), ['/tasks']);
    assert.equal(model.sessionApi?.path, '/api/auth/session');
  });

  test('builds fixtures from the TypeScript types, one per status value', () => {
    const tasks = model.fixturesFor('Task');
    assert.deepEqual(tasks.map((t) => t['status']), ['draft', 'pending', 'approved', 'rejected']);
    assert.equal(typeof tasks[0]!['title'], 'string');
  });

  test('knows which role lacks a permission', () => {
    assert.equal(model.roleWithout({ permission: 'task:create' }), 'viewer');
    assert.equal(model.mostPrivilegedRole(), 'admin');
  });

  test('turns path parameters into a URL pattern', () => {
    assert.equal(apiPattern('/tasks/:id/status'), '/tasks/[^/]+/status');
  });
});

describe('synthesized tests', () => {
  before(() => { model ??= buildAppModel(analyzeRepository(sampleApp).analysis); });

  test('required field: submits empty and asserts rejection with no request sent', () => {
    const b = body('Submitting with "title" empty is rejected', 'validation');
    assert.match(b, /await page\.goto\("\/tasks\/new"\)/);
    assert.match(b, /await qa\.fill\("\[data-testid=\\"new-task-title\\"\]", ""\)/);
    assert.match(b, /await qa\.expectRejected/);
    assert.match(b, /await qa\.expectNotCalled\('qaSubmit'\)/);
  });

  test('boundary below the minimum types one character too few', () => {
    const b = body('"title" below its minimum of 5 is rejected', 'boundary');
    assert.match(b, /"QQQQ"/);
  });

  test('an outdated limit is reported, not silently tested', () => {
    const r = synthesizeTest(model, scenario('"title" below its minimum of 3 is rejected', 'boundary'), ['/tasks/new']);
    assert.equal(r.ok, false);
    assert.match(r.ok ? '' : r.reason, /now declares a minimum of 5/);
  });

  test('valid submission checks the payload that was sent', () => {
    const b = body('Valid new task submission is accepted');
    assert.match(b, /const submitted = await qa\.waitFor\('qaSubmit'\);/);
    assert.match(b, /expect\(JSON\.stringify\(submitted\.body\)/);
  });

  test('permission denial signs in as the role without it and expects the guard', () => {
    const b = body('A "viewer" user is refused on /tasks/new (requires task:create)', 'authorization');
    assert.match(b, /"role":"viewer"/);
    assert.match(b, /new-task-forbidden/);
  });

  test('row action asserts the target state in the request body', () => {
    const b = body('"Approve" on a Task row in /tasks sends the request', 'state_transition');
    assert.match(b, /task-approve-/);
    assert.match(b, /await qa\.waitFor\('qaAction'\)/);
    assert.match(b, /\.toContain\("approved"\)/);
  });

  test('empty, error and search states stub the list API', () => {
    assert.match(body('TasksPage shows an empty state when there is no data', 'ui_behavior'), /"body":\[\]/);
    assert.match(body('TasksPage shows an error state when its request fails', 'error_handling'), /"statusCode":500/);
    assert.match(body('Searching /tasks filters the list', 'ui_behavior'), /\.not\.toContainText/);
  });

  test('no generated body uses a hard wait or a forced click', () => {
    for (const title of ['Valid new task submission is accepted', '"title" above its maximum of 80 is rejected', 'Unauthenticated access to /tasks is blocked']) {
      const b = body(title);
      assert.doesNotMatch(b, /waitForTimeout\(/);
      assert.doesNotMatch(b, /force:\s*true/);
      // Every Playwright call has to be awaited, or the test races the page.
      for (const line of b.split('\n')) {
        if (/^\s*(?:page|qa)\./.test(line)) assert.fail(`not awaited: ${line}`);
      }
    }
  });

  test('an element-level role check is not asserted as page-level denial', () => {
    const r = synthesizeTest(model, scenario('A user without the "admin" role cannot access /members', 'authorization'), ['/members']);
    assert.equal(r.ok, false);
  });
});
