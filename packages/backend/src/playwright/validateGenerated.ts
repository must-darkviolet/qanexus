/**
 * Validation of AI-generated Playwright code, before anything is written.
 *
 * The TestGenerator's prompt forbids hard waits, forced clicks and invented
 * selectors, but a prompt is a request, not a guarantee. This checks the
 * structured output deterministically and removes what breaks the rules:
 *
 *   - bodies that are not syntactically valid TypeScript
 *   - waitForTimeout(<number>) hard waits
 *   - { force: true }
 *   - un-awaited Playwright actions and web-first assertions, which race the test
 *   - selectors that appear nowhere in the evidence the model was given
 *   - tests that duplicate one another or a test that already exists
 *
 * A removed test's scenario is then filled in by the deterministic
 * synthesizer (see testGenerator.fillGaps), so rejection never silently
 * drops coverage.
 */
import ts from 'typescript';
import type { TestGeneratorOutput } from '@qa-agent/shared';

export interface GeneratedTestIssue {
  where: string;
  problem: string;
}

export interface ValidationResult {
  output: TestGeneratorOutput;
  issues: GeneratedTestIssue[];
  removedTests: number;
}

export interface ValidationContext {
  /** Every piece of text the model was shown as evidence; selectors must come from here. */
  evidenceText: string;
  /** Titles of tests that already exist in the repository. */
  existingTitles?: string[];
}

const HARD_WAIT = /\bwaitForTimeout\s*\(\s*\d/;
const FORCE = /\bforce\s*:\s*true\b/;
/** String-literal selectors passed to calls that take one. */
const INLINE_SELECTOR = /(?:\.locator|\bqa\s*\.\s*(?:fill|expectRejected|expectAccepted|expectMaxEnforced))\s*\(\s*(['"`])((?:(?!\1).)+)\1/g;
/** getByTestId('save') is grounded by data-testid="save" in the evidence. */
const TEST_ID_CALL = /\bgetByTestId\s*\(\s*(['"`])((?:(?!\1).)+)\1/g;
/** A statement that starts a Playwright action or web-first assertion without awaiting it. */
const UNAWAITED = [
  /^\s*(?:page|qa|\w+Page)\s*\.(?!on\b|locator\s*\([^)]*\)\s*;?\s*$)[\w.$]*\s*\(/,
  /^\s*expect\s*\((?:page\b|[^)]*\.(?:locator|getBy\w+|el)\s*\()[\s\S]*\)\s*\.(?:not\s*\.\s*)?to(?:Be|Have|Contain)\w*\s*\(/,
];

export function syntaxErrors(body: string): string[] {
  const wrapped = `async function __generated(this: any) {\n${body}\n}`;
  const res = ts.transpileModule(wrapped, {
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  return (res.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

/**
 * A selector is grounded when it, or the attribute value inside it, appears in
 * the evidence. `[data-testid="save"]` is grounded by `data-testid="save"` or
 * by a listed selector `[data-testid="save"]`.
 */
/** Structural selectors every page has; they need no evidence. */
const GENERIC_SELECTORS = /^(html|body|main|header|footer|nav|h[1-6]|dialog|\[role=["']?(main|dialog|alert|heading|navigation|status|progressbar)["']?\])$/i;

export function selectorIsGrounded(selector: string, evidenceText: string): boolean {
  const s = selector.trim();
  if (!s) return false;
  if (GENERIC_SELECTORS.test(s)) return true;
  if (evidenceText.includes(s)) return true;
  const values = [...s.matchAll(/=\s*["']?([^"'\]]+)["']?\s*\]/g)].map((m) => m[1]!);
  const ids = [...s.matchAll(/#([\w-]+)/g)].map((m) => m[1]!);
  const candidates = [...values, ...ids].filter((v) => v.length >= 3);
  return candidates.length > 0 && candidates.every((v) => evidenceText.includes(v));
}

const norm = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const usesLocator = (body: string, name: string) =>
  new RegExp(`locators\\.${escapeRe(name)}\\b|\\bel\\(\\s*['"\`]${escapeRe(name)}['"\`]`).test(body);

export function validateGeneratedTests(output: TestGeneratorOutput, ctx: ValidationContext): ValidationResult {
  const issues: GeneratedTestIssue[] = [];
  const bannedLocators = new Set<string>();
  const bannedMethods = new Set<string>();

  const bodyProblems = (body: string): string[] => {
    const problems: string[] = [];
    if (HARD_WAIT.test(body)) problems.push('uses a hard wait waitForTimeout(<ms>)');
    // forbidOnly is set, so a stray .only would fail the whole run, not one test.
    if (/\btest\s*\.\s*only\s*\(/.test(body)) problems.push('uses test.only(), which would skip the rest of the suite');
    if (FORCE.test(body)) problems.push('uses { force: true }');
    for (const m of body.matchAll(INLINE_SELECTOR)) {
      if (m[2]!.includes('${')) continue; // built at runtime; cannot be checked statically
      if (!selectorIsGrounded(m[2]!, ctx.evidenceText)) problems.push(`uses selector ${m[2]} that is not in the evidence`);
    }
    for (const m of body.matchAll(TEST_ID_CALL)) {
      if (m[2]!.includes('${')) continue;
      if (!selectorIsGrounded(`[data-testid="${m[2]}"]`, ctx.evidenceText)) problems.push(`uses test id ${m[2]} that is not in the evidence`);
    }
    const unawaited = body.split('\n').find((line) => UNAWAITED.some((re) => re.test(line)));
    if (unawaited) problems.push(`does not await "${unawaited.trim().slice(0, 60)}"`);
    const syntax = syntaxErrors(body);
    if (syntax.length) problems.push(`is not valid TypeScript: ${syntax[0]}`);
    return problems;
  };

  const pageObjects = output.pageObjects.map((po) => {
    const locators = po.locators.filter((l) => {
      if (selectorIsGrounded(l.selector, ctx.evidenceText)) return true;
      bannedLocators.add(l.name);
      issues.push({ where: `${po.className}.locators.${l.name}`, problem: `selector ${l.selector} is not in the evidence` });
      return false;
    });
    const methods = po.methods.filter((m) => {
      const problems = bodyProblems(m.body);
      const usesBanned = [...bannedLocators].find((n) => usesLocator(m.body, n));
      if (usesBanned) problems.push(`relies on rejected locator ${usesBanned}`);
      // this.el('x') / this.locators.x for a locator the class never defines throws at runtime.
      const defined = new Set(locators.map((l) => l.name));
      const undefinedRefs = [...m.body.matchAll(/\bel\(\s*(['"`])(\w+)\1|locators\.(\w+)/g)].map((x) => x[2] ?? x[3]!)
        .filter((n) => !defined.has(n) && !bannedLocators.has(n));
      if (undefinedRefs.length) problems.push(`uses locator ${[...new Set(undefinedRefs)].join(', ')}, which ${po.className} does not define`);
      if (problems.length === 0) return true;
      bannedMethods.add(m.name);
      for (const p of problems) issues.push({ where: `${po.className}.${m.name}()`, problem: p });
      return false;
    });
    return { ...po, locators, methods };
  });

  const seen = new Set((ctx.existingTitles ?? []).map(norm));
  let removedTests = 0;
  const specs = output.specs.map((spec) => ({
    ...spec,
    tests: spec.tests.filter((t) => {
      const problems = bodyProblems(t.body);
      const locator = [...bannedLocators].find((n) => usesLocator(t.body, n));
      if (locator) problems.push(`relies on rejected locator ${locator}`);
      const method = [...bannedMethods].find((n) => new RegExp(`\\.${escapeRe(n)}\\s*\\(`).test(t.body));
      if (method) problems.push(`calls rejected method ${method}()`);
      if (seen.has(norm(t.title))) problems.push('duplicates an existing test');
      if (problems.length === 0) { seen.add(norm(t.title)); return true; }
      removedTests++;
      for (const p of problems) issues.push({ where: `${spec.fileName} "${t.title}"`, problem: p });
      return false;
    }),
  }));

  const notes = issues.length
    ? [...output.notes, `Validation removed ${removedTests} generated test(s): ${issues.slice(0, 5).map((i) => `${i.where} ${i.problem}`).join('; ')}${issues.length > 5 ? '; ...' : ''}`]
    : output.notes;

  return { output: { ...output, pageObjects, specs, notes }, issues, removedTests };
}
