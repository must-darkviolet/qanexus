/**
 * Renders TestGenerator output into TypeScript Playwright files.
 *
 * The agent returns structure, not source text. Rendering here means:
 *   - imports always resolve and the POM wiring is always correct
 *   - the locator rationale the spec requires survives into the file as a comment
 *   - quality rules (no hard waits, no stray force clicks) can be checked
 *     mechanically before anything is written to disk; blocking rules keep
 *     a file from being written at all
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { TestGeneratorOutput } from '@qa-agent/shared';
import { camel, pascal, sha256, slug } from '../util/ids.js';
import { createLogger } from '../util/logger.js';
import { SPEC_SUFFIX, SUITE_DIRS, writeIfChanged, type SuiteLayout } from './scaffold.js';

const log = createLogger('playwright:codegen');

export interface GeneratedFile {
  /** Path relative to the suite root, e.g. "tests/users.spec.ts". */
  relPath: string;
  absPath: string;
  content: string;
  hash: string;
  kind: 'spec' | 'page_object' | 'fixture';
  feature: string;
  scenarioIds: string[];
  isNew: boolean;
  changed: boolean;
}

/** Problems found in generated code, surfaced rather than silently accepted. */
export interface CodeQualityIssue {
  file: string;
  rule: string;
  detail: string;
  /**
   * 'error' blocks the file: it is not written and any previous version is
   * kept. 'warning' is recorded but the file is still written.
   */
  severity: 'error' | 'warning';
  /** 1-based line in the generated file, when the rule is line-specific. */
  line?: number;
}

/** Actions and expects may not wait longer than this for a single step. */
export const MAX_STEP_TIMEOUT_MS = 30_000;
/** Visible-text selectors at least this long break on any copy edit. */
const LONG_TEXT_SELECTOR = 40;

interface LineRule {
  rule: string;
  severity: CodeQualityIssue['severity'];
  detail: string;
  /** Called with the line with comments blanked out; the original lines are passed for context. */
  hit: (code: string, index: number, original: string[]) => boolean;
}

const STRING_LITERAL = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
const stringsIn = (code: string): string[] => [...code.matchAll(STRING_LITERAL)].map((m) => m[2]!);

/** A CSS selector with this many descendant/child combinators is tied to the DOM layout. */
function longCssChain(selector: string): boolean {
  const parts = selector.trim().split(/\s*>\s*|\s+/).filter(Boolean);
  if (parts.length < 5) return false;
  const cssToken = /^[#.[a-z*][\w\-#.[\]="':()*^$~|]*$/;
  return parts.every((p) => cssToken.test(p)) && parts.some((p) => /^[#.[]/.test(p) || p.includes('['));
}

const LINE_RULES: LineRule[] = [
  /* ------------------------------ blocking ------------------------------ */
  {
    rule: 'no-hard-wait', severity: 'error',
    detail: 'Hard waits (waitForTimeout, setTimeout sleeps) make tests slow and flaky. Wait on a request, a locator or an assertion instead.',
    // `test.setTimeout(ms)` sets the test budget and is not a sleep, hence the lookbehind.
    hit: (code) => /\bwaitForTimeout\s*\(/.test(code) || /(?<![.\w$])setTimeout\s*\(/.test(code),
  },
  {
    rule: 'no-only', severity: 'error',
    detail: '.only() would stop the rest of the suite from running.',
    hit: (code) => /\b(?:test|it|describe)(?:\s*\.\s*describe)?\s*\.\s*only\s*\(/.test(code),
  },
  {
    rule: 'no-force', severity: 'error',
    detail: '{ force: true } hides real interaction problems. If it is truly required, add a `// qa-allow-force: <reason>` comment on the same or previous line.',
    hit: (code, i, original) => /\bforce\s*:\s*true\b/.test(code)
      && ![original[i] ?? '', original[i - 1] ?? ''].some((l) => /(?:\/\/|\/\*).*qa-allow-force:\s*\S/.test(l)),
  },
  {
    rule: 'no-xpath', severity: 'error',
    detail: 'XPath selectors are fragile; prefer getByRole or data-testid.',
    hit: (code) => stringsIn(code).some((s) => /^\s*xpath=/.test(s) || /^\s*\(?\/\/[\w*-]+(?:\[|\/|\(|$)/.test(s)),
  },
  {
    rule: 'no-serial', severity: 'error',
    detail: 'Serial mode makes tests depend on execution order. Each test must set up its own state.',
    hit: (code) => /\bdescribe\s*\.\s*serial\b/.test(code)
      || /\bconfigure\s*\(\s*\{[^}]*\bmode\s*:\s*['"`]serial['"`]/.test(code),
  },
  {
    rule: 'no-long-timeout', severity: 'error',
    detail: `A step timeout above ${MAX_STEP_TIMEOUT_MS}ms hides slowness instead of waiting on a real condition.`,
    hit: (code) => [...code.matchAll(/\btimeout\s*:\s*(\d[\d_]*)/g)]
      .some((m) => Number(m[1]!.replace(/_/g, '')) > MAX_STEP_TIMEOUT_MS),
  },
  /* ------------------------------ warnings ------------------------------ */
  {
    rule: 'fragile-nth-selector', severity: 'warning',
    detail: 'Positional CSS (:nth-child / :nth-of-type) breaks when the layout changes; prefer a role or data-testid.',
    hit: (code) => /:nth-(?:last-)?(?:child|of-type)\s*\(/.test(code),
  },
  {
    rule: 'fragile-nth-index', severity: 'warning',
    detail: '.nth(<index>) on a generic locator depends on element order; scope by role or data-testid instead.',
    hit: (code) => [...code.matchAll(/\.nth\(\s*(\d+)\s*\)/g)].some((m) => Number(m[1]) > 0)
      && !/\bgetBy(?:Role|TestId)\s*\(/.test(code),
  },
  {
    rule: 'fragile-css-chain', severity: 'warning',
    detail: 'A long CSS chain (4+ combinators) is tied to the DOM structure; prefer a role or data-testid.',
    hit: (code) => stringsIn(code).some(longCssChain),
  },
  {
    rule: 'fragile-generated-class', severity: 'warning',
    detail: 'Build-generated class names (CSS-in-JS, CSS modules, MUI internals) change between builds.',
    hit: (code) => stringsIn(code).some((s) =>
      /\.css-[a-z0-9]{5,}/.test(s) || /\.sc-[A-Za-z0-9]/.test(s) || /\[class\s*[*^$]?=/.test(s)
      || /\.Mui[A-Z]\w*-root\b/.test(s) || /\.jsx-\d+/.test(s) || /\.[A-Za-z]\w*__\w+___[A-Za-z0-9_-]{5}\b/.test(s)),
  },
  {
    rule: 'fragile-long-text', severity: 'warning',
    detail: `Matching ${LONG_TEXT_SELECTOR}+ characters of exact copy breaks on any wording change; match a shorter, stable part or use a role/testid.`,
    hit: (code) => [
      ...code.matchAll(/\bgetByText\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g),
    ].some((m) => m[2]!.length >= LONG_TEXT_SELECTOR)
      || stringsIn(code).some((s) => {
        const t = /^\s*text\s*=\s*(.*)$/.exec(s)?.[1] ?? /:has-text\((.*)\)/.exec(s)?.[1];
        return t !== undefined && t.replace(/^['"]|['"]$/g, '').length >= LONG_TEXT_SELECTOR;
      }),
  },
];

/** Multi-line rules, checked against the whole (comment-free) file. */
const FILE_RULES: { rule: string; severity: CodeQualityIssue['severity']; test: RegExp; detail: string }[] = [
  { rule: 'no-conditional-assertion', severity: 'warning', test: /\bif\s*\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)\s*\{?\s*(?:await\s+)?expect\b/g, detail: 'A conditional assertion can silently pass. Assert unconditionally.' },
];

/**
 * Replaces comments with spaces (keeping line breaks), so rules never fire on
 * prose such as a locator rationale that says "avoid waitForTimeout".
 */
function blankComments(content: string): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, content);
  let out = '';
  let last = 0;
  // Brace depth per open template expression, so `}` resumes the template
  // text instead of being scanned as code.
  const templates: number[] = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.TemplateHead) { templates.push(0); continue; }
    if (templates.length) {
      if (kind === ts.SyntaxKind.OpenBraceToken) templates[templates.length - 1]!++;
      else if (kind === ts.SyntaxKind.CloseBraceToken) {
        if (templates[templates.length - 1]! > 0) templates[templates.length - 1]!--;
        else if (scanner.reScanTemplateToken(false) === ts.SyntaxKind.TemplateTail) templates.pop();
        continue;
      }
    }
    if (kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia) {
      const start = scanner.getTokenPos();
      const end = scanner.getTextPos();
      out += content.slice(last, start) + content.slice(start, end).replace(/[^\n]/g, ' ');
      last = end;
    }
  }
  return out + content.slice(last);
}

/**
 * Quality rules for generated Playwright code. Rules with severity 'error'
 * make a file unfit to run (hard waits, .only, forced actions, XPath, serial
 * mode, long step timeouts); 'warning' rules flag fragile selectors.
 * Non-TypeScript files are not linted.
 */
export function lintGeneratedSource(relPath: string, content: string): CodeQualityIssue[] {
  if (!/\.[jt]sx?$/.test(relPath)) return [];
  const code = blankComments(content);
  const codeLines = code.split('\n');
  const originalLines = content.split('\n');
  const issues: CodeQualityIssue[] = [];
  for (const { rule, severity, detail, hit } of LINE_RULES) {
    codeLines.forEach((line, i) => {
      if (hit(line, i, originalLines)) issues.push({ file: relPath, rule, severity, detail, line: i + 1 });
    });
  }
  for (const { rule, severity, test, detail } of FILE_RULES) {
    for (const m of code.matchAll(test)) {
      const line = code.slice(0, m.index).split('\n').length;
      issues.push({ file: relPath, rule, severity, detail, line });
    }
  }
  return issues.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
}

export const isBlocking = (issue: CodeQualityIssue): boolean => issue.severity === 'error';

/**
 * Parses generated TypeScript before it is written. A file with syntax errors
 * would fail the whole Playwright run for a reason that has nothing to do with the
 * application, so it is rejected instead and the previous version is kept.
 */
export function validateGeneratedSource(relPath: string, content: string): CodeQualityIssue[] {
  if (!/\.[jt]sx?$/.test(relPath)) {
    if (!relPath.endsWith('.json')) return [];
    try { JSON.parse(content); return []; }
    catch (e) { return [{ file: relPath, rule: 'invalid-json', severity: 'error', detail: (e as Error).message }]; }
  }
  const result = ts.transpileModule(content, {
    fileName: relPath,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.ESNext },
  });
  return (result.diagnostics ?? [])
    .filter((d) => d.category === ts.DiagnosticCategory.Error)
    .slice(0, 5)
    .map((d): CodeQualityIssue => {
      const pos = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : null;
      return {
        file: relPath,
        rule: 'syntax-error',
        severity: 'error',
        ...(pos ? { line: pos.line + 1 } : {}),
        detail: `${pos ? `line ${pos.line + 1}: ` : ''}${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`,
      };
    });
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line.trim().length ? pad + line : line))
    .join('\n');
}

/* -------------------------------------------------------------------------- */
/* Page objects                                                                */
/* -------------------------------------------------------------------------- */
function pageObjectFileName(po: TestGeneratorOutput['pageObjects'][number]): string {
  return toGeneratedFileName(po.fileName, slug(po.className) || 'page', '.page.ts');
}

function renderPageObject(po: TestGeneratorOutput['pageObjects'][number]): string {
  const className = pascal(po.className);

  const locatorEntries = po.locators.map((l) => {
    // The rationale is a spec requirement (section 13) and is genuinely useful
    // during review, so it is preserved verbatim above each locator.
    const rationale = l.rationale.replace(/\*\//g, '*\\/');
    return `    /**
     * Strategy: ${l.strategy}${l.sourceFile ? ` (from ${l.sourceFile})` : ''}
     * Why this selector: ${rationale}
     */
    ${camel(l.name)}: ${JSON.stringify(l.selector)},`;
  }).join('\n');

  const methods = po.methods.map((m) => {
    const params = m.params.map((p) => `${p.name}: ${p.type}`).join(', ');
    const doc = m.description ? `  /** ${m.description.replace(/\*\//g, '*\\/')} */\n` : '';
    return `${doc}  async ${m.name}(${params}): Promise<void> {
${indent(m.body.trim(), 4)}
  }`;
  }).join('\n\n');

  return `/**
 * ${className}
 *
 * Generated by the Autonomous AI QA Engineer.
 * Each locator records why that selector was chosen; prefer fixing the
 * application (by adding a data-testid) over weakening a selector here.
 */
import type { Locator, Page } from 'playwright/test';

export class ${className} {
${po.url ? `  readonly url = ${JSON.stringify(po.url)};\n` : ''}
  readonly locators = {
${locatorEntries || '    /* no stable locators were discovered for this page */'}
  } as const;

  constructor(readonly page: Page) {}

  /** Playwright locator for a named selector (CSS, or visible text). */
  el(name: keyof ${className}['locators']): Locator {
    const selector: string = this.locators[name];
    if (selector === undefined) throw new Error(\`Unknown locator "\${String(name)}" on ${className}\`);
    return /^[\\[#.]/.test(selector)
      ? this.page.locator(selector).first()
      : this.page.getByText(selector).first();
  }

${methods || '  /* no methods were generated for this page */'}
}
`;
}

/* -------------------------------------------------------------------------- */
/* Specs                                                                       */
/* -------------------------------------------------------------------------- */
function renderSpec(
  spec: TestGeneratorOutput['specs'][number],
  pageObjects: TestGeneratorOutput['pageObjects'],
): string {
  // Page objects are instantiated per test, as a lowerCamelCase variable
  // named after the class - the name the generator's bodies refer to.
  const instanceOf = (po: TestGeneratorOutput['pageObjects'][number]) => camel(pascal(po.className));
  const usedIn = (body: string) => pageObjects
    .filter((po) => new RegExp(`\\b${instanceOf(po)}\\b`).test(body))
    // One instance per variable name, however many entries share the class.
    .filter((po, i, all) => all.findIndex((x) => instanceOf(x) === instanceOf(po)) === i);
  const referenced = pageObjects.filter((po) =>
    spec.tests.some((t) => usedIn(t.body).includes(po)) || usedIn(spec.beforeEach ?? '').includes(po));

  const imports = [
    `import { test, expect } from '../support/qa';`,
    ...referenced.map((po) => {
      // The same name the file is written under, so the import always resolves.
      const base = (/\.flows\.ts$/.test(po.fileName) ? po.fileName : pageObjectFileName(po)).replace(/\.ts$/, '');
      return `import { ${pascal(po.className)} } from '../${SUITE_DIRS.pages}/${base}';`;
    }),
    ...spec.imports.filter((i) => i.startsWith('import ') && !/from ['"](?:@playwright\/test|playwright\/test)['"]/.test(i)),
  ];

  const instances = (body: string) => usedIn(body)
    // A flows class (pages/*.flows.ts) runs journeys through the qa fixture.
    .map((po) => `const ${instanceOf(po)} = new ${pascal(po.className)}(page${/Flows$/.test(pascal(po.className)) ? ', qa' : ''});`).join('\n');
  const block = (body: string) => {
    const setup = instances(body);
    return indent(`${setup ? `${setup}\n` : ''}${body.trim()}`, 4);
  };

  const tests = spec.tests.map((t) => {
    const tagComment = (t.tags.length ? `    // tags: ${t.tags.join(', ')}\n` : '')
      // Read back by preflight validation, which holds the test to its strategy.
      + (t.strategy ? `    // strategy: ${t.strategy}${t.evidenceSource ? ` · evidence: ${t.evidenceSource}` : ''}\n` : '');
    // The scenario id in the title is what links a Playwright result back to
    // a scenario, and through it to a business rule (spec section 6).
    return `  test('[${t.scenarioId}] ${escapeSingle(t.title)}', async ({ page, qa }) => {
${tagComment}${block(t.body)}
  });`;
  }).join('\n\n');

  return `/**
 * ${spec.describe}
 *
 * Generated by the Autonomous AI QA Engineer.
 * Test titles are prefixed with the scenario id so results stay traceable to
 * the business rules they verify. Do not remove the prefixes.
 */
${imports.join('\n')}

test.describe('${escapeSingle(spec.describe)}', () => {
${spec.beforeEach ? `  test.beforeEach(async ({ page, qa }) => {\n${block(spec.beforeEach)}\n  });\n\n` : ''}${tests || "  test.fixme('no tests were generated for this feature', () => {});"}
});
`;
}

function escapeSingle(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ');
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                     */
/* -------------------------------------------------------------------------- */
export interface WriteSuiteResult {
  files: GeneratedFile[];
  issues: CodeQualityIssue[];
  /**
   * Files that failed validation (syntax errors or a blocking lint rule) and
   * were not written. Their reasons are the `issues` with this `file` and
   * severity 'error'.
   */
  rejected: string[];
}

export function writeGeneratedSuite(
  layout: SuiteLayout,
  featureKey: string,
  output: TestGeneratorOutput,
  /** Page objects already in the suite that specs may use without regenerating them. */
  existingPageObjects: { className: string; fileName: string }[] = [],
): WriteSuiteResult {
  const importable = [
    ...output.pageObjects,
    ...existingPageObjects
      .filter((e) => !output.pageObjects.some((po) => pascal(po.className) === pascal(e.className)))
      // Two files defining one class: import it once.
      .filter((e, i, all) => all.findIndex((x) => pascal(x.className) === pascal(e.className)) === i)
      .map((e) => ({ className: e.className, fileName: e.fileName, locators: [], methods: [] })),
  ].map((po) => ({ ...po, fileName: existingPageObjects.find((e) => pascal(e.className) === pascal(po.className))?.fileName ?? po.fileName }));
  const files: GeneratedFile[] = [];
  const issues: CodeQualityIssue[] = [];
  const rejected: string[] = [];

  const record = (
    absPath: string, relPath: string, content: string,
    kind: GeneratedFile['kind'], scenarioIds: string[],
  ) => {
    // Syntax errors and blocking lint rules both reject the file: it is not
    // written, so any previous version on disk stays as it was.
    const invalid = validateGeneratedSource(relPath, content);
    const lint = invalid.length ? [] : lintGeneratedSource(relPath, content);
    const blocking = [...invalid, ...lint.filter(isBlocking)];
    if (blocking.length) {
      issues.push(...invalid, ...lint);
      rejected.push(relPath);
      log.warn(`Rejected generated ${relPath}: ${blocking.map((i) => `${i.rule}${i.line ? `@${i.line}` : ''}`).join(', ')}`);
      return;
    }
    const existed = fs.existsSync(absPath);
    const previous = existed ? fs.readFileSync(absPath, 'utf8') : null;
    const changed = previous !== content;
    if (changed) fs.writeFileSync(absPath, content, 'utf8');
    files.push({
      relPath, absPath, content, hash: sha256(content),
      kind, feature: featureKey, scenarioIds,
      isNew: !existed, changed,
    });
    issues.push(...lint);
  };

  for (const po of output.pageObjects) {
    // A class the suite already has is updated in its own file, never duplicated under a new name.
    const fileName = existingPageObjects.find((e) => pascal(e.className) === pascal(po.className))?.fileName ?? pageObjectFileName(po);
    // Older generated files defining the same class are stale copies: remove them (generated suite only).
    for (const stale of existingPageObjects.filter((e) => pascal(e.className) === pascal(po.className) && e.fileName !== fileName)) {
      try { fs.rmSync(path.join(layout.pagesDir, stale.fileName), { force: true }); log.info(`Removed stale duplicate page object ${stale.fileName}.`); } catch { /* already gone */ }
    }
    const absPath = path.join(layout.pagesDir, fileName);
    record(absPath, `${SUITE_DIRS.pages}/${fileName}`, renderPageObject(po), 'page_object', []);
  }

  for (const spec of output.specs) {
    // One spec per feature, named after it - never whatever file name the model chose.
    const fileName = toSpecFileName('', featureKey);
    const absPath = path.join(layout.testsDir, fileName);
    // Older generated specs covering the same scenarios are superseded (generated suite only).
    const ids = new Set(spec.tests.map((t) => t.scenarioId));
    for (const other of fs.existsSync(layout.testsDir) ? fs.readdirSync(layout.testsDir) : []) {
      if (other === fileName || !other.endsWith(SPEC_SUFFIX)) continue;
      const otherIds = [...fs.readFileSync(path.join(layout.testsDir, other), 'utf8').matchAll(/test(?:\.\w+)?\(\s*['"`]\[([A-Z]{2,}-\d+)\]/g)].map((m) => m[1]!);
      if (otherIds.length && otherIds.filter((i) => ids.has(i)).length / otherIds.length >= 0.5) {
        fs.rmSync(path.join(layout.testsDir, other), { force: true });
        log.info(`Removed ${other}: superseded by ${fileName}, which covers the same scenarios.`);
      }
    }
    record(
      absPath, `${SUITE_DIRS.tests}/${fileName}`,
      renderSpec(spec, importable), 'spec',
      spec.tests.map((t) => t.scenarioId),
    );
  }

  for (const fixture of output.fixtures) {
    const fileName = toGeneratedFileName(fixture.fileName, 'fixture', '.json');
    const absPath = path.join(layout.fixturesDir, fileName);
    let content = fixture.json;
    try { content = JSON.stringify(JSON.parse(fixture.json), null, 2) + '\n'; }
    catch { log.warn(`Fixture ${fileName} is not valid JSON; writing it as-is.`); }
    record(absPath, `${SUITE_DIRS.fixtures}/${fileName}`, content, 'fixture', []);
  }

  if (issues.length) {
    log.warn(`${issues.length} code-quality issue(s) in generated tests for "${featureKey}".`, issues.slice(0, 5));
  }
  log.info(`Wrote ${files.filter((f) => f.changed).length} changed file(s) for feature "${featureKey}".`);

  return { files, issues, rejected };
}

/**
 * Normalizes a spec file name to "<name>.spec.ts". A model trained on Cypress
 * habits may still answer "users.cy.ts"; that is renamed, not rejected.
 */
export function toSpecFileName(fileName: string, fallback: string): string {
  const base = path.basename(fileName || '')
    .replace(/\.(cy|spec|test)\.[jt]sx?$/, '')
    .replace(/\.[jt]sx?$/, '');
  return `${slug(base || fallback)}${SPEC_SUFFIX}`;
}

/**
 * A file name that cannot leave its directory. Every generated name is model
 * output, so it is reduced to a slug of its base name: "../../../.npmrc" can
 * never become a path, whatever the model answers.
 */
export function toGeneratedFileName(fileName: string, fallback: string, extension: string): string {
  const base = path.basename(fileName || '');
  const withoutExt = base.toLowerCase().endsWith(extension.toLowerCase())
    ? base.slice(0, -extension.length)
    : base.replace(/\.[A-Za-z0-9]+$/, '');
  return `${slug(withoutExt || fallback)}${extension}`;
}

/** Every spec currently present in the suite. */
export function listSuiteSpecs(layout: SuiteLayout): string[] {
  if (!fs.existsSync(layout.testsDir)) return [];
  return fs.readdirSync(layout.testsDir)
    .filter((f) => f.endsWith(SPEC_SUFFIX))
    .map((f) => `${SUITE_DIRS.tests}/${f}`)
    .sort();
}

export function readSuiteFile(layout: SuiteLayout, relPath: string): string | null {
  const abs = path.resolve(layout.root, relPath);
  // Guard against a path escaping the suite directory. The separator matters:
  // without it a sibling directory sharing the prefix would pass.
  if (!abs.startsWith(path.resolve(layout.root) + path.sep)) return null;
  try { return fs.readFileSync(abs, 'utf8'); } catch { return null; }
}

export { writeIfChanged };
