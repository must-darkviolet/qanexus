/**
 * RegressionAdvisor.
 *
 * Receives the deterministic impact analysis (changed files traced to
 * components, features and tests), the relevant history and the diffs, and
 * recommends regression scenarios, their priority, the existing tests worth
 * running and the scenarios that are missing - each with its reasoning.
 *
 * The deterministic impact is never replaced: the advisor's output is merged
 * on top of it, test references are checked against tests that actually exist,
 * and every AI recommendation is labelled as such.
 */
import {
  RegressionAdvisorOutput, type ImpactReport, type RegressionRecommendation, type RepositoryDiff,
} from '@qa-agent/shared';
import { runAgent, SAFETY_PREAMBLE, bulletList, truncate, type AgentResult } from './base.js';
import { sanitizeForAi } from '../analysis/secrets.js';
import { packContext, Priority, userBudget } from '../ai/contextBudget.js';
import { env } from '../config/env.js';
import { compactPatch } from './context.js';
import { similarity } from '../knowledge/dedupe.js';
import { sha256 } from '../util/ids.js';

const SYSTEM = `${SAFETY_PREAMBLE}

You are the RegressionAdvisor, a senior QA engineer reviewing a code change.

You receive:
- the changed files and their diffs
- a deterministic impact trace: each changed file mapped to components,
  routes, features and the tests related to it, with the reason for each link
- coverage gaps already detected
- historical findings (earlier failures, fixed defects, flaky tests, hotspots)

Produce:
- summary: 2-4 sentences a QA lead and a manager can both act on. State the
  riskiest area first. No filler.
- recommendations: regression actions. For each: type, title, priority,
  feature (key or null), relatedTests (ONLY file paths from the RELATED TESTS
  list - never invent a file), reasoning (why this change makes it necessary,
  citing the diff or trace), evidence (file paths, symbols, rule ids you relied
  on), confidence.
  Focus on what the deterministic trace cannot see: indirect effects of a
  shared helper, a changed default, a validation limit whose boundary values
  now differ, state that another screen depends on.
- missingScenarios: concrete test scenarios that no related test covers,
  phrased as "Verify that ...". Only for behaviour visible in the diff.

Priorities: critical = likely user-facing breakage or security/auth impact;
high = changed business logic or validation; medium = changed UI behaviour;
low = cosmetic.

Do not recommend "add more tests" generically. Do not repeat the deterministic
recommendations verbatim - add to them. If the change is trivial, say so and
return few recommendations.

Return JSON matching the requested schema.`;

export interface RegressionAdvisorInput {
  projectId: string;
  runId: string | null;
  diff: RepositoryDiff;
  impact: ImpactReport;
}

export async function runRegressionAdvisor(
  input: RegressionAdvisorInput,
): Promise<AgentResult<RegressionAdvisorOutput>> {
  const { impact, diff } = input;

  const traceLines = impact.traces.slice(0, 40).map((t) =>
    `${t.file} [${t.status}, risk ${t.risk}]\n` +
    `    features: ${t.features.map((f) => f.key).join(', ') || 'none'}; routes: ${t.routes.join(', ') || 'none'}\n` +
    `    tests: ${t.relatedTests.map((r) => r.file).join(', ') || 'NONE'}\n` +
    `    why: ${t.reasoning.join(' ')}`,
  );

  const relatedTests = [...impact.coverage.relatedExistingTests, ...impact.coverage.relatedGeneratedTests];

  // Diffs of the riskiest files first, compacted, capped at AI_MAX_FILES_PER_REQUEST.
  const riskRank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const fileRisk = new Map(impact.traces.map((t) => [t.file, riskRank[t.risk] ?? 3]));
  const patches = diff.files.filter((f) => f.patch)
    .sort((a, b) => (fileRisk.get(a.path) ?? 3) - (fileRisk.get(b.path) ?? 3) || (b.additions + b.deletions) - (a.additions + a.deletions))
    .slice(0, env.AI_MAX_FILES_PER_REQUEST);

  const user = packContext([
    { title: '', body: `CHANGE SOURCE: ${impact.source.description}`, priority: Priority.task, required: true },
    { title: 'CHANGED FILES:', body: bulletList(diff.files.map((f) => `${f.status}: ${f.path} (+${f.additions}/-${f.deletions})`), 60), priority: Priority.change, required: true },
    { title: 'CHANGED DECLARATIONS:', body: bulletList(diff.changedFunctions.map((f) => `${f.change}: ${f.name} (${f.file})`), 50), priority: Priority.change },
    {
      title: 'CHANGED ROUTES / APIS / VALIDATIONS:',
      body: bulletList([
        ...diff.changedRoutes.map((r) => `route ${r.change}: ${r.path}`),
        ...diff.changedApis.map((a) => `api ${a.change}: ${a.method} ${a.path}`),
        ...diff.changedValidations.map((v) => `validation ${v.change}: ${v.field} in ${v.file}`),
      ], 40),
      priority: Priority.change,
    },
    { title: 'IMPACT TRACE (deterministic):', body: bulletList(traceLines, 40), priority: Priority.change },
    { title: 'RELATED TESTS (the only files you may reference):', body: bulletList(relatedTests.map((t) => `${t.file} [${t.origin}] - ${t.why}`), env.AI_MAX_TESTS_PER_REQUEST), priority: Priority.relatedTests, required: true },
    { title: 'COVERAGE GAPS ALREADY DETECTED:', body: bulletList(impact.coverage.gaps.map((g) => `${g.kind}: ${g.subject} - ${g.reason}`), 30), priority: Priority.relatedTests },
    {
      title: 'DIFFS (compacted):',
      body: patches.map((f) => `--- ${f.path} ---\n${truncate(sanitizeForAi(compactPatch(f.patch ?? '')), 1800, 'patch')}`).join('\n\n') || '(no patches available)',
      priority: Priority.pageObjects,
    },
    { title: 'DETERMINISTIC RECOMMENDATIONS ALREADY MADE:', body: bulletList(impact.recommendations.map((r) => `[${r.priority}] ${r.title}`), 30), priority: Priority.utilities },
    { title: 'HISTORICAL FINDINGS:', body: bulletList(impact.historicalFindings.map((h) => `${h.kind} (${h.matchedOn}): ${h.summary}`), 20), priority: Priority.history },
    { title: '', body: 'Advise on the regression for this change.', priority: Priority.task, required: true },
  ], userBudget(SYSTEM), 'RegressionAdvisor').text;

  return runAgent({
    agent: 'RegressionAdvisor',
    projectId: input.projectId,
    runId: input.runId,
    system: SYSTEM,
    user,
    schema: RegressionAdvisorOutput,
    temperature: 0.2,
    fallback: () => ({ summary: impact.summary, recommendations: [], missingScenarios: [] }),
  });
}

/**
 * Merges the advisor's output into the deterministic impact report. AI
 * recommendations that duplicate an existing one are dropped, and test
 * references that do not exist are removed rather than trusted.
 */
export function mergeAdvice(
  impact: ImpactReport,
  advice: AgentResult<RegressionAdvisorOutput>,
): ImpactReport {
  if (advice.source === 'fallback') {
    return {
      ...impact,
      ai: {
        source: 'fallback',
        note: advice.error
          ? `AI recommendations unavailable (${advice.error.slice(0, 160)}); showing deterministic analysis only.`
          : 'Deterministic analysis only.',
      },
    };
  }

  const knownTests = new Set([
    ...impact.coverage.relatedExistingTests.map((t) => t.file),
    ...impact.coverage.relatedGeneratedTests.map((t) => t.file),
  ]);
  const merged: RegressionRecommendation[] = [...impact.recommendations];
  const isDuplicate = (title: string) => merged.some((r) => similarity(r.title, title) > 0.8);

  for (const rec of advice.data.recommendations) {
    if (isDuplicate(rec.title)) continue;
    merged.push({
      id: `AI-${sha256(`${rec.type}|${rec.title}`).slice(0, 8)}`,
      type: rec.type, title: rec.title, priority: rec.priority, feature: rec.feature ?? null,
      relatedTests: rec.relatedTests.filter((t) => knownTests.has(t)),
      reasoning: rec.reasoning, evidence: rec.evidence, source: 'ai', confidence: rec.confidence,
    });
  }
  for (const missing of advice.data.missingScenarios) {
    if (isDuplicate(missing.title)) continue;
    merged.push({
      id: `AI-${sha256(`add_scenario|${missing.title}`).slice(0, 8)}`,
      type: 'add_scenario', title: missing.title, priority: missing.priority,
      feature: missing.feature ?? null, relatedTests: [], reasoning: missing.reasoning,
      evidence: [], source: 'ai', confidence: 0.6,
    });
  }

  const order = { critical: 4, high: 3, medium: 2, low: 1 } as const;
  merged.sort((a, b) => order[b.priority] - order[a.priority]);

  return {
    ...impact,
    summary: advice.data.summary?.trim() ? advice.data.summary : impact.summary,
    recommendations: merged,
    ai: {
      source: advice.source,
      note: advice.source === 'cache' ? 'AI recommendations served from cache (identical change seen before).' : null,
    },
  };
}
