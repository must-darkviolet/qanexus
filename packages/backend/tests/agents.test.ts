/**
 * Agent-layer tests.
 *
 * These cover the guarantees the spec is strict about: validated structured
 * output, a deterministic fallback when AI is unavailable, caching, and the
 * refusal to treat an inference as a fact.
 */
import assert from 'node:assert/strict';
import { test, describe, before, after, beforeEach } from 'node:test';
import { z } from 'zod';

process.env.DATABASE_URL = 'sqlite::memory:';
process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64);

const { extractJson, parseAndValidate, parseJsonLoose, toJsonSchema, AiOutputError } = await import('../src/ai/json.js');
const { runAgent } = await import('../src/agents/base.js');
const { setAiProvider, resetAiProvider } = await import('../src/ai/factory.js');
const { runMigrations } = await import('../src/db/migrate.js');
const { getDb } = await import('../src/db/client.js');
const { similarity, deduplicate, bestMatch, dedupeHash } = await import('../src/knowledge/dedupe.js');
const { heuristicDiagnosis } = await import('../src/agents/failureAnalyzer.js');
const { preselectSpecs, shouldForceFullRegression } = await import('../src/agents/regressionSelector.js');
const { failureSignature } = await import('../src/knowledge/evidence.js');

before(async () => { await runMigrations(); });
after(async () => { resetAiProvider(); });

describe('structured output parsing', () => {
  test('recovers JSON from a fenced or chatty response', () => {
    assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(parseJsonLoose('Here you go:\n{"a":1}\nHope that helps.'), { a: 1 });
    assert.deepEqual(parseJsonLoose('{"a":1,}'), { a: 1 });
  });

  test('extracts the outermost balanced value, ignoring braces inside strings', () => {
    assert.equal(extractJson('prefix {"a":"}{"} suffix'), '{"a":"}{"}');
  });

  test('rejects output that does not satisfy the schema', () => {
    const schema = z.object({ count: z.number() });
    assert.throws(() => parseAndValidate(schema, '{"count":"many"}'), AiOutputError);
  });

  test('accepts a bare array where a single-array object was requested', () => {
    const schema = z.object({ items: z.array(z.string()).default([]) });
    assert.deepEqual(parseAndValidate(schema, '["a","b"]'), { items: ['a', 'b'] });
  });

  test('converts a zod schema into JSON Schema', () => {
    const jsonSchema = toJsonSchema(z.object({
      name: z.string(),
      tags: z.array(z.string()),
      level: z.enum(['a', 'b']),
      note: z.string().optional(),
    })) as { properties: Record<string, unknown>; required: string[] };
    assert.equal((jsonSchema.properties['name'] as { type: string }).type, 'string');
    assert.equal((jsonSchema.properties['tags'] as { type: string }).type, 'array');
    assert.deepEqual((jsonSchema.properties['level'] as { enum: string[] }).enum, ['a', 'b']);
    // Optional fields must not be demanded of the model.
    assert.ok(!jsonSchema.required.includes('note'));
  });
});

describe('agent runner', () => {
  const schema = z.object({ answer: z.string() });

  beforeEach(async () => {
    const db = await getDb();
    await db.run('DELETE FROM ai_cache');
    await db.run('DELETE FROM ai_usage');
  });

  test('uses the deterministic fallback when no provider is configured', async () => {
    setAiProvider(null);
    const result = await runAgent({
      agent: 'RepositoryAnalyzer', projectId: null, runId: null,
      system: 's', user: 'u', schema,
      fallback: () => ({ answer: 'deterministic' }),
    });
    assert.equal(result.source, 'fallback');
    assert.equal(result.data.answer, 'deterministic');
  });

  test('retries once with the validation errors, then succeeds', async () => {
    let calls = 0;
    setAiProvider({
      name: 'fake', model: 'fake-1',
      estimateCost: () => 0,
      generate: async () => {
        calls++;
        return {
          text: calls === 1 ? '{"wrong":1}' : '{"answer":"ok"}',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          model: 'fake-1', provider: 'fake',
        };
      },
    });
    const result = await runAgent({
      agent: 'ScenarioGenerator', projectId: null, runId: null,
      system: 's', user: 'retry-case', schema,
      fallback: () => ({ answer: 'fallback' }),
    });
    assert.equal(calls, 2);
    assert.equal(result.source, 'ai');
    assert.equal(result.data.answer, 'ok');
  });

  test('falls back rather than throwing when the provider keeps failing', async () => {
    setAiProvider({
      name: 'fake', model: 'fake-1',
      estimateCost: () => 0,
      generate: async () => { throw new Error('provider exploded'); },
    });
    const result = await runAgent({
      agent: 'BusinessRuleAnalyzer', projectId: null, runId: null,
      system: 's', user: 'always-fails', schema,
      fallback: () => ({ answer: 'safe' }),
    });
    assert.equal(result.source, 'fallback');
    assert.equal(result.data.answer, 'safe');
    assert.match(result.error!, /provider exploded/);
  });

  test('serves an identical prompt from cache and records the hit', async () => {
    let calls = 0;
    setAiProvider({
      name: 'fake', model: 'fake-1',
      estimateCost: () => 0,
      generate: async () => {
        calls++;
        return {
          text: '{"answer":"cached"}',
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          model: 'fake-1', provider: 'fake',
        };
      },
    });
    const options = {
      agent: 'ApplicationMapper' as const, projectId: null, runId: null,
      system: 'same', user: 'same-prompt', schema,
      fallback: () => ({ answer: 'fallback' }),
    };
    const first = await runAgent(options);
    const second = await runAgent(options);

    assert.equal(calls, 1, 'the provider should only be called once');
    assert.equal(first.source, 'ai');
    assert.equal(second.source, 'cache');

    const db = await getDb();
    const row = await db.one<{ c: number }>('SELECT COUNT(*) AS c FROM ai_usage WHERE cached = 1');
    assert.equal(Number(row?.c), 1, 'the cache hit should still be recorded as usage');
  });
});

describe('semantic deduplication', () => {
  test('treats reworded scenarios as the same scenario', () => {
    assert.ok(similarity('Create a user with valid data', 'Successfully create user using valid data') > 0.8);
    assert.ok(similarity('Delete a user', 'Remove a user account') > 0.5);
  });

  test('keeps genuinely different scenarios apart', () => {
    assert.ok(similarity('Create a user with valid data', 'Delete a task permanently') < 0.5);
  });

  test('drops near-duplicates while keeping distinct items', () => {
    const existing = [{ title: 'Create user with valid data', feature: 'users' }];
    const incoming = [
      { title: 'Successfully create a user using valid data', feature: 'users' },
      { title: 'Reject a user with a duplicate email', feature: 'users' },
    ];
    const { kept, duplicates } = deduplicate(
      incoming, existing,
      (item) => ({ text: item.title, bucket: item.feature }),
    );
    assert.equal(kept.length, 1);
    assert.equal(duplicates.length, 1);
    assert.equal(kept[0]!.title, 'Reject a user with a duplicate email');
  });

  test('never merges items from different buckets', () => {
    const { kept } = deduplicate(
      [{ title: 'Create with valid data', feature: 'tasks' }],
      [{ title: 'Create with valid data', feature: 'users' }],
      (item) => ({ text: item.title, bucket: item.feature }),
    );
    assert.equal(kept.length, 1);
  });

  test('matches a scenario to an existing test title', () => {
    const match = bestMatch(
      'Signing in with valid credentials succeeds',
      [{ title: 'signs in with valid credentials' }, { title: 'shows the dashboard' }],
      (c) => c.title,
    );
    assert.equal(match?.item.title, 'signs in with valid credentials');
  });

  test('produces a stable hash regardless of wording order', () => {
    assert.equal(dedupeHash(['users', 'create a user']), dedupeHash(['users', 'user create a']));
  });
});

describe('failure diagnosis heuristics', () => {
  const base = {
    projectId: 'p', runId: 'r',
    testSource: null, scenario: null, rules: [],
    commitSha: 'abc123', changedFiles: [], relevantDiffs: [],
    pastFailures: [], baseUrl: 'http://localhost:3000',
  };
  const result = (errorMessage: string) => ({
    id: 't', specFile: 'tests/a.spec.ts', title: 'a', fullTitle: 'a',
    scenarioId: null, outcome: 'failed' as const, durationMs: 1,
    errorMessage, errorStack: null, screenshotPaths: [], videoPath: null, tracePath: null,
    consoleLogs: [], networkLogs: [], domSnapshot: null, attempts: 1,
  });

  test('a refused connection is an environment failure, not a product bug', () => {
    const d = heuristicDiagnosis({ ...base, result: result('connect ECONNREFUSED 127.0.0.1:3000') });
    assert.equal(d.classification, 'ENVIRONMENT_FAILURE');
    assert.ok(d.confidence > 0.9);
    assert.match(d.recommendedAction, /not a product bug/i);
  });

  test('a 404 from the server is a UI change, not a dead environment', () => {
    const d = heuristicDiagnosis({
      ...base,
      result: result('Error: expect(page).toHaveTitle() failed\n\nThe response we received from your web server was:\n  > 404: Not Found'),
    });
    assert.equal(d.classification, 'UI_CHANGED');
  });

  test('a missing element points at the locator', () => {
    const d = heuristicDiagnosis({
      ...base,
      result: result('Error: expect(locator).toBeVisible() failed\n\nLocator: locator(\'[data-testid="save"]\')\nExpected: visible\nReceived: <element(s) not found>\nTimeout: 8000ms'),
    });
    assert.equal(d.classification, 'LOCATOR_CHANGED');
  });

  test('an unauthorized response is an authentication failure', () => {
    const d = heuristicDiagnosis({ ...base, result: result('Request failed with status 401 Unauthorized') });
    assert.equal(d.classification, 'AUTHENTICATION_FAILURE');
  });

  test('an unrecognised error is UNKNOWN and asks for a human', () => {
    const d = heuristicDiagnosis({ ...base, result: result('something entirely unexpected happened') });
    assert.equal(d.classification, 'UNKNOWN');
    assert.equal(d.requiresHumanReview, true);
    assert.ok(d.unknown.length > 0);
  });

  test('a known flaky test with no related change is flagged as timing', () => {
    const d = heuristicDiagnosis({
      ...base,
      result: result('Timed out retrying'),
      pastFailures: [{
        id: 'f1', testTitle: 'a', specFile: 'tests/a.spec.ts', scenarioKey: null,
        classification: 'TIMING_OR_STATE_ISSUE', rootCause: null, resolution: 'flaky',
        occurrenceCount: 4, isFlaky: true, signature: 'sig', occurredAt: '', commitSha: null,
      }],
    });
    assert.equal(d.isLikelyFlaky, true);
    assert.equal(d.requiresHumanReview, true);
  });

  const past = (over: Record<string, unknown>) => ({
    id: 'f2', testTitle: 'a', specFile: 'tests/a.spec.ts', scenarioKey: null,
    classification: 'UNKNOWN', rootCause: null, resolution: 'open',
    occurrenceCount: 2, isFlaky: false, signature: 'sig', occurredAt: '2026-09-01', commitSha: 'def4567890',
    ...over,
  });

  test('the same failure on an earlier commit is pre-existing', () => {
    const d = heuristicDiagnosis({
      ...base, changedFiles: ['src/x.ts'],
      result: result('Error: expect(received).toBe(expected)\nExpected: 3\nReceived: 2'),
      pastFailures: [past({})],
    });
    assert.equal(d.classification, 'PREEXISTING_FAILURE');
    assert.deepEqual(d.relatedPastFailureIds, ['f2']);
  });

  test('history on this commit, on a commit of the same change, or already fixed is not pre-existing', () => {
    const msg = result('something entirely unexpected happened');
    for (const [pf, extra] of [
      [past({ commitSha: 'abc123' }), {}],
      [past({ commitSha: 'def4567890' }), { changeCommitShas: ['def4567'] }],
      [past({ resolution: 'fixed' }), {}],
    ] as const) {
      const d = heuristicDiagnosis({ ...base, ...extra, result: msg, pastFailures: [pf] });
      assert.notEqual(d.classification, 'PREEXISTING_FAILURE');
    }
  });

  test('a 503 from a third-party host is a dependency failure', () => {
    const d = heuristicDiagnosis({
      ...base,
      result: { ...result('Error: expect(locator).toBeVisible() failed'), networkLogs: [
        'GET http://localhost:3000/checkout -> 200 (12ms)',
        'POST https://api.stripe.com/v1/payment_intents -> 503 (80ms)',
      ] },
    });
    assert.equal(d.classification, 'DEPENDENCY_FAILURE');
    assert.match(d.rootCause, /api\.stripe\.com/);
  });

  test('ECONNREFUSED to a non-app host is a dependency failure; to the app it stays environment', () => {
    const dep = heuristicDiagnosis({ ...base, result: result('connect ECONNREFUSED 10.0.0.5:5432') });
    assert.equal(dep.classification, 'DEPENDENCY_FAILURE');
    const envFail = heuristicDiagnosis({ ...base, result: result('connect ECONNREFUSED 127.0.0.1:3000') });
    assert.equal(envFail.classification, 'ENVIRONMENT_FAILURE');
  });

  test('a 5xx from the app itself is still an API failure', () => {
    const d = heuristicDiagnosis({
      ...base,
      result: { ...result('Request failed with status 500 Internal Server Error'), networkLogs: ['POST http://localhost:3000/api/tasks -> 500 (5ms)'] },
    });
    assert.equal(d.classification, 'API_FAILURE');
  });

  test('missing seed data is a test data issue', () => {
    const d = heuristicDiagnosis({ ...base, result: result('Error: seed user "admin@example.com" not found') });
    assert.equal(d.classification, 'TEST_DATA_ISSUE');
    const d2 = heuristicDiagnosis({ ...base, result: result('Error: ENOENT: no such file or directory, open \'tests/fixtures/users.json\'') });
    assert.equal(d2.classification, 'TEST_DATA_ISSUE');
  });

  test('a 404 fetching a specific id during setup is a test data issue', () => {
    const d = heuristicDiagnosis({
      ...base,
      result: {
        ...result('Error: project fetch failed in beforeEach hook'),
        networkLogs: ['GET http://localhost:3000/api/projects/42 -> 404 (3ms)'],
      },
    });
    assert.equal(d.classification, 'TEST_DATA_ISSUE');
  });
});

describe('regression selection', () => {
  const diff = {
    previousCommitSha: 'a', currentCommitSha: 'b', isFirstAnalysis: false,
    files: [{ path: 'src/features/users/UserForm.tsx', status: 'modified' as const, additions: 3, deletions: 1 }],
    changedFunctions: [], changedComponents: [], changedRoutes: [], changedApis: [],
    changedValidations: [], changedBusinessLogicFiles: [], commits: [],
  };

  test('selects only the specs traced to a changed file', () => {
    const selected = preselectSpecs(diff, [
      { sourceFile: 'src/features/users/UserForm.tsx', featureKey: 'users', businessRuleKey: 'BR-001', scenarioKey: 'SC-001', specFile: 'tests/users.spec.ts' },
      { sourceFile: 'src/features/tasks/TaskList.tsx', featureKey: 'tasks', businessRuleKey: null, scenarioKey: 'SC-050', specFile: 'tests/tasks.spec.ts' },
    ], ['tests/users.spec.ts', 'tests/tasks.spec.ts']);

    assert.equal(selected.length, 1);
    assert.equal(selected[0]!.specFile, 'tests/users.spec.ts');
    assert.match(selected[0]!.reason, /SC-001/);
  });

  test("counts a rename's old path as changed", () => {
    const renameDiff = {
      ...diff,
      files: [{ path: 'src/app/members/page.tsx', previousPath: 'src/app/users/page.tsx', status: 'renamed' as const, additions: 1, deletions: 1 }],
    };
    const selected = preselectSpecs(renameDiff, [
      { sourceFile: 'src/app/users/page.tsx', featureKey: 'users', businessRuleKey: null, scenarioKey: 'SC-001', specFile: 'tests/users.spec.ts' },
    ], ['tests/users.spec.ts']);
    assert.equal(selected.length, 1, 'a spec traced to the pre-rename path must still be selected');
  });

  test('forces a full regression for a broad change', () => {
    assert.equal(shouldForceFullRegression({ ...diff, files: [{ path: 'package-lock.json', status: 'modified', additions: 1, deletions: 1 }] }), true);
    assert.equal(shouldForceFullRegression({ ...diff, files: [{ path: 'src/app/layout.tsx', status: 'modified', additions: 1, deletions: 1 }] }), true);
    assert.equal(shouldForceFullRegression(diff), false);
  });
});

describe('failure signatures', () => {
  test('groups the same failure across runs despite varying numbers', () => {
    const a = failureSignature('tests/a.spec.ts', 'test', 'Timed out retrying after 4000ms: expected 3 items');
    const b = failureSignature('tests/a.spec.ts', 'test', 'Timed out retrying after 8000ms: expected 7 items');
    assert.equal(a, b);
  });

  test('keeps different failures apart', () => {
    const a = failureSignature('tests/a.spec.ts', 'test', 'Element not found');
    const b = failureSignature('tests/a.spec.ts', 'test', 'Assertion failed');
    assert.notEqual(a, b);
  });
});
