/**
 * Provider abstraction (spec section 1).
 *
 * Gemini is the initial implementation, but nothing outside this folder knows
 * that. Adding OpenAI or Claude means implementing this interface, not editing
 * the agents.
 */

export interface AiMessage {
  role: 'system' | 'user';
  content: string;
}

export interface AiRequest {
  /** Which agent is asking - used for cache keys, usage attribution and logs. */
  agent: string;
  system: string;
  user: string;
  /** A JSON Schema the provider should constrain output to, where supported. */
  responseSchema?: Record<string, unknown>;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface AiUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AiResponse {
  text: string;
  usage: AiUsage;
  model: string;
  provider: string;
}

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  /** Approximate USD cost, used only for the dashboard's cost tracking. */
  estimateCost(usage: AiUsage): number;
  generate(request: AiRequest): Promise<AiResponse>;
}

export class AiProviderError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status?: number) {
    super(message);
    this.name = 'AiProviderError';
  }
}

/** Rough token estimate used when a provider does not report usage. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
