/**
 * Structured output handling (spec section 25).
 *
 * "Validate AI output with schemas. Never trust raw model output blindly."
 * Models wrap JSON in prose or fences, emit trailing commas, and occasionally
 * return a single object where a list was asked for. This module recovers what
 * it safely can and hands the rest to zod, which decides.
 */
import { z } from 'zod';

export class AiOutputError extends Error {
  constructor(message: string, readonly raw: string, readonly issues?: z.ZodIssue[]) {
    super(message);
    this.name = 'AiOutputError';
  }
}

/** Strips fences and grabs the outermost balanced JSON value. */
export function extractJson(raw: string): string {
  let text = raw.trim();

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) text = fence[1].trim();

  const start = text.search(/[[{]/);
  if (start === -1) return text;

  const open = text[start]!;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

/** Repairs the malformations models actually produce. */
function repairJson(text: string): string {
  return text
    .replace(/,\s*([}\]])/g, '$1')             // trailing commas
    .replace(/\bNaN\b/g, 'null')
    .replace(/\b(?:Infinity|-Infinity)\b/g, 'null')
    .replace(/\bundefined\b/g, 'null');
}

export function parseJsonLoose(raw: string): unknown {
  const candidate = extractJson(raw);
  try { return JSON.parse(candidate); } catch { /* try repairs */ }
  try { return JSON.parse(repairJson(candidate)); } catch { /* fall through */ }
  throw new AiOutputError('Model output could not be parsed as JSON.', raw);
}

/**
 * Parses and validates. On failure the caller decides whether to retry with
 * the validation errors appended to the prompt, or fall back deterministically.
 */
export function parseAndValidate<T extends z.ZodTypeAny>(schema: T, raw: string): z.infer<T> {
  const value = parseJsonLoose(raw);
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  // A model asked for `{ items: [...] }` sometimes returns the bare array.
  if (Array.isArray(value) && schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const arrayKeys = Object.keys(shape).filter((k) => shape[k] instanceof z.ZodArray
      || (shape[k] as z.ZodTypeAny)._def?.typeName === 'ZodDefault');
    if (arrayKeys.length === 1) {
      const retry = schema.safeParse({ [arrayKeys[0]!]: value });
      if (retry.success) return retry.data;
    }
  }

  throw new AiOutputError(
    `Model output failed schema validation: ${result.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '<root>'} ${i.message}`).join('; ')}`,
    raw,
    result.error.issues,
  );
}

/** Formats zod issues into a correction instruction for a retry. */
export function issuesToInstruction(issues: z.ZodIssue[] | undefined): string {
  if (!issues || issues.length === 0) return 'The previous response was not valid JSON.';
  const lines = issues.slice(0, 10).map((i) => `- ${i.path.join('.') || '<root>'}: ${i.message}`);
  return `Your previous response failed validation:\n${lines.join('\n')}\nReturn corrected JSON only.`;
}

/**
 * Minimal zod -> JSON Schema conversion for the subset the agents use.
 * Providers that support response schemas get better first-attempt accuracy;
 * validation still happens locally regardless.
 */
export function toJsonSchema(schema: z.ZodTypeAny, depth = 0): Record<string, unknown> {
  if (depth > 8) return { type: 'object' };
  const def = schema._def as { typeName?: string; [k: string]: unknown };

  switch (def.typeName) {
    case 'ZodString': return { type: 'string' };
    case 'ZodNumber': return { type: 'number' };
    case 'ZodBoolean': return { type: 'boolean' };
    case 'ZodEnum': return { type: 'string', enum: def['values'] as string[] };
    case 'ZodLiteral': return { type: 'string', enum: [def['value']] };
    case 'ZodArray': return { type: 'array', items: toJsonSchema(def['type'] as z.ZodTypeAny, depth + 1) };
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
      return toJsonSchema((def['innerType'] as z.ZodTypeAny), depth + 1);
    case 'ZodObject': {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = toJsonSchema(value, depth + 1);
        const inner = (value as z.ZodTypeAny)._def as { typeName?: string };
        if (inner.typeName !== 'ZodOptional' && inner.typeName !== 'ZodDefault' && inner.typeName !== 'ZodNullable') {
          required.push(key);
        }
      }
      return { type: 'object', properties, ...(required.length ? { required } : {}) };
    }
    case 'ZodRecord': return { type: 'object' };
    case 'ZodUnion': return { type: 'string' };
    default: return { type: 'string' };
  }
}
