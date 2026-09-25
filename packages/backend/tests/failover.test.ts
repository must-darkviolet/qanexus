/** Provider failover: permanent errors switch provider, transient ones do not. */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { FailoverProvider, isPermanentProviderError } from '../src/ai/failover.js';
import { AiProviderError, type AiProvider, type AiRequest } from '../src/ai/provider.js';

function fake(name: string, behaviour: () => string): AiProvider & { calls: number } {
  return {
    name, model: `${name}-model`, calls: 0,
    estimateCost: () => 0,
    async generate(_r: AiRequest) {
      this.calls++;
      return { text: behaviour(), usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: `${name}-model`, provider: name };
    },
  };
}
const request = { agent: 'x', system: 's', user: 'u' } as AiRequest;

describe('provider failover', () => {
  test('an out-of-credits provider is skipped for the rest of the session', async () => {
    const openai = fake('openai', () => { throw new AiProviderError('OpenAI request failed (429): insufficient_quota', true, 429); });
    const gemini = fake('gemini', () => '{"ok":true}');
    const p = new FailoverProvider([openai, gemini]);
    assert.equal((await p.generate(request)).provider, 'gemini');
    assert.equal(p.name, 'gemini');
    await p.generate(request);
    assert.equal(openai.calls, 1, 'the exhausted provider is not retried');
    assert.match(Object.values(p.status().unavailable)[0]!, /insufficient_quota/);
  });

  test('a busy model hands the request to the next one and is cooled down', async () => {
    const busy = fake('gemini', () => { throw new AiProviderError('[503 Service Unavailable] This model is currently experiencing high demand', true, 503); });
    const other = fake('gemini-b', () => '{"ok":true}');
    const p = new FailoverProvider([busy, other]);
    assert.equal((await p.generate(request)).provider, 'gemini-b');
    await p.generate(request);
    assert.equal(busy.calls, 1, 'the cooling model is skipped while a healthy one exists');
    assert.equal(p.exhausted, false, 'a busy model is not taken out of rotation for good');
  });

  test('when every model is only busy, the error is rethrown for backoff', async () => {
    const a = fake('a', () => { throw new AiProviderError('[429 Too Many Requests] per-minute rate limit', true, 429); });
    const b = fake('b', () => { throw new AiProviderError('[503] overloaded', true, 503); });
    const p = new FailoverProvider([a, b]);
    await assert.rejects(p.generate(request), (e: AiProviderError) => e.retryable === true);
    assert.equal(p.exhausted, false);
  });

  test('an exhausted daily quota stops AI for the run: no retry, no further requests', async () => {
    const daily = '[429 Too Many Requests] Quota exceeded for metric: generate_content_free_tier_requests, limit: 20 "quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier" Please retry in 58s.';
    const gemini = fake('gemini', () => { throw new AiProviderError(daily, true, 429); });
    const p = new FailoverProvider([gemini]);
    await assert.rejects(p.generate(request), (e: AiProviderError) => e.retryable === false && e.status === undefined);
    assert.equal(p.exhausted, true);
    await assert.rejects(p.generate(request), /No AI provider is available/);
    assert.equal(gemini.calls, 1, 'no request is sent once the quota is known to be exhausted');
  });

  test('classifies retired models and bad keys as permanent', () => {
    assert.ok(isPermanentProviderError(new AiProviderError('[404 Not Found] This model is no longer available', false, 404)));
    assert.ok(isPermanentProviderError(new AiProviderError('API key not valid', false, 400)));
    assert.ok(!isPermanentProviderError(new AiProviderError('[503] overloaded', true, 503)));
  });
});

describe('rate-limit pacing', () => {
  test('honours the provider retry hint, otherwise waits out the minute window', async () => {
    const { rateLimitDelayMs } = await import('../src/ai/rateLimiter.js');
    assert.equal(rateLimitDelayMs('Please retry in 27.3s.', 0), 27_800);
    assert.equal(rateLimitDelayMs('"retryDelay": "12s"', 0), 12_500);
    const fallback = rateLimitDelayMs('You exceeded your current quota', 0);
    assert.ok(fallback >= 15_000 && fallback < 17_000);
  });

  test('after a 429 the ceiling drops below the observed request rate', async () => {
    const { acquireSlot, noteRateLimited, resetPacing } = await import('../src/ai/rateLimiter.js');
    resetPacing(0);
    for (let i = 0; i < 6; i++) await acquireSlot();
    noteRateLimited();
    // Five slots are allowed per minute now; six are already used, so a
    // seventh would wait. Racing it against a short timer proves it blocks.
    const outcome = await Promise.race([
      acquireSlot().then(() => 'sent'),
      new Promise((r) => setTimeout(() => r('paced'), 100)),
    ]);
    assert.equal(outcome, 'paced');
    resetPacing(0);
  });
});
