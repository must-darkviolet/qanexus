/**
 * Prompt-level response cache (spec section 26).
 *
 * A free-tier key makes repeated calls expensive in quota, and most reruns ask
 * the same question about the same unchanged code. The cache key is a hash of
 * (agent, provider, model, system, user), so any change in context misses.
 */
import { getDb } from '../db/client.js';
import { shortHash, sha256, uuid } from '../util/ids.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('ai:cache');

export interface CachedEntry {
  text: string;
  promptTokens: number;
  completionTokens: number;
}

export function cacheKey(parts: { agent: string; provider: string; model: string; system: string; user: string }): string {
  return sha256([parts.agent, parts.provider, parts.model, parts.system, parts.user].join('\u0000'));
}

export async function readCache(key: string): Promise<CachedEntry | null> {
  const db = await getDb();
  const row = await db.one<{ response_json: string; prompt_tokens: number; completion_tokens: number }>(
    'SELECT response_json, prompt_tokens, completion_tokens FROM ai_cache WHERE cache_key = ?',
    [key],
  );
  if (!row) return null;
  await db.run('UPDATE ai_cache SET hit_count = hit_count + 1, last_hit_at = ? WHERE cache_key = ?', [new Date().toISOString(), key]);
  log.debug(`Cache hit ${shortHash(key)}.`);
  return {
    text: row.response_json,
    promptTokens: Number(row.prompt_tokens) || 0,
    completionTokens: Number(row.completion_tokens) || 0,
  };
}

export async function writeCache(opts: {
  key: string; projectId: string | null; agent: string; provider: string; model: string;
  text: string; promptTokens: number; completionTokens: number;
}): Promise<void> {
  const db = await getDb();
  await db.run(
    `INSERT INTO ai_cache (cache_key, project_id, agent, provider, model, response_json, prompt_tokens, completion_tokens, created_at, hit_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT (cache_key) DO UPDATE SET response_json = excluded.response_json`,
    [opts.key, opts.projectId, opts.agent, opts.provider, opts.model, opts.text, opts.promptTokens, opts.completionTokens, new Date().toISOString()],
  );
}

/**
 * Per-file analysis cache keyed by content hash: an unchanged file is never
 * re-analyzed, which is the single biggest saving on a repeat run.
 */
export async function readFileAnalysis<T>(projectId: string, filePath: string, contentHash: string): Promise<T | null> {
  const db = await getDb();
  const row = await db.one<{ analysis_json: string }>(
    'SELECT analysis_json FROM file_analysis_cache WHERE project_id = ? AND path = ? AND content_hash = ?',
    [projectId, filePath, contentHash],
  );
  if (!row) return null;
  try { return JSON.parse(row.analysis_json) as T; } catch { return null; }
}

export async function writeFileAnalysis(projectId: string, filePath: string, contentHash: string, analysis: unknown, commitSha?: string): Promise<void> {
  const db = await getDb();
  await db.run(
    `INSERT INTO file_analysis_cache (id, project_id, path, content_hash, analysis_json, commit_sha, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (project_id, path, content_hash) DO UPDATE SET analysis_json = excluded.analysis_json`,
    [uuid(), projectId, filePath, contentHash, JSON.stringify(analysis), commitSha ?? null, new Date().toISOString()],
  );
}

export async function clearProjectCache(projectId: string): Promise<void> {
  const db = await getDb();
  await db.run('DELETE FROM ai_cache WHERE project_id = ?', [projectId]);
  await db.run('DELETE FROM file_analysis_cache WHERE project_id = ?', [projectId]);
}
