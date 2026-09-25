/**
 * The Application Knowledge Model (spec section 6).
 *
 * Everything the agent learns about an application is expressed with these
 * types, and every one of them carries enough provenance to answer
 * "how do you know that?".
 */
import { z } from 'zod';

/**
 * Epistemic status. Spec section 28 ("Important AI Safety Rule") requires the
 * system to keep these apart and never present an inference as a fact.
 */
export const EvidenceLevel = z.enum(['observed', 'inferred', 'unknown']);
export type EvidenceLevel = z.infer<typeof EvidenceLevel>;

/** How strongly a business rule is believed. */
export const RequirementStatus = z.enum([
  'confirmed', // directly stated by code/docs, e.g. a literal validation rule
  'strongly_inferred',
  'weakly_inferred',
  'unknown',
]);
export type RequirementStatus = z.infer<typeof RequirementStatus>;

/** Human approval workflow shared by generated artifacts (spec section 23). */
export const ApprovalState = z.enum([
  'ai_generated',
  'needs_review',
  'approved',
  'rejected',
  'modified',
]);
export type ApprovalState = z.infer<typeof ApprovalState>;

/** A pointer back to the source material that justifies a claim. */
export const EvidenceRef = z.object({
  kind: z.enum([
    'source_file',
    'route_definition',
    'api_call',
    'type_definition',
    'constant',
    'validation_schema',
    'existing_test',
    'readme',
    'documentation',
    'comment',
    'commit_message',
    'git_diff',
    'browser_observation',
    'screenshot',
    'video',
    'console_log',
    'network_log',
    'dom_snapshot',
  ]),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  excerpt: z.string().max(2000).optional(),
  detail: z.string().max(2000).optional(),
});
export type EvidenceRef = z.infer<typeof EvidenceRef>;

export const Route = z.object({
  path: z.string(),
  file: z.string(),
  kind: z.enum(['page', 'layout', 'api', 'dynamic', 'catch_all', 'unknown']),
  params: z.array(z.string()).default([]),
  requiresAuth: z.boolean().optional(),
  guardedByRoles: z.array(z.string()).default([]),
  framework: z.enum(['next_app', 'next_pages', 'react_router', 'remix', 'unknown']),
});
export type Route = z.infer<typeof Route>;

export const FormField = z.object({
  name: z.string(),
  label: z.string().optional(),
  inputType: z.string().optional(),
  required: z.boolean().optional(),
  validation: z.array(z.string()).default([]),
  selector: z.string().optional(),
});
export type FormField = z.infer<typeof FormField>;

export const UiElement = z.object({
  kind: z.enum(['button', 'input', 'select', 'checkbox', 'radio', 'textarea', 'link', 'table', 'modal', 'other']),
  label: z.string().optional(),
  /** The most stable selector we could find, plus why it was chosen. */
  selector: z.string().optional(),
  selectorStrategy: z.enum(['data-testid', 'aria-label', 'role', 'text', 'id', 'name', 'css', 'xpath', 'none']).optional(),
  selectorRationale: z.string().optional(),
  action: z.string().optional(),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
});
export type UiElement = z.infer<typeof UiElement>;

export const ComponentInfo = z.object({
  name: z.string(),
  file: z.string(),
  kind: z.enum(['page', 'component', 'layout', 'hook', 'service', 'api_client', 'store', 'util', 'test', 'unknown']),
  exported: z.boolean().default(true),
  props: z.array(z.string()).default([]),
  forms: z.array(z.object({ name: z.string().optional(), fields: z.array(FormField) })).default([]),
  elements: z.array(UiElement).default([]),
  usesComponents: z.array(z.string()).default([]),
  callsApis: z.array(z.string()).default([]),
  conditionalRendering: z.array(z.string()).default([]),
  loadingStates: z.array(z.string()).default([]),
  errorStates: z.array(z.string()).default([]),
  emptyStates: z.array(z.string()).default([]),
});
export type ComponentInfo = z.infer<typeof ComponentInfo>;

export const ApiEndpoint = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'UNKNOWN']),
  path: z.string(),
  file: z.string(),
  line: z.number().int().positive().optional(),
  callerComponent: z.string().optional(),
  requestShape: z.string().optional(),
  responseShape: z.string().optional(),
  errorCodes: z.array(z.number().int()).default([]),
  requiresAuth: z.boolean().optional(),
});
export type ApiEndpoint = z.infer<typeof ApiEndpoint>;

export const ValidationRule = z.object({
  entity: z.string().optional(),
  field: z.string(),
  rule: z.string(),
  message: z.string().optional(),
  library: z.enum(['zod', 'yup', 'joi', 'react_hook_form', 'html5', 'manual', 'unknown']),
  file: z.string(),
  line: z.number().int().positive().optional(),
});
export type ValidationRule = z.infer<typeof ValidationRule>;

export const RoleInfo = z.object({
  name: z.string(),
  source: z.string(),
  permissions: z.array(z.string()).default([]),
});
export type RoleInfo = z.infer<typeof RoleInfo>;

export const PermissionCheck = z.object({
  expression: z.string(),
  roles: z.array(z.string()).default([]),
  permission: z.string().optional(),
  guards: z.string().optional(),
  file: z.string(),
  line: z.number().int().positive().optional(),
});
export type PermissionCheck = z.infer<typeof PermissionCheck>;

export const StateMachine = z.object({
  entity: z.string(),
  states: z.array(z.string()),
  transitions: z.array(z.object({ from: z.string(), to: z.string(), trigger: z.string().optional() })).default([]),
  file: z.string(),
});
export type StateMachine = z.infer<typeof StateMachine>;

export const EntityInfo = z.object({
  name: z.string(),
  file: z.string(),
  fields: z.array(z.object({ name: z.string(), type: z.string(), optional: z.boolean().default(false) })).default([]),
  kind: z.enum(['interface', 'type', 'class', 'enum', 'schema']),
});
export type EntityInfo = z.infer<typeof EntityInfo>;

export const FeatureInfo = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string().optional(),
  routes: z.array(z.string()).default([]),
  components: z.array(z.string()).default([]),
  files: z.array(z.string()).default([]),
  apis: z.array(z.string()).default([]),
  entities: z.array(z.string()).default([]),
  evidenceLevel: EvidenceLevel.default('inferred'),
});
export type FeatureInfo = z.infer<typeof FeatureInfo>;

export const UserFlow = z.object({
  key: z.string(),
  name: z.string(),
  feature: z.string(),
  role: z.string().optional(),
  steps: z.array(z.string()),
  evidence: z.array(EvidenceRef).default([]),
});
export type UserFlow = z.infer<typeof UserFlow>;

/** Spec section 5: the shape every inferred requirement is stored in. */
export const BusinessRule = z.object({
  id: z.string(),
  feature: z.string(),
  description: z.string(),
  evidence: z.array(EvidenceRef).default([]),
  confidence: z.number().min(0).max(1),
  status: RequirementStatus,
  /** Kept separate on purpose - see spec section 28. */
  observed: z.array(z.string()).default([]),
  inferred: z.array(z.string()).default([]),
  unknown: z.array(z.string()).default([]),
  relatedRoutes: z.array(z.string()).default([]),
  relatedApis: z.array(z.string()).default([]),
  relatedFiles: z.array(z.string()).default([]),
  category: z.enum([
    'authorization', 'validation', 'workflow', 'state_transition',
    'data_integrity', 'navigation', 'error_handling', 'other',
  ]).default('other'),
});
export type BusinessRule = z.infer<typeof BusinessRule>;

export const ScenarioCategory = z.enum([
  'functional', 'negative', 'boundary', 'validation',
  'authorization', 'state_transition', 'error_handling', 'ui_behavior', 'regression',
]);
export type ScenarioCategory = z.infer<typeof ScenarioCategory>;

export const Priority = z.enum(['critical', 'high', 'medium', 'low']);
export type Priority = z.infer<typeof Priority>;

/** Spec section 11: every scenario carries these fields. */
export const TestScenario = z.object({
  id: z.string(),
  feature: z.string(),
  category: ScenarioCategory,
  title: z.string(),
  description: z.string(),
  preconditions: z.array(z.string()).default([]),
  steps: z.array(z.string()),
  expectedResult: z.string(),
  businessRuleIds: z.array(z.string()).default([]),
  sourceEvidence: z.array(EvidenceRef).default([]),
  confidence: z.number().min(0).max(1),
  priority: Priority,
  role: z.string().optional(),
  relatedTestIds: z.array(z.string()).default([]),
  /** Set when this scenario was matched to a pre-existing test in the repo. */
  coveredByExistingTest: z.string().optional(),
  approvalState: ApprovalState.default('ai_generated'),
});
export type TestScenario = z.infer<typeof TestScenario>;

export const FailureClassification = z.enum([
  'APPLICATION_BUG',
  'TEST_BUG',
  'LOCATOR_CHANGED',
  'UI_CHANGED',
  'API_FAILURE',
  'AUTHENTICATION_FAILURE',
  'ENVIRONMENT_FAILURE',
  'NETWORK_FAILURE',
  'TIMING_OR_STATE_ISSUE',
  /** Missing or invalid seed / fixture data the test depends on. */
  'TEST_DATA_ISSUE',
  /** A third-party or backing service the app depends on is down or erroring. */
  'DEPENDENCY_FAILURE',
  /** The same failure already happened before this change; not caused by it. */
  'PREEXISTING_FAILURE',
  'UNKNOWN',
]);
export type FailureClassification = z.infer<typeof FailureClassification>;

/** The application itself behaves incorrectly. */
export const PRODUCT_DEFECT_CLASSES: readonly FailureClassification[] = ['APPLICATION_BUG', 'API_FAILURE'];
/** The run could not exercise the product fairly: credentials, environment, network, dependencies, data. */
export const INFRASTRUCTURE_CLASSES: readonly FailureClassification[] = [
  'AUTHENTICATION_FAILURE', 'ENVIRONMENT_FAILURE', 'NETWORK_FAILURE', 'DEPENDENCY_FAILURE', 'TEST_DATA_ISSUE',
];
/** The test needs updating (UI_CHANGED: the UI changed and the test did not follow). */
export const TEST_MAINTENANCE_CLASSES: readonly FailureClassification[] = [
  'TEST_BUG', 'LOCATOR_CHANGED', 'UI_CHANGED', 'TIMING_OR_STATE_ISSUE',
];

export type FailureCategory = 'product_defect' | 'infrastructure' | 'test_maintenance' | 'preexisting' | 'unknown';

/** Coarse bucket for a failure classification. Unrecognised values map to 'unknown'. */
export function failureCategory(c: FailureClassification | string | null | undefined): FailureCategory {
  if (!c) return 'unknown';
  if (c === 'PREEXISTING_FAILURE') return 'preexisting';
  if ((PRODUCT_DEFECT_CLASSES as readonly string[]).includes(c)) return 'product_defect';
  if ((INFRASTRUCTURE_CLASSES as readonly string[]).includes(c)) return 'infrastructure';
  if ((TEST_MAINTENANCE_CLASSES as readonly string[]).includes(c)) return 'test_maintenance';
  return 'unknown';
}

export function isProductDefect(c: FailureClassification | string | null | undefined): boolean {
  return failureCategory(c) === 'product_defect';
}

export function isInfrastructureFailure(c: FailureClassification | string | null | undefined): boolean {
  return failureCategory(c) === 'infrastructure';
}

export const CoverageSnapshot = z.object({
  featuresDiscovered: z.number().int(),
  featuresTested: z.number().int(),
  businessRulesDiscovered: z.number().int(),
  businessRulesTested: z.number().int(),
  routesDiscovered: z.number().int(),
  routesTested: z.number().int(),
  formsDiscovered: z.number().int(),
  formsTested: z.number().int(),
  apisDiscovered: z.number().int(),
  apisExercised: z.number().int(),
  rolesDiscovered: z.number().int(),
  rolesTested: z.number().int(),
  negativeScenarios: z.number().int(),
  boundaryScenarios: z.number().int(),
  stateTransitionScenarios: z.number().int(),
  gaps: z.array(z.object({
    kind: z.string(),
    subject: z.string(),
    reason: z.string(),
  })).default([]),
});
export type CoverageSnapshot = z.infer<typeof CoverageSnapshot>;
