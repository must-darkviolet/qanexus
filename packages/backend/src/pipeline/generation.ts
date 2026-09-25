/**
 * Test generation with a preflight gate.
 *
 *   generate (AI) -> safe repair -> write -> preflight
 *     -> if tests were rejected: one corrected attempt, told exactly why
 *     -> safe repair -> write -> preflight again
 *
 * What still fails preflight stays in the file, but is UNEXECUTABLE_TEST: the
 * execution step only launches tests that passed (see pipeline/orchestrator.ts),
 * and the report lists the rest with their diagnostics.
 */
import fs from 'node:fs';
import type { TestGeneratorOutput } from '@qa-agent/shared';
import { runTestGenerator, type TestGeneratorInput } from '../agents/testGenerator.js';
import type { AgentResult } from '../agents/base.js';
import { writeGeneratedSuite, type WriteSuiteResult } from '../playwright/codegen.js';
import { repairGeneratedOutput } from '../playwright/repairGenerated.js';
import path from 'node:path';
import { describeDiagnostic, notImplemented, preflightSpec, readCustomFixtures, readPageObjects, type PreflightContext, type SpecPreflight, type TestDiagnostic } from '../playwright/preflight.js';
import { QA_HELPERS, type SuiteLayout } from '../playwright/scaffold.js';
import { createLogger } from '../util/logger.js';
import { env } from '../config/env.js';
import { synthesizeConditionTest, synthesizeErrorTest } from './conditionTests.js';

const log = createLogger('PREFLIGHT');

export interface ValidatedGeneration {
  result: AgentResult<TestGeneratorOutput>;
  write: WriteSuiteResult;
  repairs: string[];
  preflight: SpecPreflight[];
  /** A corrected attempt was requested because the first failed preflight. */
  regenerated: boolean;
  /** Scenarios the generator did not implement at all, with its stated reason. */
  missing: TestDiagnostic[];
  /** Condition -> action -> effect, as the generator derived it. */
  behaviorMap: TestGeneratorOutput['behaviorMap'];
}

export function preflightContext(layout: SuiteLayout, scenarios: PreflightContext['scenarios'], changedTerms: string[], apiPaths: string[] = [], triggers: PreflightContext['triggers'] = [], sharedIds: string[] = []): PreflightContext {
  return {
    triggers, sharedIds,
    suiteRoot: layout.root, pageObjects: readPageObjects(layout.pagesDir), qaHelpers: QA_HELPERS, scenarios, changedTerms,
    customFixtures: readCustomFixtures(path.join(layout.supportDir, 'qa.ts')),
    mockApi: env.TEST_MOCK_API,
    apiPaths,
  };
}

/**
 * What may be launched: only tests that passed every mandatory preflight gate,
 * selected by their scenario id. An empty plan means no browser starts.
 */
export function executionPlan(preflight: SpecPreflight[]): { runnable: TestDiagnostic[]; blocked: TestDiagnostic[]; specs: string[]; grep: string | null } {
  // Tests are selected by scenario id; an id that is blocked anywhere is never run, so a
  // blocked copy of it in another spec cannot slip through on the valid one's name.
  const blockedIds = new Set(preflight.flatMap((p) => p.tests.filter((t) => !t.executable).map((t) => t.scenarioId)).filter(Boolean));
  const runnable = preflight.flatMap((p) => p.tests.filter((t) => t.executable && t.scenarioId && !blockedIds.has(t.scenarioId)));
  const blocked = preflight.flatMap((p) => p.tests.filter((t) => !t.executable || !t.scenarioId || blockedIds.has(t.scenarioId)));
  const ids = [...new Set(runnable.map((t) => t.scenarioId!))];
  return {
    runnable, blocked,
    specs: [...new Set(runnable.map((t) => t.specFile))],
    grep: ids.length ? `\\[(${ids.join('|')})\\]` : null,
  };
}

export function preflightWritten(write: WriteSuiteResult, ctx: PreflightContext): SpecPreflight[] {
  return write.files
    .filter((f) => f.kind === 'spec' && fs.existsSync(f.absPath))
    .map((f) => preflightSpec(f.relPath, fs.readFileSync(f.absPath, 'utf8'), ctx));
}

/**
 * Replaces the retried scenarios' tests with the corrected ones. Page objects are
 * merged by class, keeping the first attempt's locators and methods that the
 * corrected one does not redefine: the tests that already passed still use them.
 */
export function merge(first: TestGeneratorOutput, second: TestGeneratorOutput): TestGeneratorOutput {
  const corrected = new Map(second.specs.flatMap((s) => s.tests.map((t) => [t.scenarioId, t] as const)));
  const union = <T extends { name: string }>(a: T[], b: T[]) => [...a.filter((x) => !b.some((y) => y.name === x.name)), ...b];
  const pageObjects = [
    ...first.pageObjects.filter((po) => !second.pageObjects.some((p) => p.className === po.className)),
    ...second.pageObjects.map((po) => {
      const earlier = first.pageObjects.find((p) => p.className === po.className);
      return earlier ? { ...po, locators: union(earlier.locators, po.locators), methods: union(earlier.methods, po.methods) } : po;
    }),
  ];
  const specs = first.specs.map((spec) => ({ ...spec, tests: spec.tests.map((t) => corrected.get(t.scenarioId) ?? t) }));
  const present = new Set(specs.flatMap((s) => s.tests.map((t) => t.scenarioId)));
  const added = [...corrected.values()].filter((t) => !present.has(t.scenarioId));
  if (added.length && specs[0]) specs[0] = { ...specs[0], tests: [...specs[0].tests, ...added] };
  return { ...first, pageObjects, specs, fixtures: [...first.fixtures, ...second.fixtures], notes: [...first.notes, ...second.notes] };
}

/** Corrected attempts after the first generation, when preflight rejects tests. */
const MAX_CORRECTIONS = 2;

export async function generateValidatedTests(opts: {
  input: TestGeneratorInput;
  layout: SuiteLayout;
  featureKey: string;
  /** The module's page route, for the one safe navigation repair. */
  route: string | null;
  scenarios: PreflightContext['scenarios'];
  changedTerms: string[];
  /** Endpoints that exist (source + running app): network patterns are checked against them. */
  apiPaths?: string[];
  /** Endpoints only a user action sends, with the steps (analysis/interactionRecipes.ts). */
  triggers?: PreflightContext['triggers'];
  /** The feature's flows class instance name (pages/*.flows.ts), when it has journeys. */
  flowsInstance?: string;
  /** Ids the source gives to several elements. */
  sharedIds?: string[];
}): Promise<ValidatedGeneration> {
  const apiPaths = opts.apiPaths ?? [];
  const { layout } = opts;
  const existing = () => readPageObjects(layout.pagesDir).map((p) => ({ className: p.className, fileName: p.fileName }));

  const result = await runTestGenerator(opts.input);
  let { output, repairs } = repairGeneratedOutput(result.data, { existingPageObjects: existing(), route: opts.route });
  for (const r of repairs) log.info(`Repaired ${r}`);
  let write = writeGeneratedSuite(layout, opts.featureKey, output, existing());
  let preflight = preflightWritten(write, preflightContext(layout, opts.scenarios, opts.changedTerms, apiPaths, opts.triggers, opts.sharedIds));

  const implemented = () => new Set(output.specs.flatMap((s) => s.tests.map((t) => t.scenarioId)));
  // "No selector" is not a reason to give up on a scenario a network strategy can prove.
  const networkStrategy = (id: string) => ['NETWORK', 'UI_AND_NETWORK', 'API_MOCK'].includes(opts.input.strategies?.[id]?.strategy ?? '');
  const selectorExcuse = (id: string) => {
    const u = output.unimplemented.find((x) => x.scenarioId === id);
    const text = [u?.reason ?? '', ...(u?.strategiesAttempted ?? []).map((a) => a.whyNot), ...output.notes.filter((n) => n.startsWith(`${id}:`))].join(' ');
    return /selector|locator|element|button id|not exposed|not visible|no .*evidence/i.test(text);
  };
  const unimplemented = () => opts.input.scenarios.filter((s) => !implemented().has(s.id));
  let regenerated = false;
  // Up to MAX_CORRECTIONS corrected attempts, each told exactly what the last one got wrong.
  for (let attempt = 1; attempt <= MAX_CORRECTIONS && result.source !== 'fallback'; attempt++) {
    const failing = preflight.flatMap((p) => p.tests.filter((t) => !t.executable));
    if (!failing.length && !unimplemented().length) break;
    regenerated = true;
    log.warn(`${opts.featureKey}: ${failing.length} test(s) failed preflight, ${unimplemented().length} not implemented; corrected attempt ${attempt} of ${MAX_CORRECTIONS}.`);
    const ids = new Set([...failing.map((t) => t.scenarioId).filter(Boolean), ...unimplemented().map((s) => s.id)]);
    const retry = await runTestGenerator({
      ...opts.input,
      scenarios: opts.input.scenarios.filter((s) => ids.has(s.id)),
      feedback: [
        ...failing.map(describeDiagnostic),
        ...unimplemented().map((s) => `Scenario: ${s.id}\nTitle: ${s.title}\nProblem: you did not implement it.${networkStrategy(s.id) && selectorExcuse(s.id)
          ? ` Its strategy is ${opts.input.strategies![s.id]!.strategy}: it needs no selector. Observe or intercept the endpoints listed under API CALLS (qa.observe / qa.intercept) and assert the requests.`
          : ''} Implement it, or list it under "unimplemented" with every strategy you tried and why it cannot work.`),
      ].join('\n\n'),
    });
    if (retry.source === 'fallback') break;
    {
      result.data.notes.push(...retry.data.notes);
      output = { ...output, unimplemented: [...output.unimplemented.filter((u) => !retry.data.unimplemented.some((r) => r.scenarioId === u.scenarioId)), ...retry.data.unimplemented], behaviorMap: [...output.behaviorMap, ...retry.data.behaviorMap] };
      const fixed = repairGeneratedOutput(merge(output, retry.data), { existingPageObjects: existing(), route: opts.route });
      output = fixed.output;
      repairs = [...repairs, ...fixed.repairs];
      write = writeGeneratedSuite(layout, opts.featureKey, output, existing());
      preflight = preflightWritten(write, preflightContext(layout, opts.scenarios, opts.changedTerms, apiPaths, opts.triggers, opts.sharedIds));
    }
  }
  // A scenario about a condition the change put in the code that is still not covered by a valid
  // test: written from the journeys, which say where the code sends the guarded request and where not.
  if (opts.flowsInstance && opts.triggers?.length && output.specs.length) {
    const stillBlocked = new Set(preflight.flatMap((p) => p.tests.filter((t) => !t.executable).map((t) => t.scenarioId)).filter(Boolean));
    const written: string[] = [];
    for (const sc of opts.input.scenarios) {
      if (!stillBlocked.has(sc.id) && implemented().has(sc.id)) continue;
      const claim = `${sc.title} — ${sc.expectedResult}`;
      const made = synthesizeConditionTest(claim, opts.triggers as never, opts.flowsInstance)
        ?? synthesizeErrorTest(claim, opts.triggers as never, opts.flowsInstance);
      if (!made) continue;
      const test = { scenarioId: sc.id, title: sc.title, body: made.body, tags: ['synthesized', 'pr-condition'], strategy: 'UI_AND_NETWORK' as const, evidenceSource: 'UI_ACTION + NETWORK' };
      const at = output.specs.findIndex((sp) => sp.tests.some((t) => t.scenarioId === sc.id));
      const specs = output.specs.map((sp, i) => (i === (at >= 0 ? at : 0)
        ? { ...sp, tests: at >= 0 ? sp.tests.map((t) => (t.scenarioId === sc.id ? { ...t, ...test } : t)) : [...sp.tests, test] }
        : sp));
      output = { ...output, specs, unimplemented: output.unimplemented.filter((u) => u.scenarioId !== sc.id) };
      written.push(`${sc.id} (${made.flow}: ${made.paths.join(', ')} ${made.sent ? 'requested' : 'NOT requested'})`);
    }
    if (written.length) {
      log.info(`${opts.featureKey}: wrote ${written.length} condition test(s) from the traced journeys: ${written.join('; ')}.`);
      repairs.push(...written.map((w) => `${w}: written from the traced journeys after the generator's attempts failed preflight.`));
      write = writeGeneratedSuite(layout, opts.featureKey, output, existing());
      preflight = preflightWritten(write, preflightContext(layout, opts.scenarios, opts.changedTerms, apiPaths, opts.triggers, opts.sharedIds));
    }
  }
  const notes = [...result.data.notes];
  const specFile = preflight[0]?.specFile ?? `tests/${opts.featureKey}.spec.ts`;
  const missing = unimplemented().map((s) => {
    const structured = output.unimplemented.find((u) => u.scenarioId === s.id);
    const note = notes.find((n) => n.startsWith(`${s.id}:`))?.slice(s.id.length + 1).trim();
    const reason = structured?.reason || note
      || `the generator returned neither a test nor a reason for it${regenerated ? `, after ${MAX_CORRECTIONS} corrected attempts` : ''}`;
    return notImplemented(specFile, s.id, s.title, reason, {
      strategy: opts.input.strategies?.[s.id]?.strategy,
      strategiesAttempted: structured?.strategiesAttempted ?? [],
    });
  });
  for (const m of missing) log.warn(`UNEXECUTABLE_TEST ${m.scenarioId}: ${m.problems[0]}`);
  const still = preflight.flatMap((p) => p.tests.filter((t) => !t.executable));
  for (const t of still) log.warn(`UNEXECUTABLE_TEST ${t.scenarioId ?? t.title}: ${t.problems[0] ?? 'failed preflight'}`);
  log.info(`${opts.featureKey}: ${preflight.reduce((n, p) => n + p.tests.filter((t) => t.executable).length, 0)} test(s) passed preflight, ${still.length} unexecutable.`);
  for (const b of output.behaviorMap) log.info(`Behaviour: ${b.condition} -> ${b.action} -> ${b.effect}`);
  return { result, write, repairs, preflight, regenerated, missing, behaviorMap: output.behaviorMap };
}
