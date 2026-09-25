/**
 * Tracks generated test files and their approval state (spec section 23).
 *
 * Files are versioned: regenerating a spec bumps its version and resets it to
 * "needs_review" only when the content actually changed, so an approval is not
 * thrown away by a no-op regeneration.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { GeneratedFile } from '../playwright/codegen.js';
import { SUITE_DIRS } from '../playwright/scaffold.js';
import { getDb, fromJson } from '../db/client.js';
import { uuid } from '../util/ids.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('test-registry');
const now = () => new Date().toISOString();

export interface RegisterResult { created: number; updated: number; unchanged: number }

export async function registerGeneratedTests(
  projectId: string, featureKey: string, files: GeneratedFile[],
): Promise<RegisterResult> {
  const db = await getDb();
  let created = 0, updated = 0, unchanged = 0;

  for (const file of files) {
    const existing = await db.one<{ id: string; content_hash: string; version: number; approval_state: string }>(
      'SELECT id, content_hash, version, approval_state FROM generated_tests WHERE project_id = ? AND spec_file = ?',
      [projectId, file.relPath],
    );

    if (!existing) {
      await db.run(
        `INSERT INTO generated_tests (id, project_id, spec_file, kind, feature_key, scenario_keys_json,
           content, content_hash, source, approval_state, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'generated', 'ai_generated', 1, ?, ?)`,
        [uuid(), projectId, file.relPath, file.kind, featureKey,
         JSON.stringify(file.scenarioIds), file.content, file.hash, now(), now()],
      );
      created++;
      continue;
    }

    if (existing.content_hash === file.hash) { unchanged++; continue; }

    await db.run(
      `UPDATE generated_tests SET content = ?, content_hash = ?, scenario_keys_json = ?, feature_key = ?,
         version = ?, approval_state = ?, updated_at = ?
       WHERE id = ?`,
      [file.content, file.hash, JSON.stringify(file.scenarioIds), featureKey,
       existing.version + 1,
       // A previously approved file that changed must be reviewed again.
       existing.approval_state === 'approved' ? 'needs_review' : existing.approval_state,
       now(), existing.id],
    );
    updated++;
  }

  log.info(`Registered tests for "${featureKey}": ${created} new, ${updated} updated, ${unchanged} unchanged.`);
  return { created, updated, unchanged };
}

export interface GeneratedTestRecord {
  id: string;
  specFile: string;
  kind: string;
  featureKey: string;
  scenarioKeys: string[];
  contentHash: string;
  approvalState: string;
  version: number;
  lastOutcome: string | null;
  updatedAt: string;
}

export async function listGeneratedTests(projectId: string, opts?: { kind?: string }): Promise<GeneratedTestRecord[]> {
  const db = await getDb();
  const rows = await db.query<Record<string, unknown>>(
    `SELECT id, spec_file, kind, feature_key, scenario_keys_json, content_hash, approval_state, version, last_outcome, updated_at
     FROM generated_tests WHERE project_id = ?${opts?.kind ? ' AND kind = ?' : ''} ORDER BY spec_file`,
    opts?.kind ? [projectId, opts.kind] : [projectId],
  );
  return rows.map((row) => ({
    id: String(row['id']),
    specFile: String(row['spec_file']),
    kind: String(row['kind']),
    featureKey: String(row['feature_key'] ?? ''),
    scenarioKeys: fromJson<string[]>(row['scenario_keys_json'], []),
    contentHash: String(row['content_hash']),
    approvalState: String(row['approval_state']),
    version: Number(row['version']) || 1,
    lastOutcome: (row['last_outcome'] as string | null) ?? null,
    updatedAt: String(row['updated_at']),
  }));
}

/**
 * Specs generated for a feature that no longer exists (renamed or removed
 * routes) would fail for reasons unrelated to the product. They are moved out
 * of the runnable suite into retired/ - kept for reference, never
 * deleted - and dropped from the registry.
 */
export async function retireTestsForMissingFeatures(
  projectId: string, liveFeatureKeys: string[], suiteRoot: string,
): Promise<string[]> {
  const db = await getDb();
  const rows = await db.query<{ spec_file: string; feature_key: string | null }>(
    'SELECT spec_file, feature_key FROM generated_tests WHERE project_id = ?', [projectId],
  );
  const live = new Set(liveFeatureKeys);
  const retired: string[] = [];
  for (const row of rows) {
    if (!row.feature_key || live.has(row.feature_key)) continue;
    const from = path.resolve(suiteRoot, row.spec_file);
    if (!from.startsWith(path.resolve(suiteRoot))) continue;
    if (fs.existsSync(from)) {
      const to = path.join(suiteRoot, SUITE_DIRS.retired, path.basename(row.spec_file));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
    }
    await db.run('DELETE FROM generated_tests WHERE project_id = ? AND spec_file = ?', [projectId, row.spec_file]);
    retired.push(row.spec_file);
  }
  if (retired.length) log.info(`Retired ${retired.length} test file(s) for features that no longer exist.`);
  return retired;
}
