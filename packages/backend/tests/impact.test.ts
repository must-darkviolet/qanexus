/**
 * Regression intelligence tests: change impact tracing, the import graph,
 * validation of generated code, and merging AI advice safely.
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import type { RepositoryDiff, StaticAnalysis } from '@qa-agent/shared';
import { computeImpact, visitMatchesRoute } from '../src/knowledge/impact.js';
import { buildImportedBy } from '../src/analysis/imports.js';
import { validateGeneratedSource } from '../src/playwright/codegen.js';
import { mergeAdvice } from '../src/agents/regressionAdvisor.js';
import type { ScannedFile } from '../src/analysis/scanner.js';
import type { StoredBusinessRule, StoredScenario } from '../src/knowledge/store.js';

function file(path: string, content: string): ScannedFile {
  return {
    path, absPath: `/repo/${path}`, size: content.length, hash: 'h',
    language: path.endsWith('.tsx') ? 'tsx' : 'ts', content, isTest: false, isTooLarge: false,
  };
}

function analysis(partial: Partial<StaticAnalysis>): StaticAnalysis {
  return {
    framework: 'next', usesTypeScript: true, scripts: {}, dependencies: {}, docs: [], files: [],
    routes: [], components: [], apis: [], validations: [], roles: [], permissionChecks: [],
    stateMachines: [], entities: [], constants: [], featureFlags: [], statusValues: [],
    errorHandling: [], envVarNames: [], authSignals: [], existingTests: [], excludedForSecrets: [],
    ...partial,
  };
}

function diff(partial: Partial<RepositoryDiff>): RepositoryDiff {
  return {
    previousCommitSha: 'a', currentCommitSha: 'b', isFirstAnalysis: false, files: [],
    changedFunctions: [], changedComponents: [], changedRoutes: [], changedApis: [],
    changedValidations: [], changedBusinessLogicFiles: [], commits: [], ...partial,
  };
}

const component = (name: string, f: string, usesComponents: string[] = [], selectors: string[] = []) => ({
  name, file: f, kind: 'component' as const, exported: true, props: [], forms: [],
  elements: selectors.map((selector) => ({ kind: 'button' as const, selector })),
  usesComponents, callsApis: [], conditionalRendering: [], loadingStates: [], errorStates: [], emptyStates: [],
});

const source = { kind: 'range' as const, base: 'a', head: 'b', description: 'a -> b' };

describe('change impact', () => {
  const app = analysis({
    routes: [{ path: '/tasks/new', file: 'src/app/tasks/new/page.tsx', kind: 'page', params: [], guardedByRoles: [], framework: 'next_app' }],
    components: [
      component('TitleField', 'src/components/TitleField.tsx', [], ['[data-testid="title"]']),
      component('NewTaskPage', 'src/app/tasks/new/page.tsx', ['TitleField']),
    ],
    existingTests: [
      { file: 'tests/tasks.spec.ts', kind: 'spec', titles: ['creates a task'], selectorsUsed: [], pageObjects: [], commands: [], visits: ['/tasks/new'] },
      { file: 'tests/login.spec.ts', kind: 'spec', titles: ['logs in'], selectorsUsed: [], pageObjects: [], commands: [], visits: ['/login'] },
    ],
  });
  const features = [{ key: 'tasks', name: 'Tasks', routes: ['/tasks/new'], components: ['NewTaskPage'], files: ['src/app/tasks/new/page.tsx'], apis: [], entities: [], evidenceLevel: 'observed' as const }];

  test('traces a leaf component through the page that renders it to the spec that visits that page', () => {
    const impact = computeImpact({
      source, analysis: app, features, rules: [], scenarios: [], traces: [], generatedTests: [],
      diff: diff({
        files: [{ path: 'src/components/TitleField.tsx', status: 'modified', additions: 3, deletions: 1 }],
        changedFunctions: [{ file: 'src/components/TitleField.tsx', name: 'TitleField', change: 'modified' }],
      }),
    });
    const trace = impact.traces[0]!;
    assert.deepEqual(trace.dependentComponents, ['NewTaskPage']);
    assert.deepEqual(trace.routes, ['/tasks/new']);
    assert.deepEqual(trace.features.map((f) => f.key), ['tasks']);
    assert.deepEqual(trace.relatedTests.map((t) => t.file), ['tests/tasks.spec.ts']);
    assert.match(trace.relatedTests[0]!.why, /Visits affected route/);
    // Every link carries a reason.
    assert.ok(trace.reasoning.some((r) => r.includes('NewTaskPage')));
    // An unrelated spec is not dragged in.
    assert.ok(!impact.coverage.relatedExistingTests.some((t) => t.file === 'tests/login.spec.ts'));
  });

  test('a validation change is high risk and produces boundary recommendations, collapsing a rewrite to "modified"', () => {
    const impact = computeImpact({
      source, analysis: app, features, rules: [], scenarios: [], traces: [], generatedTests: [],
      diff: diff({
        files: [{ path: 'src/app/tasks/new/page.tsx', status: 'modified', additions: 1, deletions: 1 }],
        changedValidations: [
          { field: 'title', file: 'src/app/tasks/new/page.tsx', change: 'removed' },
          { field: 'title', file: 'src/app/tasks/new/page.tsx', change: 'added' },
        ],
      }),
    });
    assert.equal(impact.traces[0]!.risk, 'high');
    const boundary = impact.recommendations.filter((r) => r.title.includes('"title" validation'));
    assert.equal(boundary.length, 1);
    assert.match(boundary[0]!.title, /modified/);
  });

  test('flags an affected feature with no tests as a coverage gap, and never claims a percentage', () => {
    const impact = computeImpact({
      source, analysis: analysis({ components: app.components, routes: app.routes }), features,
      rules: [], scenarios: [], traces: [], generatedTests: [],
      diff: diff({ files: [{ path: 'src/app/tasks/new/page.tsx', status: 'modified', additions: 1, deletions: 0 }] }),
    });
    assert.equal(impact.coverage.featuresAffected, 1);
    assert.equal(impact.coverage.featuresWithAnyTest, 0);
    assert.ok(impact.coverage.gaps.some((g) => g.kind === 'no_tests' && g.feature === 'tasks'));
    assert.ok(impact.recommendations.some((r) => r.type === 'add_scenario' && r.feature === 'tasks'));
  });

  test('a removed route produces a critical "update test" for every spec that still visits it', () => {
    const impact = computeImpact({
      source, analysis: app, features, rules: [], scenarios: [], traces: [], generatedTests: [],
      diff: diff({
        files: [{ path: 'src/app/tasks/new/page.tsx', status: 'deleted', additions: 0, deletions: 20 }],
        changedRoutes: [{ path: '/tasks/new', change: 'removed' }],
      }),
    });
    const update = impact.recommendations.find((r) => r.type === 'update_test');
    assert.ok(update);
    assert.equal(update.priority, 'critical');
    assert.deepEqual(update.relatedTests, ['tests/tasks.spec.ts']);
  });

  test('advises a full regression for broad changes', () => {
    const impact = computeImpact({
      source, analysis: app, features, rules: [], scenarios: [], traces: [], generatedTests: [],
      diff: diff({ files: [{ path: 'package.json', status: 'modified', additions: 1, deletions: 1 }] }),
    });
    assert.equal(impact.fullRegressionAdvised, true);
    assert.equal(impact.recommendations[0]!.type, 'full_regression');
  });

  test('history becomes an additional, labelled regression step', () => {
    const impact = computeImpact({
      source, analysis: app, features, rules: [], scenarios: [], traces: [], generatedTests: [],
      diff: diff({ files: [{ path: 'src/app/tasks/new/page.tsx', status: 'modified', additions: 1, deletions: 0 }] }),
      historicalFindings: [{
        kind: 'past_defect', matchedOn: 'changed file src/app/tasks/new/page.tsx',
        summary: 'Empty titles were accepted', occurredAt: null, reference: 'tests/tasks.spec.ts',
        occurrences: 2, recommendation: 'Re-verify that empty titles are rejected',
      }],
    });
    const rec = impact.recommendations.find((r) => r.source === 'history');
    assert.ok(rec);
    assert.equal(rec.priority, 'high');
    assert.deepEqual(rec.relatedTests, ['tests/tasks.spec.ts']);
  });

  test('links a rule whose evidence changed but has no verifying scenario as a gap', () => {
    const rule = {
      id: 'BR-001', feature: 'tasks', description: 'Title must be at least 5 characters', evidence: [],
      confidence: 0.95, status: 'confirmed', observed: [], inferred: [], unknown: [], relatedRoutes: [],
      relatedApis: [], relatedFiles: ['src/app/tasks/new/page.tsx'], category: 'validation',
      dbId: 'x', isActive: true, firstSeenCommit: null, lastSeenCommit: null, approvalState: 'ai_generated',
    } as StoredBusinessRule;
    const impact = computeImpact({
      source, analysis: app, features, rules: [rule], scenarios: [] as StoredScenario[], traces: [], generatedTests: [],
      diff: diff({ files: [{ path: 'src/app/tasks/new/page.tsx', status: 'modified', additions: 1, deletions: 0 }] }),
    });
    assert.ok(impact.coverage.gaps.some((g) => g.kind === 'rule_untested' && g.subject.startsWith('BR-001')));
    assert.equal(impact.affectedFeatures[0]!.rulesAffected, 1);
  });

  test('matches visits against dynamic and catch-all routes', () => {
    assert.ok(visitMatchesRoute('/users/42', '/users/:id'));
    assert.ok(visitMatchesRoute('http://localhost:3000/users/42?tab=1', '/users/:id'));
    assert.ok(visitMatchesRoute('/blog/2024/post', '/blog/:slug*'));
    assert.ok(visitMatchesRoute('/users/7', '/users/[id]'));
    assert.ok(!visitMatchesRoute('/users', '/users/:id'));
    assert.ok(!visitMatchesRoute('/members', '/users'));
  });
});

describe('import graph', () => {
  test('resolves relative imports and tsconfig path aliases', () => {
    const graph = buildImportedBy([
      file('tsconfig.json', '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }'),
      file('src/lib/permissions.ts', 'export const can = () => true;'),
      file('src/app/tasks/page.tsx', "import { can } from '@/lib/permissions';"),
      file('src/app/users/page.tsx', "import { can } from '../../lib/permissions';"),
      file('src/app/other.tsx', "import React from 'react';"),
    ]);
    assert.deepEqual(graph['src/lib/permissions.ts']?.sort(), ['src/app/tasks/page.tsx', 'src/app/users/page.tsx']);
    assert.equal(graph['react'], undefined);
  });

  test('carries a helper change through its importers to their routes and features', () => {
    const app = analysis({
      routes: [{ path: '/tasks', file: 'src/app/tasks/page.tsx', kind: 'page', params: [], guardedByRoles: [], framework: 'next_app' }],
      components: [component('TasksPage', 'src/app/tasks/page.tsx')],
    });
    const impact = computeImpact({
      source, analysis: app, rules: [], scenarios: [], traces: [], generatedTests: [],
      features: [{ key: 'tasks', name: 'Tasks', routes: ['/tasks'], components: [], files: ['src/app/tasks/page.tsx'], apis: [], entities: [], evidenceLevel: 'observed' }],
      importedBy: { 'src/lib/permissions.ts': ['src/app/tasks/page.tsx'] },
      diff: diff({ files: [{ path: 'src/lib/permissions.ts', status: 'modified', additions: 1, deletions: 0 }] }),
    });
    assert.deepEqual(impact.traces[0]!.routes, ['/tasks']);
    assert.deepEqual(impact.affectedFeatures.map((f) => f.key), ['tasks']);
    assert.equal(impact.traces[0]!.risk, 'high', 'a permissions file is sensitive');
  });
});

describe('generated code validation', () => {
  test('accepts valid TypeScript and rejects a syntax error with its line', () => {
    assert.deepEqual(validateGeneratedSource('tests/a.spec.ts', "test.describe('a', () => { test('b', async ({ page }) => { await page.goto('/'); }); });"), []);
    const issues = validateGeneratedSource('tests/b.spec.ts', "test.describe('a', () => {\n  test('b', async ({ page }) => { await page.goto('/'); ;\n");
    assert.equal(issues[0]?.rule, 'syntax-error');
    assert.match(issues[0]!.detail, /^line \d+/);
  });

  test('rejects invalid fixture JSON', () => {
    assert.equal(validateGeneratedSource('fixtures/x.json', '{ bad json')[0]?.rule, 'invalid-json');
  });
});

describe('merging AI advice', () => {
  const base = computeImpact({
    source, analysis: analysis({}), features: [], rules: [], scenarios: [], traces: [], generatedTests: [],
    diff: diff({ files: [{ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0 }] }),
  });

  test('drops test references the AI invented and labels its recommendations', () => {
    const merged = mergeAdvice(base, {
      source: 'ai',
      data: {
        summary: 'Risky change to a.',
        recommendations: [{
          type: 'run_existing_test', title: 'Run the imaginary suite', priority: 'high', feature: null,
          relatedTests: ['tests/does-not-exist.spec.ts'], reasoning: 'because', evidence: [], confidence: 0.7,
        }],
        missingScenarios: [{ feature: null, title: 'Verify that a still works', reasoning: 'a changed', priority: 'medium' }],
      },
    });
    const ai = merged.recommendations.filter((r) => r.source === 'ai');
    assert.equal(ai.length, 2);
    assert.deepEqual(ai[0]!.relatedTests, []);
    assert.equal(merged.summary, 'Risky change to a.');
    assert.equal(merged.ai.source, 'ai');
  });

  test('a fallback keeps the deterministic report and says why', () => {
    const merged = mergeAdvice(base, { source: 'fallback', error: 'quota exceeded', data: { summary: '', recommendations: [], missingScenarios: [] } });
    assert.equal(merged.recommendations.length, base.recommendations.length);
    assert.match(merged.ai.note ?? '', /quota exceeded/);
  });
});
