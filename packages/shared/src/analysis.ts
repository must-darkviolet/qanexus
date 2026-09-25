/**
 * Output of the deterministic (non-AI) analysis layer, spec sections 3, 4 and 8.
 *
 * Nothing in here is produced by a model: it is all extracted with the
 * TypeScript compiler API and git. The AI agents consume it as context.
 */
import { z } from 'zod';
import {
  ApiEndpoint, ComponentInfo, EntityInfo, PermissionCheck, RoleInfo,
  Route, StateMachine, ValidationRule,
} from './knowledge.js';

export const DetectedFramework = z.enum([
  'next', 'react', 'remix', 'vite_react', 'cra', 'unknown',
]);
export type DetectedFramework = z.infer<typeof DetectedFramework>;

export const RepoFile = z.object({
  path: z.string(),
  size: z.number().int(),
  /** sha256 of contents - drives the "do not reanalyze unchanged files" rule. */
  hash: z.string(),
  language: z.enum(['ts', 'tsx', 'js', 'jsx', 'json', 'md', 'css', 'other']),
});
export type RepoFile = z.infer<typeof RepoFile>;

export const ExistingTestInfo = z.object({
  file: z.string(),
  kind: z.enum(['spec', 'page_object', 'support', 'fixture', 'command', 'config']),
  titles: z.array(z.string()).default([]),
  selectorsUsed: z.array(z.string()).default([]),
  pageObjects: z.array(z.string()).default([]),
  commands: z.array(z.string()).default([]),
  visits: z.array(z.string()).default([]),
});
export type ExistingTestInfo = z.infer<typeof ExistingTestInfo>;

export const StaticAnalysis = z.object({
  framework: DetectedFramework,
  usesTypeScript: z.boolean(),
  packageName: z.string().optional(),
  scripts: z.record(z.string()).default({}),
  dependencies: z.record(z.string()).default({}),
  readme: z.string().optional(),
  docs: z.array(z.object({ file: z.string(), excerpt: z.string() })).default([]),
  files: z.array(RepoFile).default([]),
  routes: z.array(Route).default([]),
  components: z.array(ComponentInfo).default([]),
  apis: z.array(ApiEndpoint).default([]),
  validations: z.array(ValidationRule).default([]),
  roles: z.array(RoleInfo).default([]),
  permissionChecks: z.array(PermissionCheck).default([]),
  stateMachines: z.array(StateMachine).default([]),
  entities: z.array(EntityInfo).default([]),
  constants: z.array(z.object({ name: z.string(), value: z.string(), file: z.string() })).default([]),
  featureFlags: z.array(z.object({ name: z.string(), file: z.string() })).default([]),
  statusValues: z.array(z.object({ name: z.string(), values: z.array(z.string()), file: z.string() })).default([]),
  errorHandling: z.array(z.object({ file: z.string(), detail: z.string() })).default([]),
  envVarNames: z.array(z.string()).default([]),
  authSignals: z.array(z.object({ file: z.string(), detail: z.string() })).default([]),
  existingTests: z.array(ExistingTestInfo).default([]),
  /** Files skipped because they look like they hold secrets (spec section 27). */
  excludedForSecrets: z.array(z.string()).default([]),
});
export type StaticAnalysis = z.infer<typeof StaticAnalysis>;

export const ChangedFile = z.object({
  path: z.string(),
  previousPath: z.string().optional(),
  status: z.enum(['added', 'modified', 'deleted', 'renamed']),
  additions: z.number().int().default(0),
  deletions: z.number().int().default(0),
  patch: z.string().optional(),
});
export type ChangedFile = z.infer<typeof ChangedFile>;

/** Spec section 8: what actually changed, computed from git diff + AST. */
export const RepositoryDiff = z.object({
  previousCommitSha: z.string().nullable(),
  currentCommitSha: z.string(),
  isFirstAnalysis: z.boolean(),
  files: z.array(ChangedFile).default([]),
  changedFunctions: z.array(z.object({ file: z.string(), name: z.string(), change: z.enum(['added', 'removed', 'modified']) })).default([]),
  changedComponents: z.array(z.string()).default([]),
  changedRoutes: z.array(z.object({ path: z.string(), change: z.enum(['added', 'removed', 'modified']) })).default([]),
  changedApis: z.array(z.object({ method: z.string(), path: z.string(), change: z.enum(['added', 'removed', 'modified']) })).default([]),
  changedValidations: z.array(z.object({ field: z.string(), file: z.string(), change: z.enum(['added', 'removed', 'modified']) })).default([]),
  changedBusinessLogicFiles: z.array(z.string()).default([]),
  commits: z.array(z.object({ sha: z.string(), message: z.string(), author: z.string(), date: z.string() })).default([]),
});
export type RepositoryDiff = z.infer<typeof RepositoryDiff>;
