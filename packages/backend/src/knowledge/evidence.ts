/**
 * Evidence and failure persistence (spec sections 7, 17 and 19).
 *
 * "Every important result must have evidence." Screenshots, videos, logs, DOM
 * snapshots, the relevant diff and the AI's own analysis are all stored
 * against the thing they justify, so the dashboard and the report can show
 * where a conclusion came from.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FailureAnalyzerOutput, FailureRecord, TestResult } from '@qa-agent/shared';
import { env } from '../config/env.js';
import { fromJson, getDb, toBool } from '../db/client.js';
import { shortHash, uuid } from '../util/ids.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('evidence');
const now = () => new Date().toISOString();

/* -------------------------------------------------------------------------- */
/* Test results                                                                */
/* -------------------------------------------------------------------------- */
export async function saveTestResults(
  projectId: string, runId: string, commitSha: string, results: TestResult[],
): Promise<void> {
  if (results.length === 0) return;
  const db = await getDb();
  await db.transaction(async (tx) => {
    for (const r of results) {
      await tx.run(
        `INSERT INTO test_results (id, run_id, project_id, spec_file, title, full_title, scenario_key, outcome,
           duration_ms, attempts, error_message, error_stack, screenshots_json, video_path, trace_path,
           console_logs_json, network_logs_json, dom_snapshot, commit_sha, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [r.id, runId, projectId, r.specFile, r.title, r.fullTitle, r.scenarioId, r.outcome,
         r.durationMs, r.attempts, r.errorMessage, r.errorStack,
         JSON.stringify(r.screenshotPaths), r.videoPath, r.tracePath ?? null,
         JSON.stringify(r.consoleLogs.slice(0, 200)), JSON.stringify(r.networkLogs.slice(0, 200)),
         r.domSnapshot?.slice(0, 200_000) ?? null, commitSha, now()],
      );
    }
  });

  // Keep the last outcome on the generated test row so the dashboard can show
  // per-spec health without scanning every result.
  for (const specFile of new Set(results.map((r) => r.specFile))) {
    const specResults = results.filter((r) => r.specFile === specFile);
    const outcome = specResults.some((r) => r.outcome === 'failed') ? 'failed'
      : specResults.every((r) => r.outcome === 'passed') ? 'passed' : 'mixed';
    await db.run(
      'UPDATE generated_tests SET last_run_id = ?, last_outcome = ? WHERE project_id = ? AND spec_file = ?',
      [runId, outcome, projectId, specFile],
    );
  }
}

export async function listTestResults(runId: string): Promise<TestResult[]> {
  const db = await getDb();
  const rows = await db.query<Record<string, unknown>>(
    'SELECT * FROM test_results WHERE run_id = ? ORDER BY spec_file, full_title', [runId],
  );
  return rows.map((row) => ({
    id: String(row['id']),
    specFile: String(row['spec_file']),
    title: String(row['title']),
    fullTitle: String(row['full_title']),
    scenarioId: (row['scenario_key'] as string | null) ?? null,
    outcome: row['outcome'] as TestResult['outcome'],
    durationMs: Number(row['duration_ms']) || 0,
    errorMessage: (row['error_message'] as string | null) ?? null,
    errorStack: (row['error_stack'] as string | null) ?? null,
    screenshotPaths: fromJson<string[]>(row['screenshots_json'], []),
    videoPath: (row['video_path'] as string | null) ?? null,
    tracePath: (row['trace_path'] as string | null) ?? null,
    consoleLogs: fromJson<string[]>(row['console_logs_json'], []),
    networkLogs: fromJson<string[]>(row['network_logs_json'], []),
    domSnapshot: (row['dom_snapshot'] as string | null) ?? null,
    attempts: Number(row['attempts']) || 1,
  }));
}

/** Previously failed tests, for the "Run Failed Tests" mode. */
export async function previouslyFailedSpecs(projectId: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db.query<{ spec_file: string }>(
    `SELECT DISTINCT spec_file FROM failures
     WHERE project_id = ? AND resolution = 'open' ORDER BY spec_file`,
    [projectId],
  );
  return rows.map((r) => r.spec_file);
}

/* -------------------------------------------------------------------------- */
/* Failures                                                                    */
/* -------------------------------------------------------------------------- */
/**
 * A stable fingerprint so the same failure recurring across runs is recognised
 * as one problem rather than counted again each time.
 */
export function failureSignature(specFile: string, title: string, errorMessage: string | null): string {
  const normalized = (errorMessage ?? '')
    .replace(/\d+/g, 'N')
    .replace(/https?:\/\/[^\s)]+/g, 'URL')
    .replace(/\s+/g, ' ')
    .slice(0, 400);
  return shortHash(`${specFile}|${title}|${normalized}`);
}

export interface SaveFailureInput {
  projectId: string;
  runId: string;
  commitSha: string;
  result: TestResult;
  scenarioKey: string | null;
  businessRuleKey: string | null;
  analysis: FailureAnalyzerOutput;
  relevantDiff?: { path: string; patch?: string }[];
}

/** Removes results (and their failure records) that a healed test's re-run replaces. */
export async function forgetTestResults(runId: string, resultIds: string[]): Promise<void> {
  if (!resultIds.length) return;
  const db = await getDb();
  const marks = resultIds.map(() => '?').join(', ');
  await db.run(`DELETE FROM failures WHERE run_id = ? AND test_result_id IN (${marks})`, [runId, ...resultIds]);
  await db.run(`DELETE FROM test_results WHERE run_id = ? AND id IN (${marks})`, [runId, ...resultIds]);
}

export async function saveFailure(input: SaveFailureInput): Promise<FailureRecord> {
  const db = await getDb();
  const { result, analysis } = input;
  const signature = failureSignature(result.specFile, result.title, result.errorMessage);

  const prior = await db.one<{ id: string; occurrence_count: number }>(
    'SELECT id, occurrence_count FROM failures WHERE project_id = ? AND signature = ? ORDER BY occurred_at DESC LIMIT 1',
    [input.projectId, signature],
  );
  const occurrenceCount = (Number(prior?.occurrence_count) || 0) + 1;

  const id = uuid();
  const record: FailureRecord = {
    id,
    runId: input.runId,
    testResultId: result.id,
    testTitle: result.title,
    specFile: result.specFile,
    scenarioId: input.scenarioKey,
    businessRuleId: input.businessRuleKey,
    commitSha: input.commitSha,
    occurredAt: now(),
    errorMessage: result.errorMessage ?? '',
    classification: analysis.classification,
    confidence: analysis.confidence,
    rootCause: analysis.rootCause,
    recommendedAction: analysis.recommendedAction,
    requiresHumanReview: analysis.requiresHumanReview,
    resolution: analysis.isLikelyFlaky ? 'flaky' : 'open',
    observed: analysis.observed,
    inferred: analysis.inferred,
    unknown: analysis.unknown,
    evidence: {
      screenshots: result.screenshotPaths,
      video: result.videoPath,
      trace: result.tracePath ?? null,
      consoleLogCount: result.consoleLogs.length,
      networkLogCount: result.networkLogs.length,
      hasDomSnapshot: Boolean(result.domSnapshot),
      culpritFiles: analysis.likelyCulpritFiles,
      relevantDiff: (input.relevantDiff ?? []).map((d) => d.path),
      affectedArea: analysis.affectedArea || null,
      recommendedInvestigation: analysis.recommendedInvestigation,
    },
    signature,
    occurrenceCount,
    affectedArea: analysis.affectedArea || null,
    recommendedInvestigation: analysis.recommendedInvestigation,
  };

  await db.run(
    `INSERT INTO failures (id, project_id, run_id, test_result_id, spec_file, test_title, scenario_key,
       business_rule_key, commit_sha, occurred_at, error_message, classification, confidence, root_cause,
       recommended_action, requires_human_review, resolution, observed_json, inferred_json, unknown_json,
       evidence_json, culprit_files_json, signature, occurrence_count, is_flaky, analyzed_by_ai)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.projectId, input.runId, result.id, result.specFile, result.title, input.scenarioKey,
     input.businessRuleKey, input.commitSha, record.occurredAt, record.errorMessage,
     analysis.classification, analysis.confidence, analysis.rootCause, analysis.recommendedAction,
     analysis.requiresHumanReview ? 1 : 0, record.resolution,
     JSON.stringify(analysis.observed), JSON.stringify(analysis.inferred), JSON.stringify(analysis.unknown),
     JSON.stringify(record.evidence), JSON.stringify(analysis.likelyCulpritFiles),
     signature, occurrenceCount, analysis.isLikelyFlaky ? 1 : 0, 1],
  );

  // Store the AI's reasoning as evidence in its own right, so a report can
  // show how a classification was reached.
  await saveEvidence({
    projectId: input.projectId, runId: input.runId,
    subjectType: 'failure', subjectId: id, kind: 'ai_analysis',
    content: JSON.stringify(analysis, null, 2),
    metadata: { classification: analysis.classification, confidence: analysis.confidence },
  });

  for (const screenshot of result.screenshotPaths) {
    await saveEvidence({
      projectId: input.projectId, runId: input.runId,
      subjectType: 'failure', subjectId: id, kind: 'screenshot', filePath: screenshot,
    });
  }
  if (result.videoPath) {
    await saveEvidence({
      projectId: input.projectId, runId: input.runId,
      subjectType: 'failure', subjectId: id, kind: 'video', filePath: result.videoPath,
    });
  }
  if (result.tracePath) {
    await saveEvidence({
      projectId: input.projectId, runId: input.runId,
      subjectType: 'failure', subjectId: id, kind: 'trace', filePath: result.tracePath,
      metadata: { open: 'npx playwright show-trace <file>' },
    });
  }
  if (result.consoleLogs.length) {
    await saveEvidence({
      projectId: input.projectId, runId: input.runId,
      subjectType: 'failure', subjectId: id, kind: 'console_log',
      content: result.consoleLogs.join('\n').slice(0, 100_000),
    });
  }
  if (result.networkLogs.length) {
    await saveEvidence({
      projectId: input.projectId, runId: input.runId,
      subjectType: 'failure', subjectId: id, kind: 'network_log',
      content: result.networkLogs.join('\n').slice(0, 100_000),
    });
  }
  if (result.domSnapshot) {
    await saveEvidence({
      projectId: input.projectId, runId: input.runId,
      subjectType: 'failure', subjectId: id, kind: 'dom',
      content: result.domSnapshot.slice(0, 200_000),
    });
  }
  for (const diff of input.relevantDiff ?? []) {
    if (!diff.patch) continue;
    await saveEvidence({
      projectId: input.projectId, runId: input.runId,
      subjectType: 'failure', subjectId: id, kind: 'diff',
      content: diff.patch.slice(0, 50_000), metadata: { file: diff.path },
    });
  }

  log.info(`Recorded failure ${id.slice(0, 8)} (${analysis.classification}, occurrence ${occurrenceCount}).`);
  return record;
}

function rowToFailure(row: Record<string, unknown>): FailureRecord {
  const evidence = fromJson<Record<string, unknown>>(row['evidence_json'], {});
  return {
    id: String(row['id']),
    runId: String(row['run_id']),
    testResultId: String(row['test_result_id']),
    testTitle: String(row['test_title']),
    specFile: String(row['spec_file']),
    scenarioId: (row['scenario_key'] as string | null) ?? null,
    businessRuleId: (row['business_rule_key'] as string | null) ?? null,
    commitSha: String(row['commit_sha'] ?? ''),
    occurredAt: String(row['occurred_at']),
    errorMessage: String(row['error_message'] ?? ''),
    classification: (row['classification'] as FailureRecord['classification']) ?? null,
    confidence: row['confidence'] === null ? null : Number(row['confidence']),
    rootCause: (row['root_cause'] as string | null) ?? null,
    recommendedAction: (row['recommended_action'] as string | null) ?? null,
    requiresHumanReview: toBool(row['requires_human_review']),
    resolution: (row['resolution'] as FailureRecord['resolution']) ?? 'open',
    observed: fromJson<string[]>(row['observed_json'], []),
    inferred: fromJson<string[]>(row['inferred_json'], []),
    unknown: fromJson<string[]>(row['unknown_json'], []),
    evidence,
    signature: String(row['signature']),
    occurrenceCount: Number(row['occurrence_count']) || 1,
    affectedArea: typeof evidence['affectedArea'] === 'string' ? evidence['affectedArea'] as string : null,
    recommendedInvestigation: Array.isArray(evidence['recommendedInvestigation'])
      ? (evidence['recommendedInvestigation'] as unknown[]).map(String)
      : [],
  };
}

export async function listFailures(opts: { projectId?: string; runId?: string; resolution?: string; limit?: number }): Promise<FailureRecord[]> {
  const db = await getDb();
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.projectId) { clauses.push('project_id = ?'); params.push(opts.projectId); }
  if (opts.runId) { clauses.push('run_id = ?'); params.push(opts.runId); }
  if (opts.resolution) { clauses.push('resolution = ?'); params.push(opts.resolution); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await db.query<Record<string, unknown>>(
    `SELECT * FROM failures ${where} ORDER BY occurred_at DESC LIMIT ?`, [...params, opts.limit ?? 200],
  );
  return rows.map(rowToFailure);
}

export async function getFailure(failureId: string): Promise<FailureRecord | null> {
  const db = await getDb();
  const row = await db.one<Record<string, unknown>>('SELECT * FROM failures WHERE id = ?', [failureId]);
  return row ? rowToFailure(row) : null;
}

export async function setFailureResolution(failureId: string, resolution: FailureRecord['resolution']): Promise<void> {
  const db = await getDb();
  await db.run(
    'UPDATE failures SET resolution = ?, is_flaky = ? WHERE id = ?',
    [resolution, resolution === 'flaky' ? 1 : 0, failureId],
  );
}

/* -------------------------------------------------------------------------- */
/* Generic evidence                                                            */
/* -------------------------------------------------------------------------- */
export interface EvidenceInput {
  projectId: string;
  runId: string;
  subjectType: 'test_result' | 'failure' | 'scenario' | 'business_rule' | 'exploration';
  subjectId: string;
  kind: 'screenshot' | 'video' | 'trace' | 'console_log' | 'network_log' | 'dom' | 'diff' | 'source' | 'ai_analysis';
  filePath?: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

export async function saveEvidence(input: EvidenceInput): Promise<string> {
  const db = await getDb();
  const id = uuid();
  await db.run(
    `INSERT INTO evidence (id, project_id, run_id, subject_type, subject_id, kind, path, content, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.projectId, input.runId, input.subjectType, input.subjectId, input.kind,
     input.filePath ?? null, input.content ?? null, JSON.stringify(input.metadata ?? {}), now()],
  );
  return id;
}

export interface EvidenceRecord {
  id: string; kind: string; path: string | null; content: string | null;
  metadata: Record<string, unknown>; createdAt: string;
}

export async function listEvidence(subjectType: string, subjectId: string): Promise<EvidenceRecord[]> {
  const db = await getDb();
  const rows = await db.query<Record<string, unknown>>(
    'SELECT * FROM evidence WHERE subject_type = ? AND subject_id = ? ORDER BY created_at', [subjectType, subjectId],
  );
  return rows.map((row) => ({
    id: String(row['id']),
    kind: String(row['kind']),
    path: (row['path'] as string | null) ?? null,
    content: (row['content'] as string | null) ?? null,
    metadata: fromJson<Record<string, unknown>>(row['metadata_json'], {}),
    createdAt: String(row['created_at']),
  }));
}

/* -------------------------------------------------------------------------- */
/* Healing proposals                                                           */
/* -------------------------------------------------------------------------- */
export async function pruneOldArtifacts(projectId: string): Promise<number> {
  if (env.ARTIFACT_RETENTION_DAYS <= 0) return 0;
  const cutoff = new Date(Date.now() - env.ARTIFACT_RETENTION_DAYS * 86_400_000).toISOString();
  const db = await getDb();

  const stale = await db.query<{ path: string }>(
    `SELECT path FROM evidence WHERE project_id = ? AND created_at < ? AND path IS NOT NULL`,
    [projectId, cutoff],
  );
  let removed = 0;
  for (const { path: filePath } of stale) {
    try {
      if (filePath && fs.existsSync(filePath) && path.resolve(filePath).startsWith(path.resolve(env.artifactRoot))) {
        fs.rmSync(filePath, { force: true });
        removed++;
      }
    } catch { /* non-fatal */ }
  }
  await db.run('DELETE FROM evidence WHERE project_id = ? AND created_at < ?', [projectId, cutoff]);

  // Each Playwright run writes videos, screenshots and traces into its own directory.
  const runsDir = path.join(env.artifactRoot, projectId, 'runs');
  const cutoffMs = Date.parse(cutoff);
  try {
    for (const entry of fs.existsSync(runsDir) ? fs.readdirSync(runsDir, { withFileTypes: true }) : []) {
      const dir = path.join(runsDir, entry.name);
      if (!entry.isDirectory() || fs.statSync(dir).mtimeMs >= cutoffMs) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed++;
    }
  } catch { /* non-fatal */ }
  if (removed) log.info(`Pruned ${removed} artifact file(s) older than ${env.ARTIFACT_RETENTION_DAYS} days.`);
  return removed;
}
