/**
 * OpenAIProvider (spec section 1: "future").
 *
 * Declared so the abstraction is real rather than aspirational: the factory
 * can construct it and the rest of the system is already provider-agnostic.
 * Claude is not here - it runs through the local CLI (claudeCli.ts), which
 * needs no API key.
 */
import { AiProviderError, estimateTokens, type AiProvider, type AiRequest, type AiResponse, type AiUsage } from './provider.js';
import { sanitizeForAi } from '../analysis/secrets.js';

export class OpenAIProvider implements AiProvider {
  readonly name = 'openai';
  readonly model: string;
  constructor(private readonly apiKey: string, model = 'gpt-4o-mini') { this.model = model; }

  estimateCost(usage: AiUsage): number {
    return (usage.promptTokens / 1e6) * 0.15 + (usage.completionTokens / 1e6) * 0.60;
  }

  async generate(request: AiRequest): Promise<AiResponse> {
    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: sanitizeForAi(request.system) },
        { role: 'user', content: sanitizeForAi(request.user) },
      ],
      temperature: request.temperature ?? 0.2,
      max_tokens: request.maxOutputTokens ?? 8192,
      response_format: { type: 'json_object' as const },
    };
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new AiProviderError(`OpenAI request failed (${res.status}): ${detail.slice(0, 400)}`, res.status === 429 || res.status >= 500, res.status);
    }
    const json = await res.json() as {
      choices: { message: { content: string } }[];
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    const text = json.choices[0]?.message.content ?? '';
    return {
      text,
      usage: {
        promptTokens: json.usage?.prompt_tokens ?? estimateTokens(request.system + request.user),
        completionTokens: json.usage?.completion_tokens ?? estimateTokens(text),
        totalTokens: json.usage?.total_tokens ?? estimateTokens(request.system + request.user + text),
      },
      model: this.model,
      provider: this.name,
    };
  }
}
