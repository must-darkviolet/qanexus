/**
 * Provider failover.
 *
 * Providers (and, for Gemini, several models on one key) are tried in order.
 * Two kinds of trouble are handled differently:
 *
 *   - Permanent for this run: no credits, invalid key, retired model, an
 *     exhausted daily quota. The provider is taken out of rotation for good.
 *   - Temporary: overloaded (503) or a per-minute rate limit (429). The
 *     provider is cooled down briefly and the request moves on to the next
 *     one immediately, instead of waiting on a busy model.
 *
 * Only when nothing is left to try does the error reach runAgent, which then
 * backs off (temporary) or falls back to the deterministic path (permanent).
 */
import { AiProviderError, type AiProvider, type AiRequest, type AiResponse, type AiUsage } from './provider.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('ai:failover');
const OVERLOAD_COOLDOWN_MS = 120_000;
const RATE_LIMIT_COOLDOWN_MS = 60_000;

/**
 * A per-day quota (e.g. Gemini free tier "GenerateRequestsPerDay...") will not
 * recover within a run, whatever retry hint accompanies it.
 */
export function isDailyQuotaError(e: unknown): boolean {
  return e instanceof AiProviderError && /PerDay|per[ _-]?day|daily (limit|quota)|requests? per day/i.test(e.message);
}

/** Errors that will not go away by retrying the same provider. */
export function isPermanentProviderError(e: unknown): boolean {
  if (!(e instanceof AiProviderError)) return false;
  if (e.status === 401 || e.status === 403 || e.status === 404) return true;
  return isDailyQuotaError(e)
    || /insufficient_quota|no credits|billing|no longer available|not found for api version|api key not valid|invalid api key|permission_denied|model .* does not exist|claude cli not found|claude cli error.*(usage limit|limit reached)|not logged in|please run \/login|could not be started/i
      .test(e.message);
}

/** Busy right now, likely fine again in a minute or two. */
export function isTemporaryProviderError(e: unknown): boolean {
  if (!(e instanceof AiProviderError) || isPermanentProviderError(e)) return false;
  return e.status === 429 || e.status === 503 || e.status === 529
    || /high demand|overloaded|unavailable|resource_exhausted/i.test(e.message);
}

function summarize(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (isDailyQuotaError(e)) return 'daily quota exhausted';
  // Provider errors often embed a JSON body; its "message" is the useful part.
  const fromJson = raw.match(/"message":\s*"([^"]+)"/)?.[1];
  const fromBracket = raw.match(/\[(\d{3}[^\]]*)\]\s*([^.]{0,120})/);
  return (fromJson ?? (fromBracket ? `${fromBracket[1]}: ${fromBracket[2]}` : raw.replace(/\s+/g, ' '))).slice(0, 160);
}

export class FailoverProvider implements AiProvider {
  private active = 0;
  private readonly unavailable = new Map<string, string>();
  private readonly coolingUntil = new Map<number, number>();

  constructor(private readonly providers: AiProvider[]) {
    if (providers.length === 0) throw new Error('FailoverProvider needs at least one provider.');
  }

  private label(p: AiProvider): string { return `${p.name} (${p.model})`; }
  private get current(): AiProvider { return this.providers[this.active]!; }
  get name(): string { return this.current.name; }
  get model(): string { return this.current.model; }
  estimateCost(usage: AiUsage): number { return this.current.estimateCost(usage); }

  /** Providers taken out of rotation this session, and why. */
  status(): { active: string; unavailable: Record<string, string> } {
    return { active: this.label(this.current), unavailable: Object.fromEntries(this.unavailable) };
  }

  /** True once every provider has been taken out of rotation. */
  get exhausted(): boolean { return this.unavailable.size >= this.providers.length; }

  private usable(i: number): boolean {
    return !this.unavailable.has(this.label(this.providers[i]!));
  }

  async generate(request: AiRequest): Promise<AiResponse> {
    if (this.exhausted) {
      // Fail fast: no request is sent, so nothing more is spent or waited on.
      throw new AiProviderError(
        `No AI provider is available for the rest of this run: ${[...this.unavailable].map(([k, v]) => `${k} - ${v}`).join('; ')}`,
        false,
      );
    }

    // Healthy providers first, in configured order; cooling ones only as a last resort.
    const now = Date.now();
    const order = this.providers.map((_, i) => i).filter((i) => this.usable(i));
    const healthy = order.filter((i) => (this.coolingUntil.get(i) ?? 0) <= now);
    const cooling = order.filter((i) => (this.coolingUntil.get(i) ?? 0) > now)
      .sort((a, b) => (this.coolingUntil.get(a) ?? 0) - (this.coolingUntil.get(b) ?? 0));

    let lastError: unknown;
    for (const i of [...healthy, ...cooling]) {
      const provider = this.providers[i]!;
      try {
        const response = await provider.generate(request);
        if (this.active !== i) {
          this.active = i;
          log.info(`Now using ${this.label(provider)}.`);
        }
        this.coolingUntil.delete(i);
        return response;
      } catch (e) {
        lastError = e;
        if (isPermanentProviderError(e)) {
          this.unavailable.set(this.label(provider), summarize(e));
          log.warn(`${this.label(provider)} is unavailable for the rest of this run: ${summarize(e)}.`);
          continue;
        }
        if (isTemporaryProviderError(e)) {
          const cooldown = (e as AiProviderError).status === 429 ? RATE_LIMIT_COOLDOWN_MS : OVERLOAD_COOLDOWN_MS;
          this.coolingUntil.set(i, Date.now() + cooldown);
          log.warn(`${this.label(provider)} is busy (${summarize(e)}); trying the next model.`);
          continue;
        }
        throw e;
      }
    }

    if (this.exhausted) {
      log.warn('Every AI provider is unavailable for the rest of this run; remaining AI steps use the deterministic path.');
      throw new AiProviderError(`No AI provider is available: ${summarize(lastError)}`, false);
    }
    // Everything left is temporarily busy: let runAgent back off and retry.
    throw lastError;
  }
}
