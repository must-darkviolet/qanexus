/** Run records and their step-by-step progress. */
import type {
  AiUsageSummary, CoverageSnapshot, ExecutionSummary, RepositoryDiff,
  RunMode, RunStatus, RunStep, RunStepName, RunSummary,
} from '@qa-agent/shared';
import { fromJson, getDb } from '../client.js';
import { uuid } from '../../util/ids.js';
import { throwIfCancelled } from '../../util/cancellation.js';

const now = () => new Date().toISOString();

const ALL_STEPS: RunStepName[] = [
  'checkout', 'static_analysis', 'change_detection', 'memory_load',
  'repository_understanding', 'business_rules', 'application_map',
  'impact_analysis', 'authentication', 'browser_exploration', 'scenario_generation', 'existing_test_matching',
  'test_generation', 'regression_selection', 'test_execution', 'repository_tests',
  'failure_analysis', 'coverage',
];

export function initialSteps(): RunStep[] {
  return ALL_STEPS.map((name) => ({
    name, status: 'pending', startedAt: null, finishedAt: null, detail: '', metrics: {},
  }));
}

export async function createRun(projectId: string, mode: RunMode, branch: string): Promise<RunSummary> {
  const db = await getDb();
  const id = uuid();
  const steps = initialSteps();
  await db.run(
    `INSERT INTO runs (id, project_id, mode, status, branch, started_at, steps_json, counts_json)
     VALUES (?, ?, ?, 'queued', ?, ?, ?, '{}')`,
    [id, projectId, mode, branch, now(), JSON.stringify(steps)],
  );
  return (await getRun(id))!;
}

function rowToRun(row: Record<string, unknown>): RunSummary {
  return {
    id: String(row['id']),
    projectId: String(row['project_id']),
    mode: row['mode'] as RunMode,
    status: row['status'] as RunStatus,
    commitSha: (row['commit_sha'] as string | null) ?? null,
    previousCommitSha: (row['previous_commit_sha'] as string | null) ?? null,
    branch: String(row['branch']),
    startedAt: String(row['started_at']),
    finishedAt: (row['finished_at'] as string | null) ?? null,
    error: (row['error'] as string | null) ?? null,
    steps: fromJson<RunStep[]>(row['steps_json'], []),
    counts: fromJson<RunSummary['counts']>(row['counts_json'], {
      features: 0, businessRules: 0, scenarios: 0, newScenarios: 0, obsoleteScenarios: 0,
      tests: 0, newTests: 0, updatedTests: 0, changedFiles: 0, affectedFeatures: 0, affectedScenarios: 0,
    }),
    execution: fromJson<ExecutionSummary | null>(row['execution_json'], null),
    coverage: fromJson<CoverageSnapshot | null>(row['coverage_json'], null),
    aiUsage: fromJson<AiUsageSummary | null>(row['ai_usage_json'], null),
  };
}

export async function getRun(id: string): Promise<RunSummary | null> {
  const db = await getDb();
  const row = await db.one<Record<string, unknown>>('SELECT * FROM runs WHERE id = ?', [id]);
  return row ? rowToRun(row) : null;
}

export async function listRuns(projectId: string, limit = 25): Promise<RunSummary[]> {
  const db = await getDb();
  const rows = await db.query<Record<string, unknown>>(
    'SELECT * FROM runs WHERE project_id = ? ORDER BY started_at DESC LIMIT ?', [projectId, limit],
  );
  return rows.map(rowToRun);
}

export async function latestCompletedRun(projectId: string): Promise<RunSummary | null> {
  const db = await getDb();
  const row = await db.one<Record<string, unknown>>(
    `SELECT * FROM runs WHERE project_id = ? AND status = 'completed' ORDER BY started_at DESC LIMIT 1`, [projectId],
  );
  return row ? rowToRun(row) : null;
}

export async function updateRun(id: string, patch: {
  status?: RunStatus; commitSha?: string | null; previousCommitSha?: string | null;
  error?: string | null; steps?: RunStep[]; counts?: Partial<RunSummary['counts']>;
  execution?: ExecutionSummary | null; coverage?: CoverageSnapshot | null;
  aiUsage?: AiUsageSummary | null; diff?: RepositoryDiff | null;
  changeAnalysis?: unknown; finished?: boolean;
}): Promise<void> {
  const db = await getDb();
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (column: string, value: unknown) => { sets.push(`${column} = ?`); params.push(value); };

  if (patch.status !== undefined) set('status', patch.status);
  if (patch.commitSha !== undefined) set('commit_sha', patch.commitSha);
  if (patch.previousCommitSha !== undefined) set('previous_commit_sha', patch.previousCommitSha);
  if (patch.error !== undefined) set('error', patch.error?.slice(0, 4000) ?? null);
  if (patch.steps !== undefined) set('steps_json', JSON.stringify(patch.steps));
  if (patch.execution !== undefined) set('execution_json', patch.execution ? JSON.stringify(patch.execution) : null);
  if (patch.coverage !== undefined) set('coverage_json', patch.coverage ? JSON.stringify(patch.coverage) : null);
  if (patch.aiUsage !== undefined) set('ai_usage_json', patch.aiUsage ? JSON.stringify(patch.aiUsage) : null);
  if (patch.diff !== undefined) set('diff_json', patch.diff ? JSON.stringify(patch.diff) : null);
  if (patch.changeAnalysis !== undefined) set('change_analysis_json', patch.changeAnalysis ? JSON.stringify(patch.changeAnalysis) : null);
  if (patch.finished) set('finished_at', now());

  if (patch.counts !== undefined) {
    const current = (await getRun(id))?.counts ?? {};
    set('counts_json', JSON.stringify({ ...current, ...patch.counts }));
  }

  if (!sets.length) return;
  await db.run(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
}

export async function getRunDiff(runId: string): Promise<RepositoryDiff | null> {
  const db = await getDb();
  const row = await db.one<{ diff_json: string | null }>('SELECT diff_json FROM runs WHERE id = ?', [runId]);
  return fromJson<RepositoryDiff | null>(row?.diff_json, null);
}

export async function getRunChangeAnalysis<T>(runId: string): Promise<T | null> {
  const db = await getDb();
  const row = await db.one<{ change_analysis_json: string | null }>(
    'SELECT change_analysis_json FROM runs WHERE id = ?', [runId],
  );
  return fromJson<T | null>(row?.change_analysis_json, null);
}

/**
 * Tracks step progress. Steps are persisted on every transition so the
 * dashboard can poll a long-running analysis and show real progress.
 */
export class RunStepTracker {
  private steps: RunStep[];
  /** A stopped run throws at the start of its next step. */
  constructor(private readonly runId: string, steps?: RunStep[], private readonly signal?: AbortSignal) {
    this.steps = steps ?? initialSteps();
  }

  private find(name: RunStepName): RunStep {
    let step = this.steps.find((s) => s.name === name);
    if (!step) {
      step = { name, status: 'pending', startedAt: null, finishedAt: null, detail: '', metrics: {} };
      this.steps.push(step);
    }
    return step;
  }

  async start(name: RunStepName, detail = ''): Promise<void> {
    throwIfCancelled(this.signal);
    const step = this.find(name);
    step.status = 'running';
    step.startedAt = now();
    step.detail = detail;
    await this.flush();
  }

  async complete(name: RunStepName, detail = '', metrics: RunStep['metrics'] = {}): Promise<void> {
    const step = this.find(name);
    step.status = 'completed';
    step.finishedAt = now();
    if (detail) step.detail = detail;
    step.metrics = { ...step.metrics, ...metrics };
    await this.flush();
  }

  async skip(name: RunStepName, reason: string): Promise<void> {
    const step = this.find(name);
    step.status = 'skipped';
    step.finishedAt = now();
    step.detail = reason;
    await this.flush();
  }

  async fail(name: RunStepName, error: string): Promise<void> {
    const step = this.find(name);
    step.status = 'failed';
    step.finishedAt = now();
    step.detail = error.slice(0, 1000);
    await this.flush();
  }

  /** Marks whatever step was in progress as cut short by a stop. */
  async stopRunning(reason: string): Promise<void> {
    for (const step of this.steps) {
      if (step.status !== 'running') continue;
      step.status = 'skipped';
      step.finishedAt = now();
      step.detail = reason;
    }
    await this.flush();
  }

  snapshot(): RunStep[] { return this.steps; }

  private async flush(): Promise<void> {
    await updateRun(this.runId, { steps: this.steps });
  }
}
