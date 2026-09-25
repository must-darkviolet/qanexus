import { GoogleGenerativeAI } from '@google/generative-ai';
import { AiProviderError, estimateTokens, type AiProvider, type AiRequest, type AiResponse, type AiUsage } from './provider.js';
import { env } from '../config/env.js';
import { createLogger } from '../util/logger.js';
import { sanitizeForAi } from '../analysis/secrets.js';

const log = createLogger('ai:gemini');

/** Published per-million-token pricing for the Flash tier, in USD. */
const PRICE_PER_MILLION = { input: 0.10, output: 0.40 };

export class GeminiProvider implements AiProvider {
  readonly name = 'gemini';
  readonly model: string;
  private readonly client: GoogleGenerativeAI;

  constructor(apiKey: string, model = env.GEMINI_MODEL) {
    this.client = new GoogleGenerativeAI(apiKey);
    this.model = model;
  }

  estimateCost(usage: AiUsage): number {
    return (usage.promptTokens / 1e6) * PRICE_PER_MILLION.input
      + (usage.completionTokens / 1e6) * PRICE_PER_MILLION.output;
  }

  async generate(request: AiRequest): Promise<AiResponse> {
    // Last-chance scrub: no secret ever leaves this process (spec section 27).
    const system = sanitizeForAi(request.system);
    const user = sanitizeForAi(request.user);

    const model = this.client.getGenerativeModel({
      model: this.model,
      systemInstruction: system,
      generationConfig: {
        temperature: request.temperature ?? 0.2,
        maxOutputTokens: request.maxOutputTokens ?? 8192,
        responseMimeType: 'application/json',
        ...(request.responseSchema ? { responseSchema: request.responseSchema as never } : {}),
      },
    });

    try {
      const result = await model.generateContent(user);
      const text = result.response.text();
      const meta = result.response.usageMetadata;
      const usage: AiUsage = {
        promptTokens: meta?.promptTokenCount ?? estimateTokens(system + user),
        completionTokens: meta?.candidatesTokenCount ?? estimateTokens(text),
        totalTokens: meta?.totalTokenCount ?? estimateTokens(system + user + text),
      };
      return { text, usage, model: this.model, provider: this.name };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const status = Number(message.match(/\[(\d{3})[^\]]*\]/)?.[1] ?? NaN);
      // 429 (quota) and 5xx are worth retrying; 400/403 are not.
      const retryable = status === 429 || (status >= 500 && status < 600) || /fetch failed|ECONNRESET|ETIMEDOUT/i.test(message);
      log.warn(`Gemini request failed for ${request.agent}: ${message}`);
      throw new AiProviderError(message, retryable, Number.isNaN(status) ? undefined : status);
    }
  }
}
