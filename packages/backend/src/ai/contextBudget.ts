/**
 * Prompt budgeting (spec section 26).
 *
 * A prompt is assembled from labelled sections, each with a priority. When
 * the total exceeds the budget, the least important sections are shortened
 * and then dropped first - changed code and the directly related tests
 * survive, history and background go. Nothing is cut silently: the prompt
 * says what was left out, and so does the log.
 */
import { env } from '../config/env.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('ai:context');

/** Lower is more important. Mirrors the order the spec asks for. */
export const Priority = {
  task: 0,
  change: 1,
  relatedTests: 2,
  pageObjects: 3,
  utilities: 4,
  fixtures: 5,
  history: 6,
  background: 7,
} as const;

export interface ContextSection {
  title: string;
  body: string;
  priority: number;
  /** Never dropped; shortened only as a last resort. */
  required?: boolean;
}

export interface PackedContext {
  text: string;
  omitted: string[];
  truncated: string[];
  reduced: boolean;
}

/** Below this, a shortened section carries too little to be worth sending. */
const MIN_USEFUL_CHARS = 400;

function render(section: ContextSection, body = section.body): string {
  return section.title ? `${section.title}\n${body}` : body;
}

function cut(text: string, maxChars: number, label: string): string {
  if (text.length <= maxChars) return text;
  const marker = `\n... [${label} shortened, ${text.length - maxChars} characters omitted]`;
  return text.slice(0, Math.max(0, maxChars - marker.length)) + marker;
}

export function packContext(sections: ContextSection[], maxChars: number, label = 'prompt'): PackedContext {
  const separator = '\n\n';
  const full = sections.map((s) => render(s)).join(separator);
  if (full.length <= maxChars) return { text: full, omitted: [], truncated: [], reduced: false };

  // Reserve room for the note that tells the model what it is not seeing.
  const budget = maxChars - 300;
  const order = sections.map((s, i) => ({ s, i }))
    .sort((a, b) => (Number(b.s.required ?? false) - Number(a.s.required ?? false)) || a.s.priority - b.s.priority || a.i - b.i);

  const chosen = new Map<number, string>();
  const omitted: string[] = [];
  const truncated: string[] = [];
  let used = 0;

  for (const { s, i } of order) {
    const text = render(s);
    const cost = text.length + separator.length;
    const remaining = budget - used;
    if (cost <= remaining) {
      chosen.set(i, text);
      used += cost;
    } else if (s.required || remaining >= MIN_USEFUL_CHARS) {
      const shortened = cut(text, Math.max(remaining - separator.length, s.required ? 200 : MIN_USEFUL_CHARS), s.title || 'section');
      chosen.set(i, shortened);
      used += shortened.length + separator.length;
      truncated.push(s.title || `section ${i + 1}`);
    } else {
      omitted.push(s.title || `section ${i + 1}`);
    }
  }

  const parts = sections.map((_, i) => chosen.get(i)).filter((t): t is string => t !== undefined);
  const note = `CONTEXT REDUCED TO FIT BUDGET: ${[
    omitted.length ? `omitted ${omitted.join(', ')}` : '',
    truncated.length ? `shortened ${truncated.join(', ')}` : '',
  ].filter(Boolean).join('; ')}. Treat anything not shown as UNKNOWN.`;
  log.warn(`${label}: context reduced from ${full.length} to ~${used} chars (budget ${maxChars}). ${note.replace('CONTEXT REDUCED TO FIT BUDGET: ', '')}`);

  return { text: [...parts, note].join(separator), omitted, truncated, reduced: true };
}

/** Characters left for the user prompt once the system prompt is accounted for. */
export function userBudget(system: string): number {
  return Math.max(2000, env.AI_MAX_INPUT_CHARS - system.length);
}
