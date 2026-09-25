/**
 * Agent runner (spec sections 25 and 26).
 *
 * Every agent goes through here, which is what makes the guarantees uniform:
 *   - a dedicated system prompt per agent, never one giant prompt
 *   - structured JSON output validated against a zod schema
 *   - one repair retry that shows the model its own validation errors
 *   - backoff on retryable provider errors (429 from a free-tier key)
 *   - a response cache keyed on the exact prompt
 *   - usage/cost recorded for every call, including cache hits and failures
 *   - a deterministic fallback so the pipeline never dies because AI did
 */
import type { z } from 'zod';
import type { AgentName } from '@qa-agent/shared';
import { getAiProvider } from '../ai/factory.js';
import { AiProviderError } from '../ai/provider.js';
import { AiOutputError, issuesToInstruction, parseAndValidate, toJsonSchema } from '../ai/json.js';
import { cacheKey, readCache, writeCache } from '../ai/cache.js';
import { recordUsage } from '../ai/cost.js';
import { acquireSlot, noteRateLimited, rateLimitDelayMs } from '../ai/rateLimiter.js';
import { packContext, userBudget } from '../ai/contextBudget.js';
import { env } from '../config/env.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('agent');

export type AgentResultSource = 'ai' | 'cache' | 'fallback';

export interface AgentResult<T> {
  data: T;
  source: AgentResultSource;
  /** Populated when the AI path failed and the fallback was used. */
  error?: string;
}

export interface RunAgentOptions<S extends z.ZodTypeAny> {
  agent: AgentName;
  projectId: string | null;
  runId: string | null;
  system: string;
  user: string;
  schema: S;
  /**
   * Deterministic result used when AI is unavailable or keeps failing.
   * Required: no agent is allowed to be a hard dependency on the model.
   */
  fallback: () => z.infer<S>;
  temperature?: number;
  maxOutputTokens?: number;
  /** Set false for prompts that should always hit the model (rare). */
  useCache?: boolean;
}

const MAX_PROVIDER_ATTEMPTS = 3;
/** Rate limits get more patience: a free tier's window is a full minute. */
const MAX_RATE_LIMIT_ATTEMPTS = 5;

function backoffMs(attempt: number): number {
  return Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runAgent<S extends z.ZodTypeAny>(opts: RunAgentOptions<S>): Promise<AgentResult<z.infer<S>>> {
  const provider = getAiProvider();
  const useCache = opts.useCache !== false && env.AI_CACHE_ENABLED;
  const maxOutputTokens = Math.min(opts.maxOutputTokens ?? env.AI_MAX_OUTPUT_TOKENS, env.AI_MAX_OUTPUT_TOKENS);

  if (!provider) {
    log.info(`${opts.agent}: no AI provider configured, using deterministic fallback.`);
    return { data: opts.fallback(), source: 'fallback', error: 'AI provider not configured.' };
  }

  // Agents budget their own sections by priority; this is the backstop for
  // whatever still exceeds AI_MAX_INPUT_CHARS.
  const user = opts.system.length + opts.user.length > env.AI_MAX_INPUT_CHARS
    ? packContext([{ title: '', body: opts.user, priority: 0, required: true }], userBudget(opts.system), opts.agent).text
    : opts.user;

  const key = cacheKey({
    agent: opts.agent, provider: provider.name, model: provider.model,
    system: opts.system, user,
  });

  if (useCache) {
    const cached = await readCache(key);
    if (cached) {
      try {
        const data = parseAndValidate(opts.schema, cached.text);
        await recordUsage({
          projectId: opts.projectId, runId: opts.runId, agent: opts.agent,
          provider: provider.name, model: provider.model,
          promptTokens: cached.promptTokens, completionTokens: cached.completionTokens,
          estimatedCostUsd: 0, cached: true, failed: false, durationMs: 0,
        });
        log.info(`${opts.agent}: served from cache.`);
        return { data, source: 'cache' };
      } catch {
        log.warn(`${opts.agent}: cached response no longer validates; re-querying.`);
      }
    }
  }

  const responseSchema = (() => {
    try { return toJsonSchema(opts.schema); } catch { return undefined; }
  })();

  let correction = '';
  let lastError = '';

  let rateLimited = 0;
  for (let attempt = 0; attempt < MAX_PROVIDER_ATTEMPTS + rateLimited; attempt++) {
    const started = Date.now();
    try {
      await acquireSlot();
      const response = await provider.generate({
        agent: opts.agent,
        system: opts.system,
        user: correction ? `${user}\n\n---\n${correction}` : user,
        responseSchema,
        temperature: opts.temperature,
        maxOutputTokens,
      });

      const data = parseAndValidate(opts.schema, response.text);

      await recordUsage({
        projectId: opts.projectId, runId: opts.runId, agent: opts.agent,
        provider: provider.name, model: provider.model,
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
        estimatedCostUsd: provider.estimateCost(response.usage),
        cached: false, failed: false, durationMs: Date.now() - started,
      });

      if (useCache) {
        await writeCache({
          key, projectId: opts.projectId, agent: opts.agent,
          provider: provider.name, model: provider.model, text: response.text,
          promptTokens: response.usage.promptTokens,
          completionTokens: response.usage.completionTokens,
        });
      }

      log.info(`${opts.agent}: completed in ${Date.now() - started}ms (${response.usage.totalTokens} tokens).`);
      return { data, source: 'ai' };

    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);

      await recordUsage({
        projectId: opts.projectId, runId: opts.runId, agent: opts.agent,
        provider: provider.name, model: provider.model,
        promptTokens: 0, completionTokens: 0, estimatedCostUsd: 0,
        cached: false, failed: true, error: lastError, durationMs: Date.now() - started,
      });

      if (e instanceof AiOutputError) {
        // The model answered but malformed it: show it the errors and retry once.
        correction = issuesToInstruction(e.issues);
        log.warn(`${opts.agent}: output validation failed (attempt ${attempt + 1}). ${e.message}`);
        continue;
      }
      if (e instanceof AiProviderError && e.status === 429 && rateLimited < MAX_RATE_LIMIT_ATTEMPTS) {
        noteRateLimited();
        const delay = rateLimitDelayMs(lastError, rateLimited);
        rateLimited++;
        log.warn(`${opts.agent}: rate limited, waiting ${Math.round(delay / 1000)}s before retry ${rateLimited}/${MAX_RATE_LIMIT_ATTEMPTS}.`);
        await sleep(delay);
        continue;
      }
      if (e instanceof AiProviderError && e.retryable && attempt < MAX_PROVIDER_ATTEMPTS + rateLimited - 1) {
        const delay = backoffMs(attempt);
        log.warn(`${opts.agent}: retryable provider error (${e.status ?? 'network'}), retrying in ${delay}ms.`);
        await sleep(delay);
        continue;
      }
      break;
    }
  }

  log.warn(`${opts.agent}: falling back to deterministic output. Last error: ${lastError}`);
  return { data: opts.fallback(), source: 'fallback', error: lastError };
}

/**
 * Shared preamble. Every agent inherits the epistemic discipline the spec
 * demands in section 28 - the single most important rule in the system.
 */
export const SAFETY_PREAMBLE = `
You are part of an autonomous QA engineering system that analyses real
applications. Your output is used to generate tests and to write reports that
engineers act on, so correctness matters more than completeness.

Absolute rules:
1. Separate OBSERVED, INFERRED and UNKNOWN.
   - OBSERVED: directly present in the evidence you were given. Quote or cite it.
   - INFERRED: a reasonable conclusion drawn from observed facts. Mark it as such.
   - UNKNOWN: you genuinely cannot tell from the evidence. Say so.
2. Never present an inference as a confirmed business requirement.
3. Never invent routes, components, fields, API endpoints, roles or selectors
   that do not appear in the evidence provided.
4. If the evidence is thin, return fewer items with honest confidence rather
   than more items with invented detail.
5. Confidence is a calibrated probability, not enthusiasm. Reserve >0.9 for
   things that are literally written in the code.
6. Return JSON only - no prose, no markdown fences, no commentary.
`.trim();

/** Keeps prompts inside a sane budget (spec section 26). */
export function truncate(text: string, maxChars: number, label = 'content'): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... [${label} truncated, ${text.length - maxChars} more characters]`;
}

/** Renders a list for a prompt, capped and counted honestly. */
export function bulletList(items: string[], max = 60): string {
  if (items.length === 0) return '  (none found)';
  const shown = items.slice(0, max).map((i) => `  - ${i}`).join('\n');
  return items.length > max ? `${shown}\n  ... and ${items.length - max} more` : shown;
}
