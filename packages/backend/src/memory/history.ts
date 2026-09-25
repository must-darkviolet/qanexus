/**
 * Historical QA intelligence.
 *
 *   Current change -> Related historical finding -> Additional regression step
 *
 * Past failures, fixed defects, flaky tests and change hotspots are matched
 * against the files, features and specs the current change touches. A match is
 * only reported with what it was matched on, so the link can be checked.
 */
import type { FailureRecord, HistoricalFinding } from '@qa-agent/shared';
import { fromJson, getDb } from '../db/client.js';
import { listFailures } from '../knowledge/evidence.js';
import { allMemory } from './store.js';

export interface HistoryQuery {
  changedFiles: string[];
  featureKeys: string[];
  specFiles: string[];
  scenarioKeys: string[];
  /** Runs to leave out, e.g. the run that is computing this impact. */
  excludeRunId?: string | null;
}

const HOTSPOT_THRESHOLD = 3;

export async function findHistoricalFindings(projectId: string, query: HistoryQuery): Promise<HistoricalFinding[]> {
  const db = await getDb();
  const findings: HistoricalFinding[] = [];
  const files = new Set(query.changedFiles);
  const specs = new Set(query.specFiles);
  const scenarios = new Set(query.scenarioKeys);

  /* ---- past failures and fixed defects --------------------------------- */
  const rows = await db.query<Record<string, unknown>>(
    `SELECT id, run_id, spec_file, test_title, scenario_key, classification, root_cause, resolution,
            occurred_at, culprit_files_json, signature, occurrence_count, is_flaky
     FROM failures WHERE project_id = ? ORDER BY occurred_at DESC LIMIT 500`,
    [projectId],
  );

  const seenSignatures = new Set<string>();
  for (const row of rows) {
    if (query.excludeRunId && row['run_id'] === query.excludeRunId) continue;
    const signature = String(row['signature']);
    if (seenSignatures.has(signature)) continue;

    const culprits = fromJson<string[]>(row['culprit_files_json'], []);
    const specFile = String(row['spec_file']);
    const scenarioKey = (row['scenario_key'] as string | null) ?? null;
    const culpritHit = culprits.find((c) => files.has(c));
    const matchedOn = culpritHit ? `changed file ${culpritHit}`
      : specs.has(specFile) ? `related spec ${specFile}`
      : scenarioKey && scenarios.has(scenarioKey) ? `scenario ${scenarioKey}`
      : null;
    if (!matchedOn) continue;
    seenSignatures.add(signature);

    const resolution = String(row['resolution'] ?? 'open');
    const classification = (row['classification'] as string | null) ?? 'UNKNOWN';
    const title = String(row['test_title']);
    const cause = (row['root_cause'] as string | null) ?? 'cause not recorded';
    const isFlaky = row['is_flaky'] === 1 || row['is_flaky'] === true || resolution === 'flaky';

    if (isFlaky) {
      findings.push({
        kind: 'flaky_test', matchedOn, reference: specFile, occurredAt: String(row['occurred_at']),
        occurrences: Number(row['occurrence_count']) || 1,
        summary: `"${title}" has been flaky before: ${cause}`,
        recommendation: `Re-run ${specFile} more than once before treating a failure there as a regression`,
      });
    } else if (resolution === 'fixed') {
      findings.push({
        kind: 'past_defect', matchedOn, reference: specFile, occurredAt: String(row['occurred_at']),
        occurrences: Number(row['occurrence_count']) || 1,
        summary: `A ${classification.replace(/_/g, ' ').toLowerCase()} in "${title}" was fixed previously: ${cause}`,
        recommendation: `Re-verify the previously fixed defect in "${title}" - the code around it changed again`,
      });
    } else if (resolution !== 'wont_fix' && resolution !== 'duplicate') {
      findings.push({
        kind: resolution === 'accepted' ? 'accepted_behaviour' : 'past_failure',
        matchedOn, reference: specFile, occurredAt: String(row['occurred_at']),
        occurrences: Number(row['occurrence_count']) || 1,
        summary: `"${title}" failed before (${classification.replace(/_/g, ' ').toLowerCase()}): ${cause}`,
        recommendation: resolution === 'accepted'
          ? `Confirm the accepted behaviour in "${title}" still holds after this change`
          : `Re-run ${specFile} and check whether the earlier failure in "${title}" recurs`,
      });
    }
  }

  /* ---- remembered QA knowledge (flaky tests, fixed bugs) --------------- */
  const memory = await allMemory(projectId, 'qa');
  for (const entry of memory) {
    if (entry.kind !== 'flaky_test' && entry.kind !== 'fixed_bug') continue;
    const detailSpec = typeof entry.detail['specFile'] === 'string' ? entry.detail['specFile'] as string : null;
    const matchedOn = detailSpec && specs.has(detailSpec) ? `related spec ${detailSpec}`
      : files.has(entry.subject) ? `changed file ${entry.subject}`
      : query.featureKeys.includes(entry.subject) ? `feature ${entry.subject}`
      : null;
    if (!matchedOn) continue;
    if (findings.some((f) => f.reference === (detailSpec ?? entry.subject) && f.kind === (entry.kind === 'flaky_test' ? 'flaky_test' : 'past_defect'))) continue;
    findings.push({
      kind: entry.kind === 'flaky_test' ? 'flaky_test' : 'past_defect',
      matchedOn, reference: detailSpec ?? entry.subject, occurredAt: entry.updatedAt, occurrences: 1,
      summary: entry.summary,
      recommendation: entry.kind === 'flaky_test'
        ? `Treat a single failure of ${detailSpec ?? entry.subject} with caution; re-run before reporting`
        : `Re-verify the previously fixed bug recorded for ${entry.subject}`,
    });
  }

  /* ---- change hotspots -------------------------------------------------- */
  if (query.changedFiles.length) {
    const placeholders = query.changedFiles.map(() => '?').join(', ');
    const hot = await db.query<{ path: string; runs: number; last: string }>(
      `SELECT path, COUNT(DISTINCT run_id) AS runs, MAX(created_at) AS last
       FROM repo_changes WHERE project_id = ? AND path IN (${placeholders})
       ${query.excludeRunId ? 'AND run_id <> ?' : ''}
       GROUP BY path`,
      query.excludeRunId ? [projectId, ...query.changedFiles, query.excludeRunId] : [projectId, ...query.changedFiles],
    );
    for (const row of hot) {
      const count = Number(row.runs) || 0;
      if (count < HOTSPOT_THRESHOLD - 1) continue;
      findings.push({
        kind: 'change_hotspot', matchedOn: `changed file ${row.path}`, reference: row.path,
        occurredAt: row.last, occurrences: count + 1,
        summary: `${row.path} has now changed in ${count + 1} analysed versions - frequently changed code regresses more often`,
        recommendation: `Give ${row.path} deeper regression coverage than a one-off change would need`,
      });
    }
  }

  return findings.slice(0, 40);
}

export interface ProjectHistory {
  failures: FailureRecord[];
  fixedDefects: FailureRecord[];
  hotspots: { path: string; changeCount: number; lastChangedAt: string }[];
  flakyTests: { subject: string; summary: string; updatedAt: string }[];
  runs: {
    id: string; mode: string; status: string; startedAt: string; commitSha: string | null;
    execution: { total: number; passed: number; failed: number; skipped: number; pending: number; durationMs: number } | null;
  }[];
}

/** Everything the History view needs, all read from recorded data. */
export async function projectHistory(projectId: string): Promise<ProjectHistory> {
  const db = await getDb();
  const [failures, hotspotRows, memory, runRows] = await Promise.all([
    listFailures({ projectId, limit: 300 }),
    db.query<{ path: string; runs: number; last: string }>(
      `SELECT path, COUNT(DISTINCT run_id) AS runs, MAX(created_at) AS last
       FROM repo_changes WHERE project_id = ? GROUP BY path ORDER BY runs DESC, last DESC LIMIT 25`,
      [projectId],
    ),
    allMemory(projectId, 'qa'),
    db.query<Record<string, unknown>>(
      `SELECT id, mode, status, started_at, commit_sha, execution_json
       FROM runs WHERE project_id = ? ORDER BY started_at DESC LIMIT 40`,
      [projectId],
    ),
  ]);

  return {
    failures,
    fixedDefects: failures.filter((f) => f.resolution === 'fixed'),
    hotspots: hotspotRows.map((r) => ({ path: r.path, changeCount: Number(r.runs) || 0, lastChangedAt: r.last })),
    flakyTests: memory.filter((m) => m.kind === 'flaky_test')
      .map((m) => ({ subject: m.subject, summary: m.summary, updatedAt: m.updatedAt })),
    runs: runRows.map((r) => ({
      id: String(r['id']),
      mode: String(r['mode']),
      status: String(r['status']),
      startedAt: String(r['started_at']),
      commitSha: (r['commit_sha'] as string | null) ?? null,
      execution: fromJson(r['execution_json'], null),
    })),
  };
}
