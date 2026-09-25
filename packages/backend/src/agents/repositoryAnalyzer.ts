/**
 * RepositoryAnalyzer: "what is this application, and what features does it have?"
 *
 * Input:  deterministic static analysis + prior application memory
 * Output: application identity + a named feature list, validated
 * Fallback: directory/route-derived feature grouping (no AI required)
 */
import { RepositoryAnalyzerOutput, type FeatureInfo, type StaticAnalysis } from '@qa-agent/shared';
import { runAgent, SAFETY_PREAMBLE, type AgentResult } from './base.js';
import { renderRepositoryOverview } from './context.js';
import { deriveCandidateFeatures } from '../analysis/staticAnalyzer.js';
import type { ApplicationRecord } from '../knowledge/store.js';
import { slug } from '../util/ids.js';

const SYSTEM = `${SAFETY_PREAMBLE}

You are the RepositoryAnalyzer.

Your job is to read a structured summary of a frontend repository - routes,
components, API calls, types, roles, constants, existing tests - and answer:
  1. What is this application?
  2. What are its distinct user-facing features?

Guidance:
- A feature is something a user would recognise ("User Management", "Checkout",
  "Reporting"), not a technical layer ("hooks", "utils", "components").
- Group by what the code does, not by folder name. Folder structure varies and
  must not be assumed.
- Every feature must list the actual routes, components, files and APIs that
  belong to it, taken verbatim from the evidence. Do not invent paths.
- evidenceLevel is "observed" when routes/components make the feature obvious,
  "inferred" when you are reading intent from naming, "unknown" when unsure.
- Put anything you could not determine into openQuestions rather than guessing.

Return JSON matching the requested schema.`;

export interface RepositoryAnalyzerInput {
  projectId: string;
  runId: string;
  analysis: StaticAnalysis;
  previousApplication: ApplicationRecord | null;
  repoName: string;
}

export async function runRepositoryAnalyzer(
  input: RepositoryAnalyzerInput,
): Promise<AgentResult<RepositoryAnalyzerOutput>> {
  const candidates = deriveCandidateFeatures(input.analysis);

  const priorBlock = input.previousApplication
    ? `PREVIOUS UNDERSTANDING OF THIS APPLICATION (from an earlier run - refine it, do not discard it):
Name: ${input.previousApplication.name}
Purpose: ${input.previousApplication.purpose}
Domain: ${input.previousApplication.domain}
Open questions carried forward: ${input.previousApplication.openQuestions.join('; ') || 'none'}`
    : 'This repository has not been analysed before.';

  const candidateBlock = `DETERMINISTIC FEATURE GROUPING (computed from routes and directories - use it as a starting point, rename and merge as appropriate):
${candidates.slice(0, 30).map((c) =>
  `  - ${c.key}: routes=[${c.routes.slice(0, 6).join(', ')}] components=[${c.components.slice(0, 8).join(', ')}] files=${c.files.length}`,
).join('\n') || '  (none)'}`;

  const user = `REPOSITORY: ${input.repoName}

${priorBlock}

${candidateBlock}

STRUCTURED REPOSITORY ANALYSIS:
${renderRepositoryOverview(input.analysis)}`;

  return runAgent({
    agent: 'RepositoryAnalyzer',
    projectId: input.projectId,
    runId: input.runId,
    system: SYSTEM,
    user,
    schema: RepositoryAnalyzerOutput,
    temperature: 0.1,
    fallback: () => buildFallback(input, candidates),
  });
}

/**
 * Deterministic feature map. This is genuinely useful output, not a stub:
 * with no AI key at all the dashboard still shows a real feature list derived
 * from routes, components and API calls.
 */
function buildFallback(
  input: RepositoryAnalyzerInput,
  candidates: ReturnType<typeof deriveCandidateFeatures>,
): RepositoryAnalyzerOutput {
  return {
    applicationName: input.analysis.packageName ?? input.repoName,
    applicationPurpose:
      'Not determined without AI analysis. Features below were grouped deterministically from routes, components and API calls.',
    domain: 'unknown',
    architectureNotes: [
      `Framework detected: ${input.analysis.framework}`,
      `${input.analysis.routes.length} routes, ${input.analysis.components.length} components, ${input.analysis.apis.length} API calls.`,
      input.analysis.usesTypeScript ? 'TypeScript project.' : 'JavaScript project.',
    ],
    features: candidates.slice(0, 40).map((c) => ({
      key: slug(c.key),
      name: c.name,
      description: `Grouped from ${c.files.length} file(s) under "${c.key}".`,
      routes: c.routes,
      components: c.components,
      files: c.files,
      apis: c.apis,
      entities: [],
      evidenceLevel: 'inferred' as const,
    })),
    openQuestions: ['Application purpose and domain were not determined because AI analysis was unavailable.'],
  };
}

/** Converts agent output into the persisted feature shape. */
export function toFeatureInfos(output: RepositoryAnalyzerOutput): FeatureInfo[] {
  return output.features.map((f) => ({
    key: slug(f.key || f.name),
    name: f.name,
    description: f.description,
    routes: f.routes,
    components: f.components,
    files: f.files,
    apis: f.apis,
    entities: f.entities,
    evidenceLevel: f.evidenceLevel,
  }));
}
