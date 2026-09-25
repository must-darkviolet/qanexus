/**
 * Scenario and rule deduplication (spec section 11).
 *
 * "Do not generate hundreds of duplicate scenarios. Use semantic
 * deduplication."
 *
 * Embeddings would cost a call per item on every run, which conflicts with the
 * cost-control requirement, so similarity is computed locally: a normalised
 * token set plus character trigrams, combined. That catches the duplicates
 * that actually occur ("Create user with valid data" vs "Successfully create
 * a user using valid data") without any API traffic.
 */
import { sha256 } from '../util/ids.js';

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'to', 'of', 'in', 'on', 'at',
  'for', 'with', 'by', 'from', 'as', 'that', 'this', 'these', 'those', 'it', 'its', 'and', 'or',
  'should', 'shall', 'must', 'can', 'will', 'would', 'when', 'then', 'given', 'user', 'users',
  'successfully', 'correctly', 'properly', 'able', 'allow', 'allows', 'allowed',
  // Filler that varies freely between two phrasings of the same scenario.
  'using', 'via', 'through', 'into', 'their', 'they', 'them', 'some', 'any', 'all',
]);

/** Verb and noun forms that mean the same thing for QA purposes. */
const SYNONYMS: Record<string, string> = {
  create: 'create', creates: 'create', creating: 'create', add: 'create', adds: 'create', new: 'create',
  update: 'update', updates: 'update', updating: 'update', edit: 'update', edits: 'update', modify: 'update', modifies: 'update',
  delete: 'delete', deletes: 'delete', deleting: 'delete', remove: 'delete', removes: 'delete', destroy: 'delete',
  view: 'read', views: 'read', see: 'read', sees: 'read', read: 'read', reads: 'read', display: 'read', displays: 'read', show: 'read', shows: 'read', list: 'read', lists: 'read',
  login: 'login', log: 'login', signin: 'login', authenticate: 'login', authentication: 'login',
  invalid: 'invalid', incorrect: 'invalid', wrong: 'invalid', bad: 'invalid',
  btn: 'button', button: 'button', buttons: 'button',
  submit: 'submit', submits: 'submit', submitting: 'submit', save: 'save', saves: 'save', saving: 'save',
  msg: 'message', message: 'message', err: 'error',
  auth: 'login', signup: 'register',
  empty: 'empty', blank: 'empty', missing: 'empty', required: 'empty',
  error: 'error', errors: 'error', fail: 'error', fails: 'error', failure: 'error', rejected: 'error',
  unauthorized: 'forbidden', forbidden: 'forbidden', denied: 'forbidden', permission: 'forbidden', permissions: 'forbidden',
  validation: 'validation', validate: 'validation', validates: 'validation', validating: 'validation',
};

/** Very light stemming: enough to make "signing" and "signs" agree. */
function stem(word: string): string {
  const known = SYNONYMS[word];
  if (known) return known;
  let w = word;
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  w = w.replace(/(ies)$/, 'y').replace(/(es|s)$/, '');
  return SYNONYMS[w] ?? w;
}

export function normalizeText(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map(stem)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Overlap coefficient. Jaccard alone punishes a longer restatement of the same
 * scenario ("create a user" vs "successfully create a user using valid data"),
 * which is exactly the duplicate we most want to catch, so containment is
 * scored alongside it.
 */
function containment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return a.size === b.size ? 1 : 0;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  return intersection / Math.min(a.size, b.size);
}

function trigrams(text: string): Set<string> {
  const clean = text.toLowerCase().replace(/[^a-z0-9]/g, '');
  const out = new Set<string>();
  for (let i = 0; i + 3 <= clean.length; i++) out.add(clean.slice(i, i + 3));
  return out;
}

/** 0..1 similarity; 1 means "the same scenario stated differently". */
export function similarity(a: string, b: string): number {
  const tokensA = new Set(normalizeText(a));
  const tokensB = new Set(normalizeText(b));
  const tokenScore = jaccard(tokensA, tokensB);
  const containmentScore = containment(tokensA, tokensB);
  const charScore = jaccard(trigrams(a), trigrams(b));
  return 0.45 * tokenScore + 0.30 * containmentScore + 0.25 * charScore;
}

export const DUPLICATE_THRESHOLD = 0.82;

/**
 * A coarse bucket key. Two items with different hashes can still be
 * duplicates; this only provides fast exact-match detection and a stable
 * database column for grouping.
 */
export function dedupeHash(parts: string[]): string {
  return sha256(parts.map((p) => normalizeText(p).sort().join(' ')).join('|'));
}

export interface DedupeCandidate {
  /** The text compared for similarity. */
  text: string;
  /** Items only collide inside the same bucket (feature + category). */
  bucket: string;
}

export interface DedupeDecision<T> {
  kept: T[];
  duplicates: { item: T; duplicateOf: T; score: number }[];
}

/**
 * Removes near-duplicates from `incoming`, first against `existing`
 * (previously stored items, which win) and then within the batch itself.
 */
export function deduplicate<T>(
  incoming: T[],
  existing: T[],
  describe: (item: T) => DedupeCandidate,
  threshold = DUPLICATE_THRESHOLD,
): DedupeDecision<T> {
  const kept: T[] = [];
  const duplicates: { item: T; duplicateOf: T; score: number }[] = [];

  const byBucket = new Map<string, T[]>();
  for (const item of existing) {
    const { bucket } = describe(item);
    const list = byBucket.get(bucket) ?? [];
    list.push(item);
    byBucket.set(bucket, list);
  }

  for (const item of incoming) {
    const { text, bucket } = describe(item);
    const candidates = byBucket.get(bucket) ?? [];

    let best: { item: T; score: number } | null = null;
    for (const candidate of candidates) {
      const score = similarity(text, describe(candidate).text);
      if (!best || score > best.score) best = { item: candidate, score };
    }

    if (best && best.score >= threshold) {
      duplicates.push({ item, duplicateOf: best.item, score: Math.round(best.score * 100) / 100 });
      continue;
    }

    kept.push(item);
    const list = byBucket.get(bucket) ?? [];
    list.push(item);
    byBucket.set(bucket, list);
  }

  return { kept, duplicates };
}

/**
 * Finds the single best match above a threshold - used to link a generated
 * scenario to a pre-existing test rather than duplicating it (spec section 14).
 */
export function bestMatch<T>(
  text: string,
  candidates: T[],
  describe: (item: T) => string,
  threshold = 0.65,
): { item: T; score: number } | null {
  let best: { item: T; score: number } | null = null;
  for (const candidate of candidates) {
    const score = similarity(text, describe(candidate));
    if (!best || score > best.score) best = { item: candidate, score };
  }
  return best && best.score >= threshold ? best : null;
}
