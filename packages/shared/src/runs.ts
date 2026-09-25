/** Run/execution/report types shared by the API and the dashboard. */
import { z } from 'zod';
import { ApprovalState, CoverageSnapshot, FailureClassification } from './knowledge.js';

export const RunMode = z.enum([
  'analyze',            // understand the repo, no test execution
  'generate',           // analyze + generate scenarios and tests
  'run_changed',        // targeted regression on changed features
  'run_full',           // full regression
  'run_failed',         // re-run only previously failed tests
  'full_cycle',         // analyze -> generate -> run -> analyze failures -> report
]);
export type RunMode = z.infer<typeof RunMode>;

export const RunStatus = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']);
export type RunStatus = z.infer<typeof RunStatus>;

export const RunStepName = z.enum([
  'checkout',
  'static_analysis',
  'change_detection',
  'memory_load',
  'repository_understanding',
  'business_rules',
  'application_map',
  'impact_analysis',
  'authentication',
  'browser_exploration',
  'scenario_generation',
  'existing_test_matching',
  'test_generation',
  'regression_selection',
  'test_execution',
  'repository_tests',
  'failure_analysis',
  'coverage',
]);
export type RunStepName = z.infer<typeof RunStepName>;

export const RunStep = z.object({
  name: RunStepName,
  status: z.enum(['pending', 'running', 'completed', 'skipped', 'failed']),
  startedAt: z.string().nullable().default(null),
  finishedAt: z.string().nullable().default(null),
  detail: z.string().default(''),
  metrics: z.record(z.union([z.number(), z.string(), z.boolean()])).default({}),
});
export type RunStep = z.infer<typeof RunStep>;

export const TestOutcome = z.enum(['passed', 'failed', 'skipped', 'pending']);
export type TestOutcome = z.infer<typeof TestOutcome>;

export const TestResult = z.object({
  id: z.string(),
  specFile: z.string(),
  title: z.string(),
  fullTitle: z.string(),
  scenarioId: z.string().nullable().default(null),
  outcome: TestOutcome,
  durationMs: z.number().int().default(0),
  errorMessage: z.string().nullable().default(null),
  errorStack: z.string().nullable().default(null),
  screenshotPaths: z.array(z.string()).default([]),
  videoPath: z.string().nullable().default(null),
  /** Playwright trace (open with `npx playwright show-trace`), kept for failures. */
  tracePath: z.string().nullable().default(null),
  consoleLogs: z.array(z.string()).default([]),
  networkLogs: z.array(z.string()).default([]),
  domSnapshot: z.string().nullable().default(null),
  attempts: z.number().int().default(1),
  /** Failed at first and passed on a retry. */
  flaky: z.boolean().optional(),
  /** The page the test was on when it ended (recorded for failures). */
  pageUrl: z.string().nullable().optional(),
  /** Why a skipped or pending test did not run. */
  skipReason: z.string().nullable().optional(),
});
export type TestResult = z.infer<typeof TestResult>;

export const ExecutionSummary = z.object({
  total: z.number().int(),
  passed: z.number().int(),
  failed: z.number().int(),
  skipped: z.number().int(),
  pending: z.number().int(),
  durationMs: z.number().int(),
  specsRun: z.number().int(),
  startedAt: z.string(),
  finishedAt: z.string(),
});
export type ExecutionSummary = z.infer<typeof ExecutionSummary>;

export const FailureRecord = z.object({
  id: z.string(),
  runId: z.string(),
  testResultId: z.string(),
  testTitle: z.string(),
  specFile: z.string(),
  scenarioId: z.string().nullable(),
  businessRuleId: z.string().nullable(),
  commitSha: z.string(),
  occurredAt: z.string(),
  errorMessage: z.string(),
  classification: FailureClassification.nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  rootCause: z.string().nullable(),
  recommendedAction: z.string().nullable(),
  requiresHumanReview: z.boolean().default(true),
  resolution: z.enum(['open', 'fixed', 'accepted', 'flaky', 'wont_fix', 'duplicate']).default('open'),
  observed: z.array(z.string()).default([]),
  inferred: z.array(z.string()).default([]),
  unknown: z.array(z.string()).default([]),
  evidence: z.record(z.unknown()).default({}),
  signature: z.string(),
  occurrenceCount: z.number().int().default(1),
  /** The feature / area of the application the failure lands in. */
  affectedArea: z.string().nullable().default(null),
  /** Concrete next steps for whoever investigates this failure. */
  recommendedInvestigation: z.array(z.string()).default([]),
});
export type FailureRecord = z.infer<typeof FailureRecord>;

export const AiUsageSummary = z.object({
  requests: z.number().int(),
  cachedRequests: z.number().int(),
  failedRequests: z.number().int(),
  promptTokens: z.number().int(),
  completionTokens: z.number().int(),
  totalTokens: z.number().int(),
  estimatedCostUsd: z.number(),
  byAgent: z.record(z.object({
    requests: z.number().int(),
    cached: z.number().int(),
    failed: z.number().int(),
    totalTokens: z.number().int(),
  })).default({}),
});
export type AiUsageSummary = z.infer<typeof AiUsageSummary>;

export const RunSummary = z.object({
  id: z.string(),
  projectId: z.string(),
  mode: RunMode,
  status: RunStatus,
  commitSha: z.string().nullable(),
  previousCommitSha: z.string().nullable(),
  branch: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  error: z.string().nullable(),
  steps: z.array(RunStep).default([]),
  counts: z.object({
    features: z.number().int().default(0),
    businessRules: z.number().int().default(0),
    scenarios: z.number().int().default(0),
    newScenarios: z.number().int().default(0),
    obsoleteScenarios: z.number().int().default(0),
    tests: z.number().int().default(0),
    newTests: z.number().int().default(0),
    updatedTests: z.number().int().default(0),
    changedFiles: z.number().int().default(0),
    affectedFeatures: z.number().int().default(0),
    affectedScenarios: z.number().int().default(0),
  }).default({}),
  execution: ExecutionSummary.nullable().default(null),
  coverage: CoverageSnapshot.nullable().default(null),
  aiUsage: AiUsageSummary.nullable().default(null),
});
export type RunSummary = z.infer<typeof RunSummary>;

export const ProjectInput = z.object({
  name: z.string().min(1),
  repoUrl: z.string().min(1),
  branch: z.string().default('main'),
  commitish: z.string().optional(),
  testBaseUrl: z.string().optional(),
  /** Stored encrypted at rest; never returned to the frontend. */
  credentials: z.record(z.string()).optional(),
  githubToken: z.string().optional(),
});
export type ProjectInput = z.infer<typeof ProjectInput>;

export const Project = z.object({
  id: z.string(),
  name: z.string(),
  repoUrl: z.string(),
  owner: z.string(),
  repo: z.string(),
  branch: z.string(),
  commitish: z.string().nullable(),
  testBaseUrl: z.string().nullable(),
  isPrivate: z.boolean().default(false),
  lastAnalyzedCommit: z.string().nullable(),
  lastAnalyzedAt: z.string().nullable(),
  hasStoredToken: z.boolean().default(false),
  hasStoredCredentials: z.boolean().default(false),
  createdAt: z.string(),
});
export type Project = z.infer<typeof Project>;
