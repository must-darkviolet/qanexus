/**
 * Token and cost tracking (spec section 26).
 *
 * Every AI call - hit, miss or failure - is recorded so the dashboard can show
 * real numbers rather than an estimate invented at render time.
 */
import type { AiUsageSummary } from '@qa-agent/shared';
import { getDb } from '../db/client.js';
import { uuid } from '../util/ids.js';

export interface UsageRecord {
  projectId: string | null;
  runId: string | null;
  agent: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
  cached: boolean;
  failed: boolean;
  error?: string;
  durationMs: number;
}

export async function recordUsage(record: UsageRecord): Promise<void> {
  const db = await getDb();
  await db.run(
    `INSERT INTO ai_usage
       (id, project_id, run_id, agent, provider, model, prompt_tokens, completion_tokens, total_tokens,
        estimated_cost_usd, cached, failed, error, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuid(), record.projectId, record.runId, record.agent, record.provider, record.model,
      record.promptTokens, record.completionTokens, record.promptTokens + record.completionTokens,
      record.estimatedCostUsd, record.cached ? 1 : 0, record.failed ? 1 : 0,
      record.error?.slice(0, 1000) ?? null, record.durationMs, new Date().toISOString(),
    ],
  );
}

interface UsageRow {
  agent: string; requests: number; cached: number; failed: number;
  prompt_tokens: number; completion_tokens: number; total_tokens: number; cost: number;
}

async function summarize(where: string, params: unknown[]): Promise<AiUsageSummary> {
  const db = await getDb();
  const rows = await db.query<UsageRow>(
    `SELECT agent,
            COUNT(*) AS requests,
            SUM(cached) AS cached,
            SUM(failed) AS failed,
            SUM(prompt_tokens) AS prompt_tokens,
            SUM(completion_tokens) AS completion_tokens,
            SUM(total_tokens) AS total_tokens,
            SUM(estimated_cost_usd) AS cost
     FROM ai_usage WHERE ${where} GROUP BY agent`,
    params,
  );

  const summary: AiUsageSummary = {
    requests: 0, cachedRequests: 0, failedRequests: 0,
    promptTokens: 0, completionTokens: 0, totalTokens: 0,
    estimatedCostUsd: 0, byAgent: {},
  };

  for (const row of rows) {
    const requests = Number(row.requests) || 0;
    const cached = Number(row.cached) || 0;
    const failed = Number(row.failed) || 0;
    const totalTokens = Number(row.total_tokens) || 0;
    summary.requests += requests;
    summary.cachedRequests += cached;
    summary.failedRequests += failed;
    summary.promptTokens += Number(row.prompt_tokens) || 0;
    summary.completionTokens += Number(row.completion_tokens) || 0;
    summary.totalTokens += totalTokens;
    summary.estimatedCostUsd += Number(row.cost) || 0;
    summary.byAgent[row.agent] = { requests, cached, failed, totalTokens };
  }
  summary.estimatedCostUsd = Math.round(summary.estimatedCostUsd * 1e6) / 1e6;
  return summary;
}

export function usageForRun(runId: string): Promise<AiUsageSummary> {
  return summarize('run_id = ?', [runId]);
}

export function usageForProject(projectId: string): Promise<AiUsageSummary> {
  return summarize('project_id = ?', [projectId]);
}
