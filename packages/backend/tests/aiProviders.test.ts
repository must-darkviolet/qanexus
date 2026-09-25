/**
 * AI provider layer: selection, Gemini and Claude CLI configuration, CLI
 * failure modes, caching, context budgets and generated-test validation.
 *
 * No test talks to Gemini or Claude. The Claude CLI is replaced by
 * tests/fixtures/fake-claude.mjs, and runAgent tests use in-process fakes.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import { z } from 'zod';

process.env.DATABASE_URL = 'sqlite::memory:';
process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64);

const { env, EnvSchema, aiIsConfigured } = await import('../src/config/env.js');
const { ClaudeCliProvider, buildCliArgs } = await import('../src/ai/claudeCli.js');
const { createProviders, getAiProvider, resetAiProvider, setAiProvider, AiConfigError } = await import('../src/ai/factory.js');
const { FailoverProvider, isPermanentProviderError } = await import('../src/ai/failover.js');
const { checkAIProvider } = await import('../src/ai/health.js');
const { packContext, Priority } = await import('../src/ai/contextBudget.js');
const { runAgent } = await import('../src/agents/base.js');
const { renderDiff, compactPatch, renderExistingTestInfrastructure } = await import('../src/agents/context.js');
const { rankTests } = await import('../src/agents/relevance.js');
const { validateGeneratedTests, selectorIsGrounded } = await import('../src/playwright/validateGenerated.js');
const { runMigrations } = await import('../src/db/migrate.js');
const { AiProviderError } = await import('../src/ai/provider.js');
type AiProvider = import('../src/ai/provider.js').AiProvider;
type AiRequest = import('../src/ai/provider.js').AiRequest;

const FAKE_CLAUDE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.mjs');
fs.chmodSync(FAKE_CLAUDE, 0o755);

/** Every env field these tests touch is restored after each test (called inside each describe). */
const saved = { ...env };
function isolateEnv(): void {
  afterEach(() => {
    for (const key of Object.keys(env)) if (!(key in saved)) delete (env as Record<string, unknown>)[key];
    Object.assign(env, saved);
    delete process.env.FAKE_CLAUDE_MODE;
    resetAiProvider();
  });
}

before(async () => { await runMigrations(); });
after(() => { resetAiProvider(); });

const cli = (overrides: Partial<ConstructorParameters<typeof ClaudeCliProvider>[0]> = {}) =>
  new ClaudeCliProvider({ command: FAKE_CLAUDE, timeoutMs: 10_000, ...overrides });
const request: AiRequest = { agent: 'Test', system: 'Return JSON only.', user: 'Say ok.', maxOutputTokens: 1024 };

/* -------------------------------------------------------------------------- */

describe('configuration', () => {
  isolateEnv();
  test('claude-cli is a valid provider and needs no API key', () => {
    const parsed = EnvSchema.parse({ AI_PROVIDER: 'claude-cli' });
    assert.equal(parsed.AI_PROVIDER, 'claude-cli');
    assert.equal(parsed.CLAUDE_CLI_COMMAND, 'claude');
    assert.equal(parsed.CLAUDE_CLI_TIMEOUT_MS, 120_000);
    assert.equal(parsed.CLAUDE_MODEL, undefined, 'an empty model means the CLI default');
    assert.equal('ANTHROPIC_API_KEY' in parsed, false, 'no Anthropic API key is part of the config');
  });

  test('an invalid provider is a clear configuration error', () => {
    const res = EnvSchema.safeParse({ AI_PROVIDER: 'claude' });
    assert.equal(res.success, false);
    assert.match(res.error!.issues[0]!.message, /claude-cli/);
    assert.equal(EnvSchema.safeParse({ AI_PROVIDER: 'gpt-9' }).success, false);
  });

  test('blank values in .env fall back to defaults', () => {
    const parsed = EnvSchema.parse({ GEMINI_MODEL: '', AI_MAX_INPUT_CHARS: '', AI_CACHE_ENABLED: '', CLAUDE_CLI_TIMEOUT_MS: '' });
    assert.ok(parsed.GEMINI_MODEL.length > 0);
    assert.equal(parsed.AI_MAX_INPUT_CHARS, 48_000);
    assert.equal(parsed.AI_CACHE_ENABLED, true);
    assert.equal(parsed.CLAUDE_CLI_TIMEOUT_MS, 120_000);
  });
});

describe('provider selection and switching', () => {
  isolateEnv();
  test('AI_PROVIDER=gemini builds Gemini plus its fallback models', () => {
    Object.assign(env, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'test-key', GEMINI_MODEL: 'gemini-a', GEMINI_FALLBACK_MODELS: 'gemini-b, gemini-a' });
    const providers = createProviders('gemini');
    assert.deepEqual(providers.map((p) => `${p.name}:${p.model}`), ['gemini:gemini-a', 'gemini:gemini-b']);
    assert.equal(getAiProvider()?.name, 'gemini');
  });

  test('AI_PROVIDER=claude-cli builds the CLI provider with the configured model', () => {
    Object.assign(env, { AI_PROVIDER: 'claude-cli', GEMINI_API_KEY: undefined, CLAUDE_MODEL: 'sonnet', CLAUDE_CLI_COMMAND: FAKE_CLAUDE });
    const [p] = createProviders('claude-cli');
    assert.ok(p instanceof ClaudeCliProvider);
    assert.equal(p.model, 'sonnet');
    assert.equal(aiIsConfigured(), true);
    assert.equal(getAiProvider()?.name, 'claude-cli');
  });

  test('switching AI_PROVIDER switches provider after a reset, without code changes', () => {
    Object.assign(env, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'test-key' });
    assert.equal(getAiProvider()?.name, 'gemini');
    env.AI_PROVIDER = 'claude-cli';
    resetAiProvider();
    assert.equal(getAiProvider()?.name, 'claude-cli');
  });

  test('no silent cross-provider fallback: other keys are ignored unless AI_FALLBACK_PROVIDER is set', async () => {
    Object.assign(env, { AI_PROVIDER: 'claude-cli', CLAUDE_CLI_COMMAND: '/nonexistent/claude', GEMINI_API_KEY: 'test-key', AI_FALLBACK_PROVIDER: undefined });
    const only = getAiProvider()!;
    await assert.rejects(only.generate(request), /Claude CLI not found/);

    resetAiProvider();
    env.AI_FALLBACK_PROVIDER = 'gemini';
    const withFallback = getAiProvider() as InstanceType<typeof FailoverProvider>;
    assert.match(withFallback.status().active, /claude-cli/);
    // Internal order is primary first, then the explicit fallback.
    const names = (withFallback as unknown as { providers: AiProvider[] }).providers.map((p) => p.name);
    assert.deepEqual(names, ['claude-cli', 'gemini']);
  });

  test('a missing Gemini key is reported, not papered over', async () => {
    Object.assign(env, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: undefined, AI_FALLBACK_PROVIDER: undefined });
    assert.throws(() => createProviders('gemini'), AiConfigError);
    assert.equal(getAiProvider(), null, 'the pipeline runs deterministically instead');
    const health = await checkAIProvider('gemini');
    assert.equal(health.available, false);
    assert.match(health.reason!, /GEMINI_API_KEY/);
  });
});

describe('Claude CLI provider', () => {
  isolateEnv();
  test('passes a safe argument vector: JSON output, no tools, prompt on stdin', async () => {
    const res = await cli({ model: 'sonnet', effort: 'low' }).generate(request);
    const body = JSON.parse(res.text) as { args: string[]; stdinLength: number; maxTokens: string; leaked: string[] };
    assert.equal(res.provider, 'claude-cli');
    assert.deepEqual(body.args.slice(0, 3), ['-p', '--output-format', 'json']);
    assert.ok(body.args.includes('--no-session-persistence'));
    assert.equal(body.args[body.args.indexOf('--tools') + 1], '', 'all tools disabled');
    assert.equal(body.args[body.args.indexOf('--model') + 1], 'sonnet');
    assert.equal(body.args[body.args.indexOf('--effort') + 1], 'low');
    assert.ok(!body.args.includes(request.user), 'the user prompt is not on the command line');
    assert.equal(body.stdinLength, request.user.length);
    assert.equal(body.maxTokens, '1024');
    assert.equal(res.model, 'fake-model');
    assert.deepEqual(res.usage, { promptTokens: 15, completionTokens: 7, totalTokens: 22 });
  });

  test('without CLAUDE_MODEL no --model flag is passed', () => {
    const args = buildCliArgs({ command: 'claude', timeoutMs: 1000 }, 'sys');
    assert.ok(!args.includes('--model'));
    assert.ok(!args.includes('--bare'), '--bare would ignore the logged-in session');
  });

  test('API keys and app secrets are withheld from the CLI process', async () => {
    const before = { a: process.env.ANTHROPIC_API_KEY, g: process.env.GEMINI_API_KEY, t: process.env.GITHUB_TOKEN };
    Object.assign(process.env, { ANTHROPIC_API_KEY: 'sk-ant-should-not-pass', GEMINI_API_KEY: 'x', GITHUB_TOKEN: 'y' });
    try {
      const res = await cli().generate(request);
      assert.deepEqual((JSON.parse(res.text) as { leaked: string[] }).leaked, []);
    } finally {
      for (const [k, v] of [['ANTHROPIC_API_KEY', before.a], ['GEMINI_API_KEY', before.g], ['GITHUB_TOKEN', before.t]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });

  test('a missing CLI is a clear, permanent error', async () => {
    await assert.rejects(cli({ command: '/nonexistent/claude-cli-xyz' }).generate(request), (e: Error) => {
      assert.match(e.message, /Claude CLI not found/);
      assert.ok(isPermanentProviderError(e));
      return true;
    });
    Object.assign(env, { CLAUDE_CLI_COMMAND: '/nonexistent/claude-cli-xyz' });
    assert.deepEqual(await checkAIProvider('claude-cli'), {
      provider: 'claude-cli', model: 'cli-default', available: false, reason: 'Claude CLI not found',
    });
  });

  test('a non-zero exit reports the exit code and stderr', async () => {
    process.env.FAKE_CLAUDE_MODE = 'fail';
    await assert.rejects(cli().generate(request), /exited with code 2.*something broke/);
  });

  test('an error envelope keeps the API status so rate limits are retryable', async () => {
    process.env.FAKE_CLAUDE_MODE = 'api-error';
    await assert.rejects(cli().generate(request), (e: InstanceType<typeof AiProviderError>) => e.status === 429 && e.retryable);
  });

  test('a logged-out CLI is a permanent error', async () => {
    process.env.FAKE_CLAUDE_MODE = 'logged-out';
    await assert.rejects(cli().generate(request), (e: Error) => isPermanentProviderError(e) && /Not logged in/.test(e.message));
  });

  test('output that is not the JSON envelope is an error, not an answer', async () => {
    process.env.FAKE_CLAUDE_MODE = 'garbage';
    await assert.rejects(cli().generate(request), /not the expected JSON envelope/);
  });

  test('a hung CLI is killed at the timeout', async () => {
    process.env.FAKE_CLAUDE_MODE = 'hang';
    const started = Date.now();
    await assert.rejects(cli({ timeoutMs: 300 }).generate(request), /timed out after 300ms/);
    assert.ok(Date.now() - started < 5000);
  });

  test('health check reads only the logged-in flag and makes no model call', async () => {
    Object.assign(env, { CLAUDE_CLI_COMMAND: FAKE_CLAUDE, CLAUDE_MODEL: undefined });
    const ok = await checkAIProvider('claude-cli');
    assert.deepEqual(ok, { provider: 'claude-cli', model: 'cli-default', version: '9.9.9 (Claude Code)', available: true });
    assert.ok(!JSON.stringify(ok).includes('example.com'), 'account details are not surfaced');

    process.env.FAKE_CLAUDE_MODE = 'logged-out';
    const out = await checkAIProvider('claude-cli');
    assert.equal(out.available, false);
    assert.match(out.reason!, /not logged in/);
  });
});

/* -------------------------------------------------------------------------- */

function counting(text: () => string): AiProvider & { calls: AiRequest[] } {
  return {
    name: 'fake', model: 'fake-1', calls: [],
    estimateCost: () => 0,
    async generate(r: AiRequest) {
      this.calls.push(r);
      return { text: text(), usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: 'fake-1', provider: 'fake' };
    },
  };
}
const Schema = z.object({ answer: z.string() });
let seq = 0;
const agentOpts = (user: string) => ({
  agent: 'ChangeAnalyzer' as const, projectId: null, runId: null, system: 'sys', user, schema: Schema,
  fallback: () => ({ answer: 'fallback' }),
});

describe('runAgent with providers', () => {
  isolateEnv();
  beforeEach(() => { seq++; });

  test('cache miss calls the provider; an identical request is then a cache hit', async () => {
    const p = counting(() => '{"answer":"from model"}');
    setAiProvider(p);
    const first = await runAgent(agentOpts(`cache test ${seq}`));
    const second = await runAgent(agentOpts(`cache test ${seq}`));
    assert.equal(first.source, 'ai');
    assert.equal(second.source, 'cache');
    assert.equal(second.data.answer, 'from model');
    assert.equal(p.calls.length, 1, 'the second identical request never reached the provider');

    const changed = await runAgent(agentOpts(`cache test ${seq} with a changed diff`));
    assert.equal(changed.source, 'ai');
    assert.equal(p.calls.length, 2, 'different input is a miss');
  });

  test('AI_CACHE_ENABLED=false always calls the provider', async () => {
    env.AI_CACHE_ENABLED = false;
    const p = counting(() => '{"answer":"x"}');
    setAiProvider(p);
    await runAgent(agentOpts(`nocache ${seq}`));
    await runAgent(agentOpts(`nocache ${seq}`));
    assert.equal(p.calls.length, 2);
  });

  test('malformed JSON from the Claude CLI falls back instead of being trusted', async () => {
    process.env.FAKE_CLAUDE_MODE = 'malformed';
    setAiProvider(cli());
    const res = await runAgent(agentOpts(`malformed ${seq}`));
    assert.equal(res.source, 'fallback');
    assert.equal(res.data.answer, 'fallback');
    assert.match(res.error!, /JSON/);
  });

  test('a valid Claude CLI answer is validated and returned', async () => {
    setAiProvider(cli());
    const res = await runAgent({
      agent: 'ChangeAnalyzer', projectId: null, runId: null, system: 'sys', user: `cli ok ${seq}`,
      schema: z.object({ ok: z.boolean() }), fallback: () => ({ ok: false }),
    });
    assert.equal(res.source, 'ai');
    assert.equal(res.data.ok, true);
  });

  test('output tokens are capped by AI_MAX_OUTPUT_TOKENS and oversized input is reduced', async () => {
    Object.assign(env, { AI_MAX_OUTPUT_TOKENS: 1000, AI_MAX_INPUT_CHARS: 5000 });
    const p = counting(() => '{"answer":"x"}');
    setAiProvider(p);
    await runAgent({ ...agentOpts(`${'x'.repeat(20_000)} ${seq}`), maxOutputTokens: 8192 });
    const sent = p.calls[0]!;
    assert.equal(sent.maxOutputTokens, 1000);
    assert.ok(sent.user.length <= 5000, `user prompt was ${sent.user.length} chars`);
    assert.match(sent.user, /CONTEXT REDUCED/);
  });
});

describe('context budgeting and relevance', () => {
  isolateEnv();
  test('packContext drops the least important sections first and says so', () => {
    const packed = packContext([
      { title: 'TASK', body: 'diagnose', priority: Priority.task, required: true },
      { title: 'CHANGE', body: 'c'.repeat(1500), priority: Priority.change },
      { title: 'RELATED TESTS', body: 't'.repeat(1500), priority: Priority.relatedTests },
      { title: 'HISTORY', body: 'h'.repeat(3000), priority: Priority.history },
    ], 3600);
    assert.equal(packed.reduced, true);
    assert.ok(packed.text.length <= 3600);
    assert.ok(packed.text.includes('c'.repeat(1500)) && packed.text.includes('t'.repeat(1500)));
    assert.deepEqual(packed.omitted, ['HISTORY']);
    assert.match(packed.text, /omitted HISTORY/);
    // Original order is preserved for what remains.
    assert.ok(packed.text.indexOf('TASK') < packed.text.indexOf('CHANGE'));
  });

  test('packContext leaves a prompt that fits untouched', () => {
    const packed = packContext([{ title: 'A', body: 'b', priority: 0 }], 1000);
    assert.deepEqual(packed, { text: 'A\nb', omitted: [], truncated: [], reduced: false });
  });

  test('compactPatch keeps changed lines and trims context', () => {
    const patch = ['@@ -1,9 +1,9 @@', ' a', ' b', ' c', '-old', '+new', ' d', ' e', ' f'].join('\n');
    assert.equal(compactPatch(patch), ['@@ -1,9 +1,9 @@', ' ...', ' c', '-old', '+new', ' d'].join('\n'));
  });

  test('renderDiff honours the file and character budgets', () => {
    const files = Array.from({ length: 12 }, (_, i) => ({
      path: `src/f${i}.ts`, status: 'modified', additions: 12 - i, deletions: 0,
      patch: `@@ -1 +1 @@\n-a${i}\n+${'b'.repeat(3000)}`,
    }));
    const text = renderDiff({
      previousCommitSha: 'aaaaaaaa', currentCommitSha: 'bbbbbbbb', files,
      changedFunctions: [], changedComponents: [], changedRoutes: [], changedApis: [], changedValidations: [], commits: [],
    }, { maxChars: 8000, maxPatchFiles: 3 });
    assert.ok(text.length <= 8100);
    assert.equal((text.match(/^--- src\/f\d+\.ts ---$/gm) ?? []).length, 3, 'only the three largest patches');
    assert.match(text, /9 smaller patch\(es\) not shown/);
  });

  test('only tests related to the feature are selected', () => {
    const t = (file: string, visits: string[] = [], titles: string[] = []) => ({ file, kind: 'spec' as const, titles, selectorsUsed: [], pageObjects: [], commands: [], visits });
    const all = [t('e2e/billing.spec.ts'), t('e2e/users/UserPage.spec.ts'), t('e2e/smoke.spec.ts', ['/users']), t('e2e/reports.spec.ts')];
    const { selected, skipped } = rankTests(all, { names: ['UserPage'], routes: ['/users'], files: ['src/pages/users/UserPage.jsx'] }, 10);
    // The spec that visits /users ranks first, then the one named after the page.
    assert.deepEqual(selected.map((s) => s.file), ['e2e/smoke.spec.ts', 'e2e/users/UserPage.spec.ts']);
    assert.equal(skipped, 2);
  });

  test('existing-test context is capped at AI_MAX_TESTS_PER_REQUEST and notes what was left out', () => {
    const specs = Array.from({ length: 30 }, (_, i) => ({ file: `e2e/users-${i}.spec.ts`, kind: 'spec' as const, titles: [`t${i}`], selectorsUsed: [], pageObjects: [], commands: [], visits: [] }));
    const text = renderExistingTestInfrastructure({ existingTests: specs } as never, { subject: { names: ['users'] }, maxTests: 5 });
    assert.equal((text.match(/users-\d+\.spec\.ts:/g) ?? []).length, 5);
    assert.match(text, /25 unrelated specs not shown/);
  });
});

describe('generated test validation', () => {
  isolateEnv();
  const evidence = 'selector=[data-testid="email-input"] selector=[data-testid="save-btn"] #login-form';
  const output = (tests: { title: string; body: string }[], locators = [{ name: 'email', selector: '[data-testid="email-input"]' }]) => ({
    pageObjects: [{
      className: 'LoginPage', fileName: 'login.page.ts',
      locators: locators.map((l) => ({ ...l, strategy: 'data-testid', rationale: 'r' })),
      methods: [{ name: 'fillEmail', params: [], body: "await this.page.locator(this.locators.email).fill('a@b.co');" }],
    }],
    specs: [{ fileName: 'login.spec.ts', feature: 'login', describe: 'Login', imports: [], tests: tests.map((t, i) => ({ scenarioId: `SC-${i}`, tags: [], ...t })) }],
    fixtures: [], reusedExistingArtifacts: [], notes: [],
  }) as never;

  test('keeps a clean test', () => {
    const res = validateGeneratedTests(output([{ title: 'saves', body: "await loginPage.fillEmail();\nawait page.locator('[data-testid=\"save-btn\"]').click();" }]), { evidenceText: evidence });
    assert.equal(res.removedTests, 0);
    assert.deepEqual(res.issues, []);
  });

  test('removes hard waits, forced clicks, invented selectors, duplicates and syntax errors', () => {
    const res = validateGeneratedTests(output([
      { title: 'waits', body: 'await page.waitForTimeout(5000);' },
      { title: 'forces', body: "await page.locator('#login-form').click({ force: true });" },
      { title: 'invents', body: "await page.locator('[data-testid=\"made-up\"]').click();" },
      { title: 'invents a test id', body: "await page.getByTestId('made-up-too').click();" },
      { title: 'forgets to await', body: "expect(page.locator('#login-form')).toBeVisible();" },
      { title: 'already exists', body: "await expect(page.locator('#login-form')).toHaveCount(1);" },
      { title: 'broken', body: "await page.locator('#login-form'.click(;" },
      { title: 'fine', body: "await expect(page.locator('#login-form')).toBeVisible();" },
      { title: 'Fine', body: "await expect(page.locator('#login-form')).toBeVisible();" },
    ]), { evidenceText: evidence, existingTitles: ['Already exists'] });
    const kept = (res.output as { specs: { tests: { title: string }[] }[] }).specs[0]!.tests.map((t) => t.title);
    assert.deepEqual(kept, ['fine']);
    assert.equal(res.removedTests, 8);
    const problems = res.issues.map((i) => i.problem).join('\n');
    for (const p of [/hard wait/, /force: true/, /made-up.*not in the evidence/, /test id made-up-too/, /does not await/, /duplicates/, /not valid TypeScript/]) assert.match(problems, p);
  });

  test('an invented locator takes the methods and tests that use it with it', () => {
    const res = validateGeneratedTests(output(
      [{ title: 'uses method', body: 'await loginPage.fillEmail();' }],
      [{ name: 'email', selector: '[data-testid="ghost"]' }],
    ), { evidenceText: evidence });
    assert.equal(res.removedTests, 1);
    assert.match(res.issues.map((i) => i.problem).join('\n'), /rejected method fillEmail/);
  });

  test('grounding accepts a selector whose attribute value is in the evidence', () => {
    assert.ok(selectorIsGrounded('[data-testid="save-btn"]', 'data-testid="save-btn" on <button>'));
    assert.ok(selectorIsGrounded('#login-form', evidence));
    assert.ok(!selectorIsGrounded('.btn-primary', evidence));
  });
});
