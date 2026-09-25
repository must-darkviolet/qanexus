/**
 * RegressionSelector (spec section 9).
 *
 * "Do NOT rerun every test blindly when unnecessary."
 *
 * The traceability graph does the selecting; the agent's job is to catch
 * indirect impact the graph misses (a shared utility, a changed base layout)
 * and to say when a full regression is genuinely warranted.
 */
import { RegressionSelectorOutput, type RepositoryDiff } from '@qa-agent/shared';
import { runAgent, SAFETY_PREAMBLE, bulletList, type AgentResult } from './base.js';
import type { TraceLink } from '../knowledge/store.js';

const SYSTEM = `${SAFETY_PREAMBLE}

You are the RegressionSelector.

You are given a diff, the set of available spec files, and a deterministic
pre-selection computed from a traceability graph. Decide the final set of specs
to run.

Add a spec when the change could plausibly affect it indirectly - a shared
component, a layout, an auth helper, a shared API client, a global style that
affects a selector. Explain each addition.

Recommend a full regression only when the change is broad: a dependency
upgrade, a routing or auth refactor, a build configuration change, or a change
to a file that most specs depend on. Otherwise keep the run targeted and say
why the skipped specs are safe to skip.

Only reference spec files from the list you are given.

Return JSON matching the requested schema.`;

export interface RegressionSelectorInput {
  projectId: string;
  runId: string;
  diff: RepositoryDiff;
  availableSpecs: string[];
  preselected: { specFile: string; reason: string }[];
  traces: TraceLink[];
}

export async function runRegressionSelector(
  input: RegressionSelectorInput,
): Promise<AgentResult<RegressionSelectorOutput>> {
  const user = `CHANGED FILES:
${bulletList(input.diff.files.map((f) => `${f.status}: ${f.path}`), 60)}

CHANGED FUNCTIONS/COMPONENTS:
${bulletList(input.diff.changedFunctions.map((f) => `${f.change}: ${f.name} (${f.file})`), 50)}

AVAILABLE SPEC FILES:
${bulletList(input.availableSpecs, 60)}

DETERMINISTIC PRE-SELECTION (already justified by direct traceability):
${bulletList(input.preselected.map((p) => `${p.specFile} - ${p.reason}`), 60)}

Decide the final regression set.`;

  return runAgent({
    agent: 'RegressionSelector',
    projectId: input.projectId,
    runId: input.runId,
    system: SYSTEM,
    user,
    schema: RegressionSelectorOutput,
    temperature: 0.1,
    fallback: () => ({
      selectedSpecs: input.preselected.map((p) => ({ ...p, confidence: 0.8 })),
      skippedSpecs: input.availableSpecs
        .filter((s) => !input.preselected.some((p) => p.specFile === s))
        .map((specFile) => ({ specFile, reason: 'No changed file is traced to this spec.' })),
      recommendFullRegression: shouldForceFullRegression(input.diff),
      rationale: 'Selected directly from the traceability graph; no AI inference was applied.',
    }),
  });
}

/** Broad changes that make targeted selection untrustworthy. */
export function shouldForceFullRegression(diff: RepositoryDiff): boolean {
  return diff.files.some((f) =>
    /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(f.path) ||
    /(^|\/)(next|vite|webpack|tailwind|tsconfig|babel)\.config\.[jt]s(on)?$/.test(f.path) ||
    /(^|\/)(src\/)?(app|pages)\/(layout|_app|_document)\.[jt]sx?$/.test(f.path) ||
    /(middleware|auth|session|router|routes)\.[jt]sx?$/.test(f.path),
  );
}

/**
 * The deterministic selection: every spec traced to a changed file, plus
 * anything importing a changed file.
 */
export function preselectSpecs(
  diff: RepositoryDiff,
  traces: TraceLink[],
  availableSpecs: string[],
): { specFile: string; reason: string }[] {
  // Renames touch two paths; traceability recorded the pre-rename one.
  const changed = new Set(
    diff.files.flatMap((f) => (f.previousPath ? [f.path, f.previousPath] : [f.path])),
  );
  const selected = new Map<string, string>();

  for (const trace of traces) {
    if (!trace.specFile || !changed.has(trace.sourceFile)) continue;
    const reason = `Traced to changed file ${trace.sourceFile}` +
      (trace.scenarioKey ? ` via scenario ${trace.scenarioKey}` : '') +
      (trace.businessRuleKey ? ` (rule ${trace.businessRuleKey})` : '');
    if (!selected.has(trace.specFile)) selected.set(trace.specFile, reason);
  }

  // A changed spec always runs.
  for (const spec of availableSpecs) {
    if (changed.has(spec)) selected.set(spec, 'This spec file itself changed.');
  }

  return [...selected.entries()].map(([specFile, reason]) => ({ specFile, reason }));
}
