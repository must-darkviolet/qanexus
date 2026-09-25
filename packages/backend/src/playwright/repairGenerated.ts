/**
 * Safe, deterministic repair of generated tests before they are written.
 *
 * The suite's pattern is that a test uses a page object as a lowerCamelCase
 * variable named after its class (EducationManagementPage ->
 * educationManagementPage), which the renderer constructs from the page
 * objects that exist. A model sometimes refers to one under a slightly
 * different name, or to one it never defined. Only two repairs are safe:
 *
 *   - the name differs from an existing page object's only in spelling or a
 *     "Page" suffix: use that page object;
 *   - no such page object exists anywhere and the test only calls .goto() on
 *     it: navigate with the page fixture to the module's route instead.
 *
 * Anything else is left alone, for preflight to reject as UNEXECUTABLE_TEST;
 * nothing is invented here.
 */
import type { TestGeneratorOutput } from '@qa-agent/shared';
import { camel, pascal } from '../util/ids.js';

export interface KnownPageObject { className: string; fileName: string }

const norm = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/page$/, '');
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const instanceName = (className: string) => camel(pascal(className));

export function repairGeneratedOutput(
  output: TestGeneratorOutput,
  opts: { existingPageObjects: KnownPageObject[]; route: string | null },
): { output: TestGeneratorOutput; repairs: string[] } {
  const repairs: string[] = [];
  const available: KnownPageObject[] = [
    ...output.pageObjects.map((po) => ({ className: po.className, fileName: po.fileName })),
    ...opts.existingPageObjects.filter((e) => !output.pageObjects.some((po) => pascal(po.className) === pascal(e.className))),
  ];
  const instances = new Set(available.map((po) => instanceName(po.className)));

  const repairBody = (body: string, where: string): string => {
    let out = body;
    // Page objects, and the flows class (educationManagementFlows), by the name a test uses them under.
    const used = [...new Set([...out.matchAll(/(?<![\w.$])([a-z][A-Za-z0-9]*(?:Page|Flows))\s*\./g)].map((m) => m[1]!))];
    for (const name of used) {
      if (instances.has(name)) continue;
      if (new RegExp(`\\b(const|let|var)\\s+${escapeRe(name)}\\b`).test(out)) continue;
      const match = available.find((po) => norm(po.className) === norm(name));
      if (match) {
        const target = instanceName(match.className);
        out = out.replace(new RegExp(`(?<![\\w.$])${escapeRe(name)}\\b`, 'g'), target);
        repairs.push(`${where}: ${name} -> ${target} (the existing ${pascal(match.className)} page object).`);
        continue;
      }
      const calls = [...out.matchAll(new RegExp(`(?<![\\w.$])${escapeRe(name)}\\s*\\.\\s*(\\w+)`, 'g'))].map((m) => m[1]);
      if (opts.route && calls.length && calls.every((c) => c === 'goto')) {
        out = out.replace(new RegExp(`(?<![\\w.$])${escapeRe(name)}\\s*\\.\\s*goto\\s*\\(\\s*\\)`, 'g'), `page.goto(${JSON.stringify(opts.route)})`);
        repairs.push(`${where}: ${name}.goto() -> page.goto('${opts.route}') (no ${pascal(name)} page object exists; the page fixture navigates the same way).`);
      }
    }
    return out;
  };

  /**
   * A controlled response the test sets up, triggers, but never checks: add the
   * check. It only makes the test stricter - it cannot make it pass.
   */
  /** qa.stub does nothing against the real backend; qa.intercept (same arguments) answers in both modes. */
  const stubToIntercept = (body: string, where: string): string => {
    if (!/\bqa\.stub\s*\(/.test(body)) return body;
    repairs.push(`${where}: qa.stub -> qa.intercept - it answers the request against the real backend too, so the test runs instead of being skipped.`);
    return body.replace(/\bqa\.stub\s*\(/g, 'qa.intercept(');
  };

  /** test.skip(!qa.mockApi) in a test that only uses qa.intercept (which always works) just hides it. */
  const dropPointlessSkip = (body: string, where: string): string => {
    if (!/test\.skip\(\s*!\s*qa\.mockApi/.test(body) || /qa\.stub\s*\(/.test(body)) return body;
    repairs.push(`${where}: removed test.skip(!qa.mockApi) - it only uses qa.intercept, which works against the real backend.`);
    return body.replace(/^[ \t]*test\.skip\(\s*!\s*qa\.mockApi[^\n]*\n?/m, '');
  };

  const assertControlled = (body: string, where: string): string => {
    const intercepts = [...body.matchAll(/qa\.intercept\([^;]*?,\s*(['"`])([\w-]+)\1\s*\)/g)].map((m) => ({ alias: m[2]!, end: m.index! + m[0].length }));
    const acts = /\.(click|dblclick|fill|press|check|uncheck|selectOption|setChecked)\s*\(|\b[a-z]\w*Page\s*\.\s*(?!goto\b|el\b)\w+\s*\(|\b[a-z]\w*Flows\s*\.\s*\w+\s*\(/.test(body);
    // Opening or reloading the page after the intercept triggers a request made on load.
    const opensAfter = (end: number) => /\bpage\.(goto|reload)\s*\(|\b[a-z]\w*Page\s*\.\s*goto\s*\(|\b[a-z]\w*Flows\s*\.\s*\w+\s*\(/.test(body.slice(end));
    let out = body;
    for (const { alias, end } of intercepts) {
      if (!(acts || opensAfter(end)) || new RegExp(`qa\\.(expectRequest\\w*|waitFor|lastRequest)\\(\\s*['"\`]${escapeRe(alias)}['"\`]`).test(out)) continue;
      out = `${out.trimEnd()}\nawait qa.expectRequestMade('${alias}');`;
      repairs.push(`${where}: added qa.expectRequestMade('${alias}') - the controlled response was set up and triggered but never checked.`);
    }
    return out;
  };

  /** expect('[aria-label="copy"]').toBeVisible(): a selector string where a locator belongs. */
  const locatorForString = (body: string, where: string): string => body.replace(
    /\bexpect\(\s*(['"`])((?:[#.[]|[a-z]+\[)(?:(?!\1).)*)\1\s*\)(\s*\.(?:not\s*\.)?to[A-Z]\w*\()/g,
    (_m, q: string, sel: string, rest: string) => {
      repairs.push(`${where}: expect(${q}${sel}${q}) -> expect(page.locator(${q}${sel}${q})) - a web-first assertion needs a locator, not a selector string.`);
      return `expect(page.locator(${q}${sel}${q}))${rest}`;
    },
  );

  /** try { ... } catch (e) {} hides every failure inside it: the body runs unguarded instead. */
  const unwrapSwallowedErrors = (body: string, where: string): string => {
    let out = body;
    for (;;) {
      const m = out.match(/\btry\s*\{/);
      if (!m) break;
      const open = m.index! + m[0].length - 1;
      let depth = 0; let close = -1;
      for (let i = open; i < out.length; i++) { if (out[i] === '{') depth++; else if (out[i] === '}' && --depth === 0) { close = i; break; } }
      if (close < 0) break;
      const after = out.slice(close + 1).match(/^\s*catch\s*(\(\s*\w*\s*\))?\s*\{\s*(\/\/[^\n]*\s*|\/\*[\s\S]*?\*\/\s*)?\}/);
      if (!after) break; // a catch that does something is left alone
      out = `${out.slice(0, m.index!)}${out.slice(open + 1, close).trim()}${out.slice(close + 1 + after[0].length)}`;
      repairs.push(`${where}: removed an empty try/catch - it would hide a failure of the steps inside it.`);
    }
    return out;
  };

  const specs = output.specs.map((spec) => ({
    ...spec,
    beforeEach: spec.beforeEach ? repairBody(spec.beforeEach, `${spec.fileName} beforeEach`) : spec.beforeEach,
    tests: spec.tests.map((t) => {
      const where = `${spec.fileName} [${t.scenarioId}]`;
      return { ...t, body: assertControlled(dropPointlessSkip(unwrapSwallowedErrors(locatorForString(stubToIntercept(repairBody(t.body, where), where), where), where), where), where) };
    }),
  }));
  return { output: { ...output, specs }, repairs };
}
