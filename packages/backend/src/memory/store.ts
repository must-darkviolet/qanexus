/**
 * Persistent QA memory (spec section 7).
 *
 * "The AI must have memory across executions. Do NOT simply start every
 * repository analysis from zero."
 *
 * Three memory scopes are written here - application, QA and repository -
 * plus failure memory, which lives in its own table because it carries
 * evidence.
 */
import type { RepositoryDiff, StaticAnalysis } from '@qa-agent/shared';
import { fromJson, getDb } from '../db/client.js';
import { uuid } from '../util/ids.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('memory');
const now = () => new Date().toISOString();

export type MemoryScope = 'application' | 'qa' | 'repository' | 'failure';
export type MemoryKind = 'known_behavior' | 'accepted_failure' | 'flaky_test' | 'fixed_bug' | 'note' | 'discrepancy';

export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  subject: string;
  kind: MemoryKind;
  summary: string;
  detail: Record<string, unknown>;
  keywords: string;
  confidence: number;
  commitSha: string | null;
  updatedAt: string;
}

export async function remember(projectId: string, entry: {
  scope: MemoryScope; subject: string; kind: MemoryKind; summary: string;
  detail?: Record<string, unknown>; keywords?: string[]; confidence?: number; commitSha?: string | null;
}): Promise<void> {
  const db = await getDb();
  const keywords = (entry.keywords ?? []).join(' ').toLowerCase();

  // One row per (scope, subject, kind, summary) so repeated runs update rather
  // than append - memory should stay small enough to retrieve cheaply.
  const existing = await db.one<{ id: string }>(
    'SELECT id FROM memory_entries WHERE project_id = ? AND scope = ? AND subject = ? AND kind = ? AND summary = ?',
    [projectId, entry.scope, entry.subject, entry.kind, entry.summary],
  );

  if (existing) {
    await db.run(
      'UPDATE memory_entries SET detail_json = ?, keywords = ?, confidence = ?, commit_sha = ?, updated_at = ? WHERE id = ?',
      [JSON.stringify(entry.detail ?? {}), keywords, entry.confidence ?? 0.5, entry.commitSha ?? null, now(), existing.id],
    );
    return;
  }

  await db.run(
    `INSERT INTO memory_entries (id, project_id, scope, subject, kind, summary, detail_json, keywords, confidence, commit_sha, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuid(), projectId, entry.scope, entry.subject, entry.kind, entry.summary,
     JSON.stringify(entry.detail ?? {}), keywords, entry.confidence ?? 0.5, entry.commitSha ?? null, now(), now()],
  );
}

export async function forget(projectId: string, memoryId: string): Promise<void> {
  const db = await getDb();
  await db.run('DELETE FROM memory_entries WHERE project_id = ? AND id = ?', [projectId, memoryId]);
}

export async function allMemory(projectId: string, scope?: MemoryScope): Promise<MemoryEntry[]> {
  const db = await getDb();
  const rows = await db.query<Record<string, unknown>>(
    `SELECT * FROM memory_entries WHERE project_id = ?${scope ? ' AND scope = ?' : ''} ORDER BY updated_at DESC`,
    scope ? [projectId, scope] : [projectId],
  );
  return rows.map((row) => ({
    id: String(row['id']),
    scope: row['scope'] as MemoryScope,
    subject: String(row['subject']),
    kind: row['kind'] as MemoryKind,
    summary: String(row['summary']),
    detail: fromJson<Record<string, unknown>>(row['detail_json'], {}),
    keywords: String(row['keywords'] ?? ''),
    confidence: Number(row['confidence']) || 0,
    commitSha: (row['commit_sha'] as string | null) ?? null,
    updatedAt: String(row['updated_at']),
  }));
}

/* -------------------------------------------------------------------------- */
/* Repository memory: snapshots of what the repo looked like when analyzed     */
/* -------------------------------------------------------------------------- */
export interface RepoSnapshot {
  commitSha: string;
  previousCommitSha: string | null;
  analyzedAt: string;
  fileHashes: Record<string, string>;
  staticAnalysis: StaticAnalysis | null;
}

export async function saveRepoSnapshot(projectId: string, snapshot: {
  commitSha: string; previousCommitSha: string | null; fileHashes: Record<string, string>;
  staticAnalysis: StaticAnalysis; runId: string;
}): Promise<void> {
  const db = await getDb();
  // The architecture summary is kept separately and small, so the dashboard
  // and the change analyzer can read it without loading the whole analysis.
  const architecture = {
    framework: snapshot.staticAnalysis.framework,
    routeCount: snapshot.staticAnalysis.routes.length,
    componentCount: snapshot.staticAnalysis.components.length,
    apiCount: snapshot.staticAnalysis.apis.length,
    routes: snapshot.staticAnalysis.routes.map((r) => r.path),
    apis: snapshot.staticAnalysis.apis.map((a) => `${a.method} ${a.path}`),
    roles: snapshot.staticAnalysis.roles.map((r) => r.name),
  };

  await db.run(
    `INSERT INTO repo_snapshots (id, project_id, commit_sha, previous_commit_sha, analyzed_at, file_hashes_json, architecture_json, static_analysis_json, run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (project_id, commit_sha) DO UPDATE SET
       previous_commit_sha = excluded.previous_commit_sha, analyzed_at = excluded.analyzed_at,
       file_hashes_json = excluded.file_hashes_json, architecture_json = excluded.architecture_json,
       static_analysis_json = excluded.static_analysis_json, run_id = excluded.run_id`,
    [uuid(), projectId, snapshot.commitSha, snapshot.previousCommitSha, now(),
     JSON.stringify(snapshot.fileHashes), JSON.stringify(architecture),
     JSON.stringify(snapshot.staticAnalysis), snapshot.runId],
  );
  log.info(`Saved repository snapshot for ${snapshot.commitSha.slice(0, 8)}.`);
}

export async function latestSnapshot(projectId: string, beforeCommit?: string): Promise<RepoSnapshot | null> {
  const db = await getDb();
  const row = await db.one<Record<string, unknown>>(
    `SELECT * FROM repo_snapshots WHERE project_id = ?${beforeCommit ? ' AND commit_sha != ?' : ''} ORDER BY analyzed_at DESC LIMIT 1`,
    beforeCommit ? [projectId, beforeCommit] : [projectId],
  );
  if (!row) return null;
  return {
    commitSha: String(row['commit_sha']),
    previousCommitSha: (row['previous_commit_sha'] as string | null) ?? null,
    analyzedAt: String(row['analyzed_at']),
    fileHashes: fromJson<Record<string, string>>(row['file_hashes_json'], {}),
    staticAnalysis: fromJson<StaticAnalysis | null>(row['static_analysis_json'], null),
  };
}

export async function saveRepoChanges(projectId: string, runId: string, diff: RepositoryDiff): Promise<void> {
  if (diff.files.length === 0) return;
  const db = await getDb();
  await db.transaction(async (tx) => {
    for (const file of diff.files) {
      const impact = {
        changedFunctions: diff.changedFunctions.filter((f) => f.file === file.path).map((f) => f.name),
        changedRoutes: diff.changedRoutes.filter(() => false).map((r) => r.path),
        isBusinessLogic: diff.changedBusinessLogicFiles.includes(file.path),
      };
      await tx.run(
        `INSERT INTO repo_changes (id, project_id, run_id, from_commit, to_commit, path, previous_path, status, additions, deletions, impact_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuid(), projectId, runId, diff.previousCommitSha, diff.currentCommitSha, file.path,
         file.previousPath ?? null, file.status, file.additions, file.deletions, JSON.stringify(impact), now()],
      );
    }
  });
}

export async function recentRepoChanges(projectId: string, limit = 50) {
  const db = await getDb();
  return db.query<Record<string, unknown>>(
    'SELECT * FROM repo_changes WHERE project_id = ? ORDER BY created_at DESC LIMIT ?',
    [projectId, limit],
  );
}
