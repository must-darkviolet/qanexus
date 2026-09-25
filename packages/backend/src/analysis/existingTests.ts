/**
 * Existing test awareness (spec section 14).
 *
 * Before generating anything we learn what the repository already has:
 * specs, page objects, custom commands, fixtures and the selectors already in
 * use. Generated tests then reuse that infrastructure instead of duplicating
 * it, and scenarios already covered are linked rather than regenerated.
 */
import path from 'node:path';
import type { ExistingTestInfo } from '@qa-agent/shared';
import { ts, parseSource, forEachNode, textOf, literalString, stringish, exportedNames } from './ast.js';
import type { ScannedFile } from './scanner.js';

const PLAYWRIGHT_IMPORT = /from\s+['"](?:@playwright\/test|playwright\/test)['"]|require\(\s*['"]@playwright\/test['"]\s*\)/;

function classify(rel: string, content: string): ExistingTestInfo['kind'] {
  const p = rel.toLowerCase();
  if (/(cypress|playwright)\.config\.[cm]?[jt]s$/.test(p) || /cypress\.json$/.test(p)) return 'config';
  if (/\/fixtures?\//.test(p) || p.endsWith('.json') && /cypress/.test(p)) return 'fixture';
  if (/\/support\//.test(p)) return /commands?\./.test(p) ? 'command' : 'support';
  if (/\/(pages?|page-objects?|pageobjects?|pom)\//.test(p)) return 'page_object';
  if (/\.(cy|spec|test)\.[jt]sx?$/.test(p)) return 'spec';
  if (/class\s+\w*Page\b/.test(content)) return 'page_object';
  return 'spec';
}

/**
 * Pulls literal selector strings out of cy.get()/cy.contains()/find() and
 * Playwright's locator()/getByTestId(). A test id is recorded as the
 * equivalent attribute selector so both frameworks' selectors compare equal.
 */
function selectorsFrom(sf: ts.SourceFile, content: string): string[] {
  const selectors = new Set<string>();
  forEachNode(sf, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = textOf(node.expression, sf);
    const byTestId = /(^|\.)(getByTestId|findByTestId)$/.test(callee);
    if (!byTestId && !/(^|\.)(get|find|contains|locator|\$|\$\$)$/.test(callee)) return;
    const first = node.arguments[0];
    if (!first) return;
    const value = stringish(first, sf);
    if (!value || value.length >= 200) return;
    selectors.add(byTestId && !value.startsWith('[') ? `[data-testid="${value}"]` : value);
  });
  // Also catch selectors declared as object/class fields.
  for (const m of content.matchAll(/['"`](\[data-(?:testid|test-id|cy|test)=[^'"`\]]+\])['"`]/g)) {
    if (m[1]) selectors.add(m[1]);
  }
  return [...selectors];
}

export function analyzeExistingTests(files: ScannedFile[]): ExistingTestInfo[] {
  const out: ExistingTestInfo[] = [];

  for (const file of files) {
    if (!file.content) continue;
    const isCypressish = /(^|\/)cypress\//.test(file.path)
      || /\.cy\.[jt]sx?$/.test(file.path)
      || /cypress\.config\.[jt]s$/.test(file.path)
      || (file.isTest && /\bcy\./.test(file.content));
    const isPlaywrightish = /playwright\.config\.[cm]?[jt]s$/.test(file.path)
      || PLAYWRIGHT_IMPORT.test(file.content);
    if (!isCypressish && !isPlaywrightish) continue;

    const kind = classify(file.path, file.content);
    if (kind === 'fixture') {
      out.push({ file: file.path, kind, titles: [], selectorsUsed: [], pageObjects: [], commands: [], visits: [] });
      continue;
    }
    if (!/\.[jt]sx?$/.test(file.path)) continue;

    const sf = parseSource(file.path, file.content);
    const titles: string[] = [];
    const commands: string[] = [];
    const visits: string[] = [];
    const pageObjects: string[] = [];

    forEachNode(sf, (node) => {
      if (!ts.isCallExpression(node)) return;
      const callee = textOf(node.expression, sf);

      if (/^(it|test|describe|context)(\.(only|skip))?$/.test(callee)) {
        const title = node.arguments[0] ? literalString(node.arguments[0]) : undefined;
        if (title) titles.push(title);
      }
      if (/^cy\.visit$/.test(callee) || /(^|\.)page\.goto$/.test(callee)) {
        const url = node.arguments[0] ? stringish(node.arguments[0], sf) : undefined;
        if (url) visits.push(url);
      }
      // Cypress.Commands.add('login', ...)
      if (/^Cypress\.Commands\.(add|overwrite)$/.test(callee)) {
        const name = node.arguments[0] ? literalString(node.arguments[0]) : undefined;
        if (name) commands.push(name);
      }
      // Usage of a custom command: cy.login(...)
      const custom = callee.match(/^cy\.([a-z]\w+)$/);
      if (custom?.[1] && !['visit', 'get', 'contains', 'find', 'wait', 'intercept', 'request', 'log', 'url', 'viewport', 'clearCookies', 'session', 'fixture', 'task', 'then', 'wrap', 'screenshot'].includes(custom[1])) {
        commands.push(custom[1]);
      }
    });

    // Page object classes, both declared here and imported.
    forEachNode(sf, (node) => {
      if (ts.isClassDeclaration(node) && node.name) pageObjects.push(node.name.text);
    });
    for (const stmt of sf.statements) {
      if (!ts.isImportDeclaration(stmt)) continue;
      const mod = literalString(stmt.moduleSpecifier) ?? '';
      if (!/page|pom|object/i.test(mod)) continue;
      const clause = stmt.importClause;
      if (clause?.name) pageObjects.push(clause.name.text);
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) pageObjects.push(el.name.text);
      }
    }
    if (kind === 'page_object') pageObjects.push(...exportedNames(sf));

    out.push({
      file: file.path,
      kind,
      titles: [...new Set(titles)],
      selectorsUsed: selectorsFrom(sf, file.content),
      pageObjects: [...new Set(pageObjects)],
      commands: [...new Set(commands)],
      visits: [...new Set(visits)],
    });
  }

  return out;
}

/** Where the repo keeps its end-to-end tests (Cypress or Playwright), if it has any. */
export function detectTestRoot(tests: ExistingTestInfo[]): string | null {
  const specs = tests.filter((t) => t.kind === 'spec' || t.kind === 'page_object');
  if (specs.length === 0) return null;
  const roots = specs.map((t) => {
    const m = t.file.match(/^(.*?(?:cypress|playwright|e2e))\//);
    return m?.[1] ?? path.dirname(t.file);
  });
  const counts = new Map<string, number>();
  for (const r of roots) counts.set(r, (counts.get(r) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}
