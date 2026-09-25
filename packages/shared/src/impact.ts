/**
 * Regression intelligence types.
 *
 * The chain every impact report is built around:
 *
 *   Changed files -> Affected components -> Affected functionality
 *     -> Related tests -> Potential coverage gaps -> Recommended regression
 *
 * Each link carries the reason it was drawn, so a reviewer can see *why* an
 * area is considered affected rather than being asked to trust a verdict.
 */
import { z } from 'zod';
import { Priority } from './knowledge.js';

/** Where the change set being analysed came from. */
export const ImpactSource = z.object({
  kind: z.enum(['run', 'working_tree', 'range', 'first_analysis']),
  /** Base commit / ref of the comparison, null for a first analysis. */
  base: z.string().nullable(),
  /** Head commit / ref, or "WORKING_TREE" for uncommitted changes. */
  head: z.string(),
  description: z.string(),
});
export type ImpactSource = z.infer<typeof ImpactSource>;

export const RelatedTest = z.object({
  file: z.string(),
  /** generated: in the agent's own suite. existing: already in the repository. */
  origin: z.enum(['generated', 'existing']),
  titles: z.array(z.string()).default([]),
  why: z.string(),
  lastOutcome: z.string().nullable().default(null),
});
export type RelatedTest = z.infer<typeof RelatedTest>;

export const ImpactRisk = z.enum(['high', 'medium', 'low']);
export type ImpactRisk = z.infer<typeof ImpactRisk>;

/** One changed file traced through to the tests that exercise it. */
export const ImpactTrace = z.object({
  file: z.string(),
  status: z.string(),
  additions: z.number().int().default(0),
  deletions: z.number().int().default(0),
  changedSymbols: z.array(z.object({ name: z.string(), change: z.string() })).default([]),
  components: z.array(z.string()).default([]),
  /** Components elsewhere that render a component defined in this file. */
  dependentComponents: z.array(z.string()).default([]),
  routes: z.array(z.string()).default([]),
  apis: z.array(z.string()).default([]),
  features: z.array(z.object({ key: z.string(), name: z.string() })).default([]),
  relatedTests: z.array(RelatedTest).default([]),
  risk: ImpactRisk,
  /** Plain-language reasons, each one a verifiable statement. */
  reasoning: z.array(z.string()).default([]),
});
export type ImpactTrace = z.infer<typeof ImpactTrace>;

export const AffectedFeature = z.object({
  key: z.string(),
  name: z.string(),
  risk: ImpactRisk,
  changedFiles: z.array(z.string()).default([]),
  reasons: z.array(z.string()).default([]),
  relatedTests: z.array(RelatedTest).default([]),
  scenarioCount: z.number().int().default(0),
  rulesAffected: z.number().int().default(0),
});
export type AffectedFeature = z.infer<typeof AffectedFeature>;

export const CoverageGap = z.object({
  feature: z.string().nullable(),
  subject: z.string(),
  kind: z.enum(['no_tests', 'changed_without_test', 'rule_untested', 'route_untested', 'api_unexercised', 'never_passed']),
  reason: z.string(),
});
export type CoverageGap = z.infer<typeof CoverageGap>;

export const HistoricalFinding = z.object({
  kind: z.enum(['past_failure', 'past_defect', 'flaky_test', 'change_hotspot', 'accepted_behaviour']),
  /** What in the *current* change this finding was matched against. */
  matchedOn: z.string(),
  summary: z.string(),
  occurredAt: z.string().nullable().default(null),
  reference: z.string().nullable().default(null),
  occurrences: z.number().int().default(1),
  /** The additional regression step this history argues for. */
  recommendation: z.string(),
});
export type HistoricalFinding = z.infer<typeof HistoricalFinding>;

export const RecommendationType = z.enum([
  'run_existing_test',
  'add_scenario',
  'update_test',
  'historical_recheck',
  'manual_check',
  'full_regression',
]);
export type RecommendationType = z.infer<typeof RecommendationType>;

export const RegressionRecommendation = z.object({
  id: z.string(),
  type: RecommendationType,
  title: z.string(),
  priority: Priority,
  feature: z.string().nullable().default(null),
  relatedTests: z.array(z.string()).default([]),
  reasoning: z.string(),
  evidence: z.array(z.string()).default([]),
  /** deterministic: derived from code/graph. ai: model reasoning. history: from past findings. */
  source: z.enum(['deterministic', 'ai', 'history']),
  confidence: z.number().min(0).max(1).default(0.7),
});
export type RegressionRecommendation = z.infer<typeof RegressionRecommendation>;

export const ImpactReport = z.object({
  generatedAt: z.string(),
  source: ImpactSource,
  summary: z.string(),
  changedFiles: z.array(z.object({
    path: z.string(), status: z.string(),
    additions: z.number().int().default(0), deletions: z.number().int().default(0),
  })).default([]),
  traces: z.array(ImpactTrace).default([]),
  affectedFeatures: z.array(AffectedFeature).default([]),
  coverage: z.object({
    relatedExistingTests: z.array(RelatedTest).default([]),
    relatedGeneratedTests: z.array(RelatedTest).default([]),
    featuresAffected: z.number().int().default(0),
    featuresWithAnyTest: z.number().int().default(0),
    gaps: z.array(CoverageGap).default([]),
  }),
  recommendations: z.array(RegressionRecommendation).default([]),
  historicalFindings: z.array(HistoricalFinding).default([]),
  fullRegressionAdvised: z.boolean().default(false),
  fullRegressionReason: z.string().nullable().default(null),
  /** How the recommendations were produced - readers deserve to know. */
  ai: z.object({
    source: z.enum(['ai', 'cache', 'fallback']),
    note: z.string().nullable().default(null),
  }),
});
export type ImpactReport = z.infer<typeof ImpactReport>;

/** What the RegressionAdvisor agent returns. */
export const RegressionAdvisorOutput = z.object({
  summary: z.string(),
  recommendations: z.array(z.object({
    type: RecommendationType,
    title: z.string(),
    priority: Priority,
    feature: z.string().nullable().default(null),
    relatedTests: z.array(z.string()).default([]),
    reasoning: z.string(),
    evidence: z.array(z.string()).default([]),
    confidence: z.number().min(0).max(1),
  })).default([]),
  missingScenarios: z.array(z.object({
    feature: z.string().nullable().default(null),
    title: z.string(),
    reasoning: z.string(),
    priority: Priority,
  })).default([]),
});
export type RegressionAdvisorOutput = z.infer<typeof RegressionAdvisorOutput>;
