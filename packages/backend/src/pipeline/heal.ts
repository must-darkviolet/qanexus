/**
 * Healing: a test that preflight rejects, or that breaks by itself when it
 * runs, is corrected and checked again - it is not reported as a test bug
 * while there is still a way to fix it.
 *
 *   blocked by preflight  -> corrected with its diagnostics -> preflight again
 *   broke while running   -> corrected with the error, the page it was on and
 *                            its DOM -> preflight -> run again
 *
 * Only the test is ever changed, and only how it reaches and locates things:
 * the correction is told to keep what the scenario asserts, preflight rejects
 * a test that asserts nothing or the wrong thing, and a failure the diagnosis
 * attributes to the application is never healed - that is a finding.
 *
 * When the generator cannot produce a valid test for a scenario about a
 * condition the pull request added, the test is written from the traced
 * journeys (conditionTests.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { TestResult } from '@qa-agent/shared';
import type { StoredScenario } from '../knowledge/store.js';
import { runTestGenerator, type TestGeneratorInput } from '../agents/testGenerator.js';
import { repairGeneratedOutput } from '../playwright/repairGenerated.js';
import { describeDiagnostic, preflightSpec, readPageObjects, type PageObjectInfo, type PreflightContext, type TestDiagnostic } from '../playwright/preflight.js';
import type { SuiteLayout } from '../playwright/scaffold.js';
import { synthesizeConditionTest, synthesizeErrorTest } from './conditionTests.js';
import { camel, pascal } from '../util/ids.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('HEAL');

export interface HealTarget {
  specFile: string;
  scenarioId: string;
  /** preflight: rejected before running; runtime: broke by itself while running. */
  kind: 'preflight' | 'runtime';
  diagnostic?: TestDiagnostic;
  result?: TestResult;
}

export interface HealOutcome { scenarioId: string; specFile: string; healed: boolean; how: string }

/** A failure in the test itself, not in the application: the test never got to check anything. */
export function brokeByItself(r: TestResult): boolean {
  const msg = r.errorMessage ?? '';
  return /\b(ReferenceError|TypeError|SyntaxError)\b|is not a function|Cannot read propert|is not defined/.test(msg)
    || /strict mode violation/.test(msg)
    || /Flow \w+ did not complete|could not find .+; tried/.test(msg)
    || /Unknown locator/.test(msg)
    || /can be only used with Locator object|Unsupported token|is not a valid selector|Unexpected token/.test(msg)
    // An action that timed out waiting for its element (not an assertion about the page).
    || (/locator\.(click|fill|check|uncheck|press|hover|selectOption|dblclick|setChecked|tap|type)\b/.test(msg) && /Timeout \d+ms exceeded/.test(msg));
}

/** Test-side classes of the failure diagnosis: healed and run again. */
export const HEALABLE_CLASSES = ['TEST_BUG', 'LOCATOR_CHANGED', 'UI_CHANGED'];

/* -------------------------------------------------------------------------- */
/* Editing one test inside a spec                                              */
/* -------------------------------------------------------------------------- */

interface TestRange { id: string | null; start: number; end: number }

function testRanges(source: string): { tests: TestRange[]; describeBodyEnd: number | null } {
  const sf = ts.createSourceFile('spec.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const tests: TestRange[] = [];
  let describeBodyEnd: number | null = null;
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression.getText(sf);
      const title = n.arguments[0] && ts.isStringLiteralLike(n.arguments[0]) ? n.arguments[0].text : null;
      if (/^test(\.only)?$/.test(callee) && title !== null) {
        const stmt = ts.isExpressionStatement(n.parent) ? n.parent : n;
        tests.push({ id: title.match(/^\[([A-Z]{2,}-\d+)\]/)?.[1] ?? null, start: stmt.getStart(sf), end: stmt.getEnd() });
      }
      if (callee === 'test.describe' && describeBodyEnd === null) {
        const fn = n.arguments.find((a): a is ts.ArrowFunction | ts.FunctionExpression => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
        if (fn && ts.isBlock(fn.body)) describeBodyEnd = fn.body.getEnd() - 1; // the closing brace
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { tests, describeBodyEnd };
}

const escapeSingle = (text: string) => text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ');
const indent = (text: string, n: number) => text.split('\n').map((l) => (l.trim() ? ' '.repeat(n) + l : l)).join('\n');

/** One test, written the way codegen writes it: strategy comment, page objects / flows constructed. */
export function renderTest(t: { scenarioId: string; title: string; body: string; strategy?: string; evidenceSource?: string | null; tags?: string[] }, pageObjects: PageObjectInfo[]): { code: string; uses: PageObjectInfo[] } {
  const inst = (po: PageObjectInfo) => camel(pascal(po.className));
  const declared = (name: string) => new RegExp(`\\b(const|let|var)\\s+${name}\\b`).test(t.body);
  const uses = pageObjects
    .filter((po) => new RegExp(`\\b${inst(po)}\\b`).test(t.body))
    .filter((po, i, all) => all.findIndex((x) => inst(x) === inst(po)) === i);
  const setup = uses.filter((po) => !declared(inst(po)))
    .map((po) => `const ${inst(po)} = new ${pascal(po.className)}(page${/Flows$/.test(po.className) ? ', qa' : ''});`);
  const hasStrategy = /\/\/\s*strategy:/.test(t.body);
  const header = [
    ...(t.tags?.length ? [`// tags: ${t.tags.join(', ')}`] : []),
    ...(!hasStrategy && t.strategy ? [`// strategy: ${t.strategy}${t.evidenceSource ? ` · evidence: ${t.evidenceSource}` : ''}`] : []),
  ];
  const body = [...header, ...setup, t.body.trim()].join('\n');
  return {
    code: `  test('[${t.scenarioId}] ${escapeSingle(t.title.replace(/^\[[^\]]+\]\s*/, ''))}', async ({ page, qa }) => {\n${indent(body, 4)}\n  });`,
    uses,
  };
}

/** Replaces the test of `scenarioId` in the spec (or adds it), and imports what it uses. */
export function spliceTest(source: string, scenarioId: string, code: string, uses: PageObjectInfo[], pagesDirName = 'pages'): string {
  let out = source;
  const { tests, describeBodyEnd } = testRanges(out);
  const existing = tests.find((t) => t.id === scenarioId);
  if (existing) {
    const lineStart = out.lastIndexOf('\n', existing.start) + 1;
    out = `${out.slice(0, lineStart)}${code}${out.slice(existing.end)}`;
  } else if (describeBodyEnd !== null) {
    out = `${out.slice(0, describeBodyEnd).replace(/\s*$/, '')}\n\n${code}\n${out.slice(describeBodyEnd)}`;
  } else {
    out = `${out.replace(/\s*$/, '')}\n\n${code.replace(/^ {2}/gm, '')}\n`;
  }
  for (const po of uses) {
    const cls = pascal(po.className);
    if (new RegExp(`import\\s*\\{[^}]*\\b${cls}\\b[^}]*\\}`).test(out)) continue;
    const imports = [...out.matchAll(/^import .*;$/gm)];
    const at = imports.length ? imports[imports.length - 1]!.index! + imports[imports.length - 1]![0].length : 0;
    out = `${out.slice(0, at)}\nimport { ${cls} } from '../${pagesDirName}/${po.fileName.replace(/\.ts$/, '')}';${out.slice(at)}`;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Healing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Refactors a test onto the journey that sends what it expects: its set-up
 * (qa.intercept / qa.observe / qa.stub) and every assertion stay; its own
 * navigation and clicks - the part preflight found incomplete - are replaced by
 * the flow, which performs every step. Used when preflight says a request is
 * only sent after steps the test does not perform, or that it calls the wrong flow.
 */
export function refactorOntoFlow(testCode: string, diagnostic: TestDiagnostic | undefined, triggers: NonNullable<PreflightContext['triggers']>, flowsInstance: string): { body: string; flow: string } | null {
  const problems = diagnostic?.problems.join('\n') ?? '';
  const expects = problems.match(/Expects (\S+), which the application sends only after the user|Expects (\S+), but none of the flows it calls/);
  const path_ = expects?.[1] ?? expects?.[2];
  if (!path_) return null;
  const trig = triggers.find((t) => t.paths.includes(path_));
  if (!trig?.flows.length) return null;
  // The journey: proven first, then the one whose outcome for this request is "sent", then the shortest.
  const flow = [...trig.flows].sort((a, b) => Number((trig as { proven?: Record<string, boolean> }).proven?.[b] === true) - Number((trig as { proven?: Record<string, boolean> }).proven?.[a] === true)
    || Number(trig.expected?.[b]?.sent !== false) - Number(trig.expected?.[a]?.sent !== false) || a.length - b.length)[0]!;
  const open = testCode.indexOf('{', testCode.indexOf('=>'));
  const close = testCode.lastIndexOf('}');
  if (open < 0 || close <= open) return null;
  const statements = testCode.slice(open + 1, close).split('\n').map((l) => l.trim()).filter(Boolean);
  const keep = (l: string) => /^\/\//.test(l) || /\bqa\.(intercept|observe|stub)\s*\(/.test(l)
    || /^(await\s+)?expect(\.poll)?\s*\(/.test(l) || /\bqa\.expect\w*\s*\(|\bqa\.waitFor\w*\s*\(/.test(l)
    || /^(const|let)\s+\w+\s*=\s*new\s+\w+Flows\(/.test(l);
  const setup = statements.filter((l) => keep(l) && !/expect/.test(l));
  const asserts = statements.filter((l) => keep(l) && /expect|waitFor/.test(l) && !/^(const|let)/.test(l));
  if (!asserts.length) return null;
  const body = [...setup.filter((l) => !/new\s+\w+Flows\(/.test(l)), `await ${flowsInstance}.${flow}();`, ...asserts].join('\n');
  return { body, flow };
}

function testSource(source: string, scenarioId: string): string {
  const r = testRanges(source).tests.find((t) => t.id === scenarioId);
  return r ? source.slice(r.start, r.end) : '(not found in the spec)';
}

function feedbackFor(t: HealTarget, source: string): string {
  const current = testSource(source, t.scenarioId);
  if (t.kind === 'preflight' && t.diagnostic) {
    return `${describeDiagnostic(t.diagnostic)}\nThe test as it is now:\n${current}`;
  }
  const r = t.result!;
  return [
    `Scenario: ${t.scenarioId}`,
    'Problem: the test RAN and broke by itself before it could verify anything (the failure is in the test, not in the application):',
    (r.errorMessage ?? '').split('\n').slice(0, 14).join('\n').slice(0, 1600),
    r.pageUrl ? `It was on: ${r.pageUrl}` : '',
    r.domSnapshot ? `The page when it broke (DOM, truncated) - choose locators that exist here:\n${r.domSnapshot.slice(0, 4000)}` : '',
    `The test as it is now:\n${current}`,
    'Fix how the test reaches and locates things (prefer calling a FLOWS journey). Keep what it asserts about the scenario\'s expected result - do not weaken, remove or invert that assertion.',
  ].filter(Boolean).join('\n');
}

export interface HealContext {
  layout: SuiteLayout;
  /** The generator input for the feature a spec belongs to (analysis, feature, evidence, flows). */
  inputFor(specFile: string): Omit<TestGeneratorInput, 'scenarios' | 'feedback'> | null;
  scenario(id: string): StoredScenario | undefined;
  preflight: PreflightContext;
  /** The flows class instance for the feature a spec belongs to. */
  flowsInstanceFor(specFile: string): string | undefined;
}

/**
 * Corrects the targets, spec by spec, writes the corrected tests into their
 * spec, and preflights them. A target is healed when its test now passes
 * preflight (a runtime target still has to pass when it is run again).
 */
export async function healTests(ctx: HealContext, targets: HealTarget[]): Promise<HealOutcome[]> {
  const outcomes: HealOutcome[] = [];
  const bySpec = new Map<string, HealTarget[]>();
  for (const t of targets) bySpec.set(t.specFile, [...(bySpec.get(t.specFile) ?? []), t]);

  for (const [specFile, list] of bySpec) {
    const file = path.join(ctx.layout.root, specFile);
    let source = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const input = ctx.inputFor(specFile);
    const scenarios = list.map((t) => ctx.scenario(t.scenarioId)).filter((s): s is StoredScenario => Boolean(s));
    const pageObjects = () => readPageObjects(ctx.layout.pagesDir);
    const executable = (id: string) => preflightSpec(specFile, source, { ...ctx.preflight, pageObjects: pageObjects() }).tests
      .find((t) => t.scenarioId === id)?.executable ?? false;

    // 1. The generator, told exactly what went wrong.
    if (input && scenarios.length) {
      try {
        const res = await runTestGenerator({
          ...input, scenarios,
          feedback: [
            'These tests need to be corrected. They are NOT allowed to stay broken: return a corrected test for every scenario listed.',
            ...list.map((t) => feedbackFor(t, source)),
          ].join('\n\n---\n\n'),
        });
        if (res.source !== 'fallback') {
          const { output } = repairGeneratedOutput(res.data, { existingPageObjects: pageObjects().map((p) => ({ className: p.className, fileName: p.fileName })), route: null });
          for (const t of list) {
            const fixed = output.specs.flatMap((s) => s.tests).find((x) => x.scenarioId === t.scenarioId);
            if (!fixed) continue;
            const before = source;
            const rendered = renderTest(fixed, pageObjects());
            source = spliceTest(source, t.scenarioId, rendered.code, rendered.uses);
            if (executable(t.scenarioId)) outcomes.push({ scenarioId: t.scenarioId, specFile, healed: true, how: 'corrected by the generator' });
            else source = before; // keep the previous version: the correction is no better
          }
        }
      } catch (e) {
        log.warn(`${specFile}: correction failed: ${(e as Error).message}`);
      }
    }

    // 1b. Mechanical corrections preflight names exactly: a journey that failed its live proof swapped for the
    //     proven one it names, qa.stub (inactive against the real backend) for qa.intercept.
    for (const t of list) {
      if (outcomes.some((o) => o.scenarioId === t.scenarioId)) continue;
      const problems = t.diagnostic?.problems.join('\n') ?? '';
      const current = testSource(source, t.scenarioId);
      if (current.startsWith('(not found')) continue;
      let fixed = current;
      for (const m of problems.matchAll(/Calls (\w+), which failed its live proof[^\n]*? - use (\w+),/g)) fixed = fixed.replace(new RegExp(`\\.${m[1]}\\(`, 'g'), `.${m[2]}(`);
      if (/Relies on qa\.stub/.test(problems)) fixed = fixed.replace(/\bqa\.stub\(/g, 'qa.intercept(').replace(/^[ \t]*test\.skip\(\s*!\s*qa\.mockApi[^\n]*\n?/gm, '');
      if (fixed === current) continue;
      const before = source;
      source = source.replace(current, fixed);
      if (executable(t.scenarioId)) outcomes.push({ scenarioId: t.scenarioId, specFile, healed: true, how: 'corrected mechanically as preflight described' });
      else source = before;
    }

    // 2. A test missing a journey's steps: refactored onto the journey, its set-up and assertions kept.
    const flows = ctx.flowsInstanceFor(specFile);
    for (const t of list) {
      if (outcomes.some((o) => o.scenarioId === t.scenarioId) || !flows) continue;
      const current = testSource(source, t.scenarioId);
      const available = pageObjects().find((po) => camel(pascal(po.className)) === flows)?.methods ?? [];
      const refactored = refactorOntoFlow(current, t.diagnostic, (ctx.preflight.triggers ?? []).map((tr) => ({ ...tr, flows: tr.flows.filter((f) => available.includes(f)) })), flows);
      const sc = ctx.scenario(t.scenarioId);
      if (!refactored || !sc) continue;
      const before = source;
      const strategy = current.match(/\/\/\s*strategy:[^\n]*/)?.[0];
      const rendered = renderTest({ scenarioId: sc.id, title: sc.title, body: `${strategy ? '' : '// strategy: UI_AND_NETWORK\n'}${refactored.body}` }, pageObjects());
      source = spliceTest(source, sc.id, rendered.code, rendered.uses);
      if (executable(sc.id)) outcomes.push({ scenarioId: sc.id, specFile, healed: true, how: `refactored onto the journey ${refactored.flow}` });
      else source = before;
    }

    // 3. A scenario about a condition the change added: written from the traced journeys.
    for (const t of list) {
      if (outcomes.some((o) => o.scenarioId === t.scenarioId)) continue;
      const sc = ctx.scenario(t.scenarioId);
      const claim = sc ? `${sc.title} — ${sc.expectedResult}` : '';
      // The journeys this spec's flows class has.
      const available = pageObjects().find((po) => camel(pascal(po.className)) === flows)?.methods;
      const made = sc && flows ? synthesizeConditionTest(claim, (ctx.preflight.triggers ?? []) as never, flows, available)
        ?? synthesizeErrorTest(claim, (ctx.preflight.triggers ?? []) as never, flows, available) : null;
      if (made && sc) {
        const before = source;
        const rendered = renderTest({ scenarioId: sc.id, title: sc.title, body: made.body, tags: ['synthesized', 'pr-condition'] }, pageObjects());
        source = spliceTest(source, sc.id, rendered.code, rendered.uses);
        if (executable(sc.id)) { outcomes.push({ scenarioId: sc.id, specFile, healed: true, how: `written from the traced journey ${made.flow}` }); continue; }
        source = before;
      }
      outcomes.push({ scenarioId: t.scenarioId, specFile, healed: false, how: 'no correction passed preflight' });
    }
    fs.writeFileSync(file, source, 'utf8');
  }
  for (const o of outcomes) log.info(`${o.scenarioId}: ${o.healed ? 'healed' : 'not healed'} (${o.how}).`);
  return outcomes;
}
