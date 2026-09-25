/**
 * Input/output schemas for every AI agent (spec section 25).
 *
 * Each agent has a narrow, dedicated prompt and a validated structured output.
 * Raw model output is never trusted: it is parsed through these schemas and
 * rejected (then repaired, then fallen back on) if it does not fit.
 */
import { z } from 'zod';
import {
  ApprovalState, BusinessRule, EvidenceRef, FailureClassification,
  FeatureInfo, Priority, ScenarioCategory, TestScenario, UserFlow,
} from './knowledge.js';

/* -------------------------------------------------------------------------- */
/* RepositoryAnalyzer                                                          */
/* -------------------------------------------------------------------------- */
export const RepositoryAnalyzerOutput = z.object({
  applicationName: z.string(),
  applicationPurpose: z.string(),
  domain: z.string(),
  architectureNotes: z.array(z.string()).default([]),
  features: z.array(z.object({
    key: z.string(),
    name: z.string(),
    description: z.string(),
    routes: z.array(z.string()).default([]),
    components: z.array(z.string()).default([]),
    files: z.array(z.string()).default([]),
    apis: z.array(z.string()).default([]),
    entities: z.array(z.string()).default([]),
    evidenceLevel: z.enum(['observed', 'inferred', 'unknown']).default('inferred'),
  })).default([]),
  openQuestions: z.array(z.string()).default([]),
});
export type RepositoryAnalyzerOutput = z.infer<typeof RepositoryAnalyzerOutput>;

/* -------------------------------------------------------------------------- */
/* BusinessRuleAnalyzer                                                        */
/* -------------------------------------------------------------------------- */
export const BusinessRuleAnalyzerOutput = z.object({
  rules: z.array(BusinessRule.omit({ id: true }).extend({ id: z.string().optional() })).default([]),
  unknowns: z.array(z.object({
    subject: z.string(),
    question: z.string(),
  })).default([]),
});
export type BusinessRuleAnalyzerOutput = z.infer<typeof BusinessRuleAnalyzerOutput>;

/* -------------------------------------------------------------------------- */
/* ApplicationMapper                                                           */
/* -------------------------------------------------------------------------- */
export const ApplicationMapperOutput = z.object({
  userFlows: z.array(UserFlow.omit({ key: true }).extend({ key: z.string().optional() })).default([]),
  roles: z.array(z.object({
    name: z.string(),
    canDo: z.array(z.string()).default([]),
    cannotDo: z.array(z.string()).default([]),
    evidenceLevel: z.enum(['observed', 'inferred', 'unknown']).default('inferred'),
  })).default([]),
  stateTransitions: z.array(z.object({
    entity: z.string(),
    from: z.string(),
    to: z.string(),
    trigger: z.string().optional(),
    evidenceLevel: z.enum(['observed', 'inferred', 'unknown']).default('inferred'),
  })).default([]),
  navigation: z.array(z.object({ from: z.string(), to: z.string(), via: z.string().optional() })).default([]),
});
export type ApplicationMapperOutput = z.infer<typeof ApplicationMapperOutput>;

/* -------------------------------------------------------------------------- */
/* ScenarioGenerator                                                           */
/* -------------------------------------------------------------------------- */
export const ScenarioGeneratorOutput = z.object({
  scenarios: z.array(z.object({
    feature: z.string(),
    category: ScenarioCategory,
    title: z.string(),
    description: z.string(),
    preconditions: z.array(z.string()).default([]),
    steps: z.array(z.string()).min(1),
    expectedResult: z.string(),
    businessRuleIds: z.array(z.string()).default([]),
    sourceEvidence: z.array(EvidenceRef).default([]),
    confidence: z.number().min(0).max(1),
    priority: Priority,
    role: z.string().optional(),
  })).default([]),
});
export type ScenarioGeneratorOutput = z.infer<typeof ScenarioGeneratorOutput>;

/* -------------------------------------------------------------------------- */
/* TestGenerator                                                               */
/* -------------------------------------------------------------------------- */
export const GeneratedLocator = z.object({
  name: z.string(),
  selector: z.string(),
  strategy: z.enum(['data-testid', 'aria-label', 'role', 'text', 'id', 'name', 'css', 'xpath']),
  /** Spec section 13: the AI must explain why a locator was selected. */
  rationale: z.string(),
  sourceFile: z.string().optional(),
});
export type GeneratedLocator = z.infer<typeof GeneratedLocator>;

export const TestStrategy = z.enum([
  'UI', 'NETWORK', 'UI_AND_NETWORK', 'DOM_STATE', 'API_MOCK', 'PAGE_OBJECT', 'UNIT_OR_COMPONENT', 'SOURCE_LEVEL', 'UNIMPLEMENTED',
]);
export type TestStrategy = z.infer<typeof TestStrategy>;

export const TestGeneratorOutput = z.object({
  pageObjects: z.array(z.object({
    className: z.string(),
    fileName: z.string(),
    url: z.string().optional(),
    locators: z.array(GeneratedLocator).default([]),
    methods: z.array(z.object({
      name: z.string(),
      params: z.array(z.object({ name: z.string(), type: z.string() })).default([]),
      body: z.string(),
      description: z.string().optional(),
    })).default([]),
  })).default([]),
  specs: z.array(z.object({
    fileName: z.string(),
    feature: z.string(),
    describe: z.string(),
    imports: z.array(z.string()).default([]),
    beforeEach: z.string().optional(),
    tests: z.array(z.object({
      scenarioId: z.string(),
      title: z.string(),
      body: z.string(),
      tags: z.array(z.string()).default([]),
      /** How the test proves the behaviour (see pipeline/strategy.ts). */
      strategy: TestStrategy.optional(),
      /** Where its evidence comes from: DOM, NETWORK, API_RESPONSE, PAGE_OBJECT, FIXTURE, UI_ACTION... */
      evidenceSource: z.string().optional(),
    })).default([]),
  })).default([]),
  /** Condition -> action -> observable effect, derived from the diff and the source. */
  behaviorMap: z.array(z.object({
    condition: z.string(), action: z.string(), effect: z.string(), scenarioIds: z.array(z.string()).default([]),
  })).default([]),
  /** Scenarios not implemented, and why each supported strategy could not be used. */
  unimplemented: z.array(z.object({
    scenarioId: z.string(),
    strategiesAttempted: z.array(z.object({ strategy: z.string(), whyNot: z.string() })).default([]),
    reason: z.string(),
  })).default([]),
  fixtures: z.array(z.object({ fileName: z.string(), json: z.string() })).default([]),
  reusedExistingArtifacts: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([]),
});
export type TestGeneratorOutput = z.infer<typeof TestGeneratorOutput>;

/* -------------------------------------------------------------------------- */
/* ChangeAnalyzer                                                              */
/* -------------------------------------------------------------------------- */
export const ChangeAnalyzerOutput = z.object({
  summary: z.string(),
  affectedFeatures: z.array(z.object({
    feature: z.string(),
    reason: z.string(),
    impact: z.enum(['high', 'medium', 'low']),
  })).default([]),
  changedBusinessRules: z.array(z.object({
    ruleId: z.string().optional(),
    description: z.string(),
    change: z.enum(['added', 'modified', 'removed', 'possibly_affected']),
    evidence: z.array(EvidenceRef).default([]),
  })).default([]),
  affectedScenarioIds: z.array(z.string()).default([]),
  obsoleteScenarioIds: z.array(z.string()).default([]),
  missingScenarioDescriptions: z.array(z.string()).default([]),
  testsRequiringModification: z.array(z.object({ testFile: z.string(), reason: z.string() })).default([]),
  newTestsRecommended: z.array(z.string()).default([]),
});
export type ChangeAnalyzerOutput = z.infer<typeof ChangeAnalyzerOutput>;

/* -------------------------------------------------------------------------- */
/* RegressionSelector                                                          */
/* -------------------------------------------------------------------------- */
export const RegressionSelectorOutput = z.object({
  selectedSpecs: z.array(z.object({
    specFile: z.string(),
    reason: z.string(),
    confidence: z.number().min(0).max(1),
  })).default([]),
  skippedSpecs: z.array(z.object({ specFile: z.string(), reason: z.string() })).default([]),
  recommendFullRegression: z.boolean().default(false),
  rationale: z.string().default(''),
});
export type RegressionSelectorOutput = z.infer<typeof RegressionSelectorOutput>;

/* -------------------------------------------------------------------------- */
/* FailureAnalyzer (spec section 17)                                           */
/* -------------------------------------------------------------------------- */
export const FailureAnalyzerOutput = z.object({
  classification: FailureClassification,
  confidence: z.number().min(0).max(1),
  rootCause: z.string(),
  evidence: z.array(z.string()).default([]),
  recommendedAction: z.string(),
  requiresHumanReview: z.boolean(),
  /** Kept apart so a report never blurs fact and guess. */
  observed: z.array(z.string()).default([]),
  inferred: z.array(z.string()).default([]),
  unknown: z.array(z.string()).default([]),
  likelyCulpritFiles: z.array(z.string()).default([]),
  relatedPastFailureIds: z.array(z.string()).default([]),
  isLikelyFlaky: z.boolean().default(false),
  /** The feature or area of the application the failure lands in. */
  affectedArea: z.string().default(''),
  /** Ordered, concrete investigation steps - not a verdict. */
  recommendedInvestigation: z.array(z.string()).default([]),
});
export type FailureAnalyzerOutput = z.infer<typeof FailureAnalyzerOutput>;


export const AgentName = z.enum([
  'RepositoryAnalyzer',
  'BusinessRuleAnalyzer',
  'ApplicationMapper',
  'ScenarioGenerator',
  'TestGenerator',
  'ChangeAnalyzer',
  'RegressionSelector',
  'FailureAnalyzer',
  'RegressionAdvisor',
]);
export type AgentName = z.infer<typeof AgentName>;

export { ApprovalState, BusinessRule, FeatureInfo, TestScenario };
