/**
 * Regression impact service.
 *
 * Builds an ImpactReport for a change set, from any of three sources:
 *   - a pipeline run (previous analyzed commit -> current commit)
 *   - an arbitrary ref range in the project workspace (base..head)
 *   - uncommitted working-tree changes of a local repository (git status/diff)
 *
 * The deterministic trace is always computed; historical findings are matched
 * against it; the AI advisor then adds reasoning on top when it is available.
 */
import path from 'node:path';
import fs from 'node:fs';
import type { ImpactReport, ImpactSource, Project, RepositoryDiff, StaticAnalysis } from '@qa-agent/shared';
import { getDb, fromJson } from '../db/client.js';
import { uuid } from '../util/ids.js';
import { createLogger } from '../util/logger.js';
import { badRequest, conflict } from '../util/errors.js';
import { computeImpact } from '../knowledge/impact.js';
import { listBusinessRules, listFeatures, listScenarios, type TraceLink } from '../knowledge/store.js';
import { findHistoricalFindings } from '../memory/history.js';
import { runRegressionAdvisor, mergeAdvice } from '../agents/regressionAdvisor.js';
import { listGeneratedTests } from './testRegistry.js';
import { analyzeRepository } from '../analysis/staticAnalyzer.js';
import { buildRepositoryDiff } from '../analysis/changeDetector.js';
import { isSecretFile } from '../analysis/secrets.js';
import { buildImportedBy } from '../analysis/imports.js';
import {
  checkoutRepository, commitsBetween, diffCommits, diffWorkingTree, fileAtCommit,
  isGitRepository, readWorkingFile, resolveRef, workspaceDir,
} from '../github/workspace.js';
import { isLocalRepo, parseRepoUrl } from '../github/auth.js';
import { getProjectSecrets } from '../db/repos/projects.js';
import { latestSnapshot } from '../memory/store.js';

const log = createLogger('impact');

export interface BuildImpactOptions {
  projectId: string;
  runId: string | null;
  source: ImpactSource;
  diff: RepositoryDiff;
  analysis: StaticAnalysis;
  importedBy?: Record<string, string[]>;
  useAi?: boolean;
}

export async function buildImpact(opts: BuildImpactOptions): Promise<ImpactReport> {
  const { projectId, diff, analysis } = opts;
  const db = await getDb();
  const [features, rules, scenarios, generated, traceRows] = await Promise.all([
    listFeatures(projectId),
    listBusinessRules(projectId, { activeOnly: true }),
    listScenarios(projectId),
    listGeneratedTests(projectId, { kind: 'spec' }),
    db.query<Record<string, unknown>>(
      'SELECT source_file, feature_key, business_rule_key, scenario_key, spec_file FROM traceability WHERE project_id = ?',
      [projectId],
    ),
  ]);
  const traces: TraceLink[] = traceRows.map((row) => ({
    sourceFile: String(row['source_file']),
    featureKey: (row['feature_key'] as string | null) ?? null,
    businessRuleKey: (row['business_rule_key'] as string | null) ?? null,
    scenarioKey: (row['scenario_key'] as string | null) ?? null,
    specFile: (row['spec_file'] as string | null) ?? null,
  }));
  const generatedTests = generated.map((g) => ({
    specFile: g.specFile, featureKey: g.featureKey, scenarioKeys: g.scenarioKeys, lastOutcome: g.lastOutcome,
  }));

  const base = { source: opts.source, diff, analysis, features, rules, scenarios, traces, generatedTests, importedBy: opts.importedBy };
  // First pass tells us which features and specs are in play; history is then
  // matched against exactly those.
  const firstPass = computeImpact(base);
  const affectedKeys = firstPass.affectedFeatures.map((f) => f.key);
  const history = diff.files.length === 0 ? [] : await findHistoricalFindings(projectId, {
    changedFiles: diff.files.flatMap((f) => (f.previousPath ? [f.path, f.previousPath] : [f.path])),
    featureKeys: affectedKeys,
    specFiles: [...firstPass.coverage.relatedExistingTests, ...firstPass.coverage.relatedGeneratedTests].map((t) => t.file),
    scenarioKeys: scenarios.filter((s) => affectedKeys.includes(s.feature)).map((s) => s.id),
    excludeRunId: opts.runId,
  });
  let impact = computeImpact({ ...base, historicalFindings: history });

  if (opts.useAi !== false && diff.files.length > 0) {
    const advice = await runRegressionAdvisor({ projectId, runId: opts.runId, diff, impact });
    impact = mergeAdvice(impact, advice);
  }

  log.info(`Impact: ${impact.summary}`);
  return impact;
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                 */
/* -------------------------------------------------------------------------- */
export async function saveImpact(projectId: string, runId: string | null, impact: ImpactReport): Promise<string> {
  const db = await getDb();
  const id = uuid();
  await db.run(
    `INSERT INTO impact_reports (id, project_id, run_id, source_kind, base_ref, head_ref, report_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, projectId, runId, impact.source.kind, impact.source.base, impact.source.head, JSON.stringify(impact), impact.generatedAt],
  );
  return id;
}


