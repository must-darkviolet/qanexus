import { aiIsConfigured, env, providerIsConfigured, type AiProviderName } from '../config/env.js';
import { createLogger } from '../util/logger.js';
import { GeminiProvider } from './gemini.js';
import { OpenAIProvider } from './futureProviders.js';
import { ClaudeCliProvider } from './claudeCli.js';
import type { AiProvider } from './provider.js';
import { FailoverProvider } from './failover.js';

const log = createLogger('ai:factory');
let cached: AiProvider | null | undefined;

/** A provider was selected that cannot be built from the current configuration. */
export class AiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiConfigError';
  }
}

/**
 * Builds one provider by name. Gemini expands to the configured model plus
 * GEMINI_FALLBACK_MODELS: free-tier quotas are per model, so other models on
 * the same key are genuine fallbacks, not just the same limit under another name.
 */
export function createProviders(name: AiProviderName): AiProvider[] {
  switch (name) {
    case 'gemini': {
      if (!env.GEMINI_API_KEY) throw new AiConfigError('AI_PROVIDER=gemini needs GEMINI_API_KEY.');
      const extra = env.GEMINI_FALLBACK_MODELS.split(',').map((m) => m.trim())
        .filter((m) => m && m !== env.GEMINI_MODEL)
        .map((m) => new GeminiProvider(env.GEMINI_API_KEY!, m));
      return [new GeminiProvider(env.GEMINI_API_KEY, env.GEMINI_MODEL), ...extra];
    }
    case 'claude-cli':
      return [new ClaudeCliProvider({
        command: env.CLAUDE_CLI_COMMAND,
        model: env.CLAUDE_MODEL,
        timeoutMs: env.CLAUDE_CLI_TIMEOUT_MS,
        effort: env.CLAUDE_CLI_EFFORT,
      })];
    case 'openai':
      if (!env.OPENAI_API_KEY) throw new AiConfigError('AI_PROVIDER=openai needs OPENAI_API_KEY.');
      return [new OpenAIProvider(env.OPENAI_API_KEY, env.OPENAI_MODEL)];
    default:
      throw new AiConfigError(`Unsupported AI provider "${String(name)}".`);
  }
}

/**
 * Returns the configured provider, or null when no AI is available.
 * Null is a supported state: the pipeline then runs deterministically
 * (spec section 26).
 *
 * Only AI_PROVIDER is used, plus AI_FALLBACK_PROVIDER when it is set. There
 * is no silent switch to some other provider that happens to have a key.
 */
export function getAiProvider(): AiProvider | null {
  if (cached !== undefined) return cached;

  if (!aiIsConfigured()) {
    log.warn(
      env.AI_DISABLED
        ? 'AI_DISABLED=1 - running with deterministic analysis only.'
        : `AI_PROVIDER=${env.AI_PROVIDER} is not configured (${env.AI_PROVIDER === 'gemini' ? 'GEMINI_API_KEY is empty' : 'missing settings'}) - running with deterministic analysis only.`,
    );
    cached = null;
    return cached;
  }

  const names = [env.AI_PROVIDER, env.AI_FALLBACK_PROVIDER]
    .filter((n, i, all): n is AiProviderName => Boolean(n) && all.indexOf(n) === i);
  const providers = names.flatMap((name) => {
    if (!providerIsConfigured(name)) {
      log.warn(`AI provider "${name}" is not configured and is skipped.`);
      return [];
    }
    return createProviders(name);
  });

  // Always wrapped, even with one provider, so an exhausted provider is
  // remembered and later calls fail fast instead of each waiting on retries.
  cached = new FailoverProvider(providers);
  log.info(`AI provider ready: ${providers.map((p) => `${p.name} (${p.model})`).join(' -> failover -> ')}.`);
  return cached;
}

/** Test seam: lets tests inject a fake provider. */
export function setAiProvider(provider: AiProvider | null): void {
  cached = provider;
}

export function resetAiProvider(): void {
  cached = undefined;
}
