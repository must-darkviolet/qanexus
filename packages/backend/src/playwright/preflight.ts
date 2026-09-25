/**
 * Preflight: static validation of generated Playwright specs before a browser
 * is ever launched.
 *
 * Playwright starting is not evidence that a test is valid. A generated test
 * that references a variable nobody declared, calls a page-object method that
 * does not exist, or only navigates while its title promises to verify a
 * refetch, fails (or worse, passes) for reasons that say nothing about the
 * application. Each test is parsed with the TypeScript compiler and given
 * these gates:
 *
 *   syntax_valid         the spec parses
 *   dependencies_valid   every identifier it uses is declared, imported, a fixture or a global
 *   fixtures_valid       it only asks Playwright for fixtures that exist
 *   page_objects_valid   page-object classes, methods and locator names exist
 *   assertions_present   it asserts something
 *   behavior_covered     what it does matches what its scenario claims (not a placeholder)
 *   pr_relevant          it touches what the pull request changed (reported, not mandatory)
 *
 * A test runs only when every mandatory gate passes; otherwise it is
 * UNEXECUTABLE_TEST with the diagnostics that explain why.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { classifyScenario } from '../pipeline/strategy.js';

export interface TestGates {
  syntax_valid: boolean;
  dependencies_valid: boolean;
  fixtures_valid: boolean;
  page_objects_valid: boolean;
  assertions_present: boolean;
  behavior_covered: boolean;
  pr_relevant: boolean;
  /** Against a real backend: no destructive action it does not intercept, no reliance on inactive stubs. */
  safe_to_run: boolean;
  /** The body proves the behaviour the way its strategy says (a NETWORK test asserts requests, ...). */
  strategy_valid: boolean;
  /** The endpoints it observes or intercepts exist (in the source or the running app). */
  evidence_source_valid: boolean;
}

const MANDATORY: (keyof TestGates)[] = [
  'syntax_valid', 'dependencies_valid', 'fixtures_valid', 'page_objects_valid', 'assertions_present', 'behavior_covered', 'safe_to_run',
  'strategy_valid', 'evidence_source_valid',
];

/** Controls whose click changes data for everyone using the environment. */
const DESTRUCTIVE = /\b(reset|delete|remove|purge|destroy|approve|reject|wipe|clear all|deactivate|terminate|save|submit|update|toggle|confirm|send|apply)\b/i;

export interface TestDiagnostic {
  specFile: string;
  scenarioId: string | null;
  title: string;
  /** Identifiers the test body uses. */
  referenced: string[];
  /** How each referenced identifier resolves: fixture, import, local, page-object, global - or MISSING. */
  declared: Record<string, string>;
  assertions: number;
  /** What the test does, e.g. ["goto"], ["stub", "click", "waitFor"]. */
  actions: string[];
  gates: TestGates;
  /** SCENARIO_IMPLEMENTATION_VALID: every mandatory gate passed. */
  executable: boolean;
  problems: string[];
  /** Why the semantic gate failed, when it did. */
  semanticReason: string | null;
  /** TEST_STRATEGY: declared by the generator (// strategy: X) or inferred from the scenario. */
  strategy?: string | null;
  /** EVIDENCE_SOURCE the test relies on. */
  evidenceSource?: string | null;
  /** For an unimplemented scenario: the strategies considered and why each could not work. */
  strategiesAttempted?: { strategy: string; whyNot: string }[];
}

export interface SpecPreflight {
  specFile: string;
  /** Problems with the file as a whole (syntax, unresolved imports); every test in it is then unexecutable. */
  fileProblems: string[];
  tests: TestDiagnostic[];
}

export interface PageObjectInfo {
  className: string;
  /** The file under pages/ that defines it. */
  fileName: string;
  /** Methods whose own body is broken (an undefined locator), with why. */
  brokenMethods?: Record<string, string>;
  methods: string[];
  locators: string[];
  hasUrl: boolean;
}

export interface PreflightContext {
  /** Suite root; relative imports are resolved against it. */
  suiteRoot: string;
  /** Page objects that exist (parsed from the suite's pages/ directory). */
  pageObjects: PageObjectInfo[];
  /** Methods and properties of the qa fixture. */
  qaHelpers: string[];
  /** What each scenario claims, by id. */
  scenarios: Record<string, { title: string; expectedResult?: string; category?: string }>;
  /** Terms from the pull request's diff (identifiers, fields, components) and affected routes. */
  changedTerms?: string[];
  /** Fixtures the suite's own support file adds with test.extend<{ ... }>. */
  customFixtures?: string[];
  /** Whether qa.stub is active (TEST_MOCK_API=1). Against a real backend it does nothing. */
  mockApi?: boolean;
  /** Endpoint paths known to exist; network patterns must match one. Empty/absent: not checked. */
  apiPaths?: string[];
  /** Ids the application's source gives to several elements: a test cannot find one control by them. */
  sharedIds?: string[];
  /** Endpoints the application sends only after user steps (analysis/interactionRecipes.ts). */
  triggers?: {
    paths: string[]; steps: number; summary: string; flows: string[]; aliases?: Record<string, string[]>;
    /** Per flow: code conditions on the way to the request, and whether they hold in that flow. */
    conditions?: Record<string, string[]>;
    expected?: Record<string, { sent: boolean | null; why: string }>;
    proven?: Record<string, boolean>;
    proofFailures?: Record<string, string>;
  }[];
}

/** The fixture names a support file adds: base.extend<{ qa: Qa; somePage: SomePage }>(...). */
export function readCustomFixtures(supportFile: string): string[] {
  if (!fs.existsSync(supportFile)) return [];
  const source = fs.readFileSync(supportFile, 'utf8');
  const names = new Set<string>();
  for (const m of source.matchAll(/\.extend<\{([^}]*)\}>/g)) {
    for (const f of m[1]!.matchAll(/(\w+)\s*:/g)) names.add(f[1]!);
  }
  return [...names];
}

/** Playwright's built-in test fixtures. */
const FIXTURES = new Set(['page', 'context', 'browser', 'browserName', 'request', 'baseURL', 'qa', 'qaEvidence']);

/** Names every test may use without declaring them. */
const GLOBALS = new Set([
  'test', 'expect', 'console', 'Promise', 'JSON', 'Math', 'Date', 'Number', 'String', 'Boolean', 'Array', 'Object',
  'RegExp', 'Error', 'TypeError', 'URL', 'URLSearchParams', 'setTimeout', 'clearTimeout', 'process', 'Buffer',
  'undefined', 'NaN', 'Infinity', 'Symbol', 'Map', 'Set', 'WeakMap', 'encodeURIComponent', 'decodeURIComponent',
  'parseInt', 'parseFloat', 'isNaN', 'globalThis', 'document', 'window', 'localStorage', 'sessionStorage',
  'navigator', 'location', 'HTMLElement', 'HTMLInputElement', 'Element', 'require', 'arguments', 'this',
]);

/** Page-object members the renderer always provides. */
const PAGE_OBJECT_BUILTINS = new Set(['page', 'el', 'locators', 'url']);

const ASSERTING_QA = /^(waitFor|waitForRelevantResponse|expect\w*)$/;
const REQUEST_ASSERTING_QA = /^(waitFor|expectNotCalled|expectRequest\w*|waitForRelevantResponse)$/;
/** Opening a page: page.goto / page.reload, or a page object's goto(). */
const NAVIGATION = /\bpage\.(goto|reload)\s*\(|\b[a-z]\w*Page\s*\.\s*goto\s*\(|\b[a-z]\w*Flows\s*\.\s*\w+\s*\(/;
/** A journey from the suite's flows class (pages/*.flows.ts): it opens its page and performs every step. */
const FLOW_CALL = /\b[a-z]\w*Flows\s*\.\s*(\w+)\s*\(/g;
const INTERACTIONS = new Set(['click', 'dblclick', 'fill', 'type', 'press', 'pressSequentially', 'check', 'uncheck', 'selectOption', 'setInputFiles', 'hover', 'focus', 'dragTo', 'tap', 'clear']);
const VISIBILITY_MATCHERS = /^(toBeVisible|toBeHidden|toHaveText|toContainText|toHaveCount|toBeEnabled|toBeDisabled|toHaveValue|toBeAttached|toHaveAttribute|toBeChecked|toBeEmpty|toHaveClass)$/;
const NAVIGATION_MATCHERS = /^(toHaveURL|toHaveTitle)$/;

/* -------------------------------------------------------------------------- */
/* Page objects on disk                                                        */
/* -------------------------------------------------------------------------- */

/** Reads the classes the suite's page-object files export: their methods and locator names. */
export function readPageObjects(pagesDir: string): PageObjectInfo[] {
  if (!fs.existsSync(pagesDir)) return [];
  const out: PageObjectInfo[] = [];
  for (const file of fs.readdirSync(pagesDir).filter((f) => /\.[cm]?tsx?$/.test(f))) {
    const sf = ts.createSourceFile(file, fs.readFileSync(path.join(pagesDir, file), 'utf8'), ts.ScriptTarget.ES2022, true);
    for (const stmt of sf.statements) {
      if (!ts.isClassDeclaration(stmt) || !stmt.name) continue;
      const info: PageObjectInfo = { className: stmt.name.text, fileName: file, methods: [], locators: [], hasUrl: false, brokenMethods: {} };
      const pendingChecks: { method: string; refs: string[] }[] = [];
      for (const member of stmt.members) {
        const name = member.name && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) ? member.name.text : null;
        if (!name) continue;
        if (ts.isMethodDeclaration(member)) {
          info.methods.push(name);
          // this.el('x') / this.locators.x must name a locator the class defines.
          const body = member.body?.getText() ?? '';
          const refs = [...body.matchAll(/this\.el\(\s*(['"`])(\w+)\1/g), ...body.matchAll(/this\.locators\.(\w+)/g)].map((m) => m[2] ?? m[1]!);
          pendingChecks.push({ method: name, refs });
        }
        if (ts.isPropertyDeclaration(member)) {
          if (name === 'url') info.hasUrl = true;
          if (name === 'locators' && member.initializer) {
            let init: ts.Expression = member.initializer;
            while (ts.isAsExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression;
            if (ts.isObjectLiteralExpression(init)) {
              for (const p of init.properties) {
                if (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) info.locators.push(p.name.text);
              }
            }
          }
        }
      }
      for (const c of pendingChecks) {
        const missing = [...new Set(c.refs.filter((r) => !info.locators.includes(r)))];
        if (missing.length) info.brokenMethods![c.method] = `uses locator ${missing.map((m) => `"${m}"`).join(', ')}, which ${info.className} does not define`;
      }
      out.push(info);
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Analysis                                                                    */
/* -------------------------------------------------------------------------- */

function declaredNames(node: ts.Node, into: Set<string>): void {
  const bind = (name: ts.BindingName) => {
    if (ts.isIdentifier(name)) into.add(name.text);
    else for (const el of name.elements) if (!ts.isOmittedExpression(el)) bind(el.name);
  };
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n)) bind(n.name);
    else if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name) into.add(n.name.text);
    else if (ts.isCatchClause(n) && n.variableDeclaration) bind(n.variableDeclaration.name);
    ts.forEachChild(n, visit);
  };
  visit(node);
}

/** An identifier in a position where it is read as a value (not a property name, key or type). */
function isValueReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if (ts.isPropertyAssignment(p) && p.name === id) return false;
  if ((ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p)) && p.name === id) return false;
  if (ts.isBindingElement(p) && p.propertyName === id) return false;
  if ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p) || ts.isFunctionDeclaration(p)) && p.name === id) return false;
  if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return false;
  if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)) return false;
  if (ts.isTypeReferenceNode(p) || ts.isQualifiedName(p) || ts.isTypeQueryNode(p)) return false;
  for (let n: ts.Node = p; n; n = n.parent) {
    if (ts.isTypeNode(n)) return false;
    if (ts.isStatement(n) || ts.isSourceFile(n)) break;
  }
  return true;
}

/** The root identifier and member chain of a call: page.getByRole(...).click() -> ["page", "getByRole", "click"]. */
function callChain(expr: ts.Expression): string[] {
  const names: string[] = [];
  let e: ts.Expression = expr;
  for (;;) {
    if (ts.isCallExpression(e)) { e = e.expression; continue; }
    if (ts.isPropertyAccessExpression(e)) { names.unshift(e.name.text); e = e.expression; continue; }
    if (ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) { e = e.expression; continue; }
    if (ts.isIdentifier(e)) { names.unshift(e.text); break; }
    if (e.kind === ts.SyntaxKind.ThisKeyword) { names.unshift('this'); break; }
    break;
  }
  return names;
}

function stringArg(call: ts.CallExpression, index = 0): string | null {
  const a = call.arguments[index];
  return a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) ? a.text : null;
}

interface TestCall { title: string; fn: ts.ArrowFunction | ts.FunctionExpression; call: ts.CallExpression }

function findTests(sf: ts.SourceFile): TestCall[] {
  const tests: TestCall[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const chain = callChain(n.expression);
      const isTest = chain[0] === 'test' && (chain.length === 1 || (chain.length === 2 && /^(only|fixme|fail|slow)$/.test(chain[1]!)));
      const fn = n.arguments.find((a): a is ts.ArrowFunction | ts.FunctionExpression => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
      const title = stringArg(n);
      if (isTest && fn && title !== null) tests.push({ title, fn, call: n });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return tests;
}

/* -------------------------------------------------------------------------- */
/* Semantics: does the body do what the scenario says?                         */
/* -------------------------------------------------------------------------- */

const snakeOrCamelFields = (text: string) =>
  [...new Set([...text.matchAll(/\b([a-z]+(?:_[a-z0-9]+)+)\b/g)].map((m) => m[1]!))];

const camelOf = (snake: string) => snake.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

interface BodyFacts {
  assertions: number;
  actions: string[];
  urlAssertion: boolean;
  visibilityAssertion: boolean;
  requestAssertion: boolean;
  roleHandling: boolean;
  source: string;
}

function semanticCheck(claim: string, facts: BodyFacts, strategy: string | null = null, changedTerms: string[] = []): string | null {
  const c = claim.toLowerCase();
  const onlyNavigates = facts.actions.every((a) => a === 'goto' || a === 'skip');
  const missing: string[] = [];

  // "on a network error" / "when the API fails" describe the trigger, not a request to verify.
  const withoutTriggers = c.replace(/\b(network error|err_network|offline|api (error|failure|fails?)|request fails?|(on|after|during) (a |an )?(failed )?(network|api) (error|failure|call))\b/g, ' ');
  const aboutRequests = /\b(refetch|re-?fetch|fetch(es|ing)?|api calls?|request(s|ed)?|promise\.all|endpoint)\b/.test(withoutTriggers);
  const aboutRendering = /\b(render(s|ed|ing)?|display(s|ed)?|show(s|n)?|visible|hidden|toast|notification|error message|appear(s)?|loading state)\b/.test(c);
  // A navigation scenario is judged by its title: "Navigate to X" whose expected
  // result mentions the page rendering is still a navigation test.
  const title = c.split(' — ')[0] ?? c;
  const aboutNavigation = /\b(navigate|navigation|open(s)?|load(s)?|visit|redirect(s|ed)?)\b/.test(title) && !/\b(refetch|api|request|toast)\b/.test(title);
  const aboutRoles = /\b(role|permission|authori[sz]|admin only|access)\b/.test(c);

  if (facts.assertions === 0) return 'The test asserts nothing, so it cannot verify its scenario.';
  // An error, failure or toast claim needs an assertion about an error being shown, not any element.
  const aboutErrorShown = /\b(toast|notification|error message|offline error|error notification|toasterror|shows? an error)\b/.test(c);
  const errorAssertion = /expectErrorShown|expect\([^\n]*(error|fail|toast|alert|offline|notification|Toastify)[^\n]*\)\.(not\.)?to/i.test(facts.source);
  if (aboutErrorShown && !errorAssertion) missing.push('never asserts that the error or notification is shown (qa.expectErrorShown, or an assertion on the alert/toast)');
  if (aboutRequests && !facts.requestAssertion) missing.push('does not verify any request or refetch (no qa.observe + qa.expectRequestMade / NotMade / Count)');
  // A network strategy proves the behaviour through requests; it owes no DOM assertion.
  const networkProof = (strategy === 'NETWORK' || strategy === 'UI_AND_NETWORK' || strategy === 'API_MOCK') && facts.requestAssertion;
  if (aboutRendering && !facts.visibilityAssertion && !(aboutNavigation && facts.urlAssertion) && !networkProof) missing.push('does not assert what is rendered (no visibility or text assertion)');
  if (aboutNavigation && !facts.urlAssertion && !facts.visibilityAssertion) missing.push('does not assert where the navigation ended');
  if (aboutRoles && !facts.roleHandling) missing.push('never sets up the role or permission it claims to test');
  // Asserting a URL without ever navigating checks about:blank.
  if (!facts.actions.some((a) => a === 'goto' || /\.goto$/.test(a) || a === 'click' || a === 'press' || a === 'flow')) missing.push('never navigates to or interacts with the application');

  // Conditions named in the scenario (user_email, user_id) must appear in the test.
  // Only data fields the pull request changes must be exercised (user_email, user_id) -
  // not every snake_case word in the claim (a translation key, an element id).
  const changed = new Set(changedTerms.map((t) => t.toLowerCase()));
  const fields = snakeOrCamelFields(claim).filter((f) => changed.size === 0 || changed.has(f));
  const lastWord = (f: string) => f.split('_').pop()!;
  const absent = fields.filter((f) => !facts.source.includes(f) && !facts.source.includes(camelOf(f))
    && !(lastWord(f).length >= 4 && new RegExp(`\\b${lastWord(f)}\\b`).test(facts.source)));
  if (absent.length) missing.push(`never exercises ${absent.join(', ')}, which the scenario is about`);

  if (onlyNavigates && !aboutNavigation) missing.push('only navigates to the page');
  return missing.length ? `The scenario claims "${claim.slice(0, 140)}", but the test ${missing.join('; ')}.` : null;
}

/* -------------------------------------------------------------------------- */
/* Preflight                                                                   */
/* -------------------------------------------------------------------------- */

export function preflightSpec(specFile: string, source: string, ctx: PreflightContext): SpecPreflight {
  const sf = ts.createSourceFile(specFile, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const result: SpecPreflight = { specFile, fileProblems: [], tests: [] };

  const syntax = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (syntax.length) result.fileProblems.push(`Syntax: ${ts.flattenDiagnosticMessageText(syntax[0]!.messageText, '\n')}`);

  // Module scope: imports (resolved against the suite) and top-level declarations.
  const moduleNames = new Map<string, string>();
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const from = stmt.moduleSpecifier.text;
      const clause = stmt.importClause;
      const names: string[] = [];
      if (clause?.name) names.push(clause.name.text);
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const el of clause.namedBindings.elements) names.push(el.name.text);
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) names.push(clause.namedBindings.name.text);
      if (from.startsWith('.')) {
        const base = path.resolve(ctx.suiteRoot, 'tests', from);
        const exists = ['', '.ts', '.tsx', '.js', '/index.ts'].some((ext) => fs.existsSync(base + ext));
        if (!exists) result.fileProblems.push(`Import "${from}" does not resolve to a file in the suite.`);
        if (from.includes('/pages/')) {
          for (const n of names) {
            if (!ctx.pageObjects.some((po) => po.className === n)) result.fileProblems.push(`Import of page object ${n} from "${from}": no such class exists.`);
          }
        }
      }
      for (const n of names) moduleNames.set(n, `import from ${from}`);
    } else if (!ts.isExpressionStatement(stmt)) {
      const names = new Set<string>();
      declaredNames(stmt, names);
      for (const n of names) moduleNames.set(n, 'module');
    }
  }

  // test.beforeEach hooks that open a page: every test in their scope starts on that page.
  const navigatingHooks: ts.Node[] = [];
  const visitHooks = (n: ts.Node) => {
    if (ts.isCallExpression(n) && callChain(n.expression).join('.') === 'test.beforeEach') {
      const fn = n.arguments.find((a): a is ts.ArrowFunction | ts.FunctionExpression => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
      let scope: ts.Node = n.parent;
      while (scope.parent && !ts.isSourceFile(scope) && !ts.isFunctionLike(scope)) scope = scope.parent;
      if (fn && NAVIGATION.test(fn.body.getText())) navigatingHooks.push(scope);
    }
    ts.forEachChild(n, visitHooks);
  };
  visitHooks(sf);

  for (const t of findTests(sf)) {
    const scenarioId = t.title.match(/^\[([A-Z]{2,}-\d+)\]/)?.[1] ?? null;
    const opensPageFirst = navigatingHooks.some((scope) => scope.pos <= t.call.pos && t.call.end <= scope.end);
    const problems: string[] = [...result.fileProblems];
    const declared: Record<string, string> = {};

    // Fixtures requested by destructuring the first parameter.
    let fixturesValid = true;
    const fixtureNames = new Set<string>();
    const first = t.fn.parameters[0];
    if (first && ts.isObjectBindingPattern(first.name)) {
      for (const el of first.name.elements) {
        const name = (el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : '');
        if (!FIXTURES.has(name) && !(ctx.customFixtures ?? []).includes(name)) { fixturesValid = false; problems.push(`Requests fixture "${name}", which does not exist.`); }
        if (ts.isIdentifier(el.name)) fixtureNames.add(el.name.text);
      }
    }

    let branchesOnState = false;
    const locals = new Set<string>();
    // const x declared twice in the test body is a SyntaxError when the file loads.
    const declaredOnce = new Map<string, number>();
    for (const m of t.fn.body.getText().matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/g)) declaredOnce.set(m[1]!, (declaredOnce.get(m[1]!) ?? 0) + 1);
    const redeclared = [...declaredOnce].filter(([, n]) => n > 1).map(([name]) => name);
    if (redeclared.length) problems.push(`Declares ${redeclared.join(', ')} more than once ("Identifier has already been declared" when the file loads).`);
    declaredNames(t.fn.body, locals);

    // Page-object instances: const x = new X(page)
    const instances = new Map<string, string>();
    const visitNew = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isNewExpression(n.initializer) && ts.isIdentifier(n.initializer.expression)) {
        instances.set(n.name.text, n.initializer.expression.text);
      }
      ts.forEachChild(n, visitNew);
    };
    visitNew(t.fn.body);

    // Request aliases the test registers: qa.observe(alias, ...), qa.intercept/stub(method, pattern, response, alias).
    const bodyText = t.fn.body.getText();
    const observeAliases = new Set([...bodyText.matchAll(/qa\.observe\(\s*(['"`])((?:(?!\1).)+)\1/g)].map((m) => m[2]!));
    const interceptAliases = new Set([...bodyText.matchAll(/qa\.(?:intercept|stub)\([^;]*?,\s*(['"`])([\w-]+)\1\s*\)/g)].map((m) => m[2]!));
    const usedAliases = [...bodyText.matchAll(/qa\.(?:expectRequest\w*|lastRequest|waitFor|expectNotCalled|callsFor)\(\s*(['"`])((?:(?!\1).)+)\1/g)].map((m) => m[2]!);
    // A flow the test calls registers its own guarded requests under their aliases.
    const calledFlows = new Set([...bodyText.matchAll(FLOW_CALL)].map((m) => m[1]!));
    const flowAliases = new Set((ctx.triggers ?? []).flatMap((tr) => Object.entries(tr.aliases ?? {}).filter(([f]) => calledFlows.has(f)).flatMap(([, a]) => a)));
    const unknownAliases = [...new Set(usedAliases.filter((a) => !observeAliases.has(a) && !interceptAliases.has(a) && !flowAliases.has(a)))];

    const referenced = new Set<string>();
    let assertions = 0;
    const actions: string[] = [];
    const facts: Omit<BodyFacts, 'assertions' | 'actions' | 'source'> = { urlAssertion: false, visibilityAssertion: false, requestAssertion: false, roleHandling: false };
    let pageObjectsValid = true;

    const visit = (n: ts.Node) => {
      if (ts.isIdentifier(n) && isValueReference(n)) referenced.add(n.text);
      if (ts.isCallExpression(n)) {
        const chain = callChain(n.expression);
        const [root, ...rest] = chain;
        const last = rest[rest.length - 1] ?? root ?? '';
        if (root === 'expect') {
          // expect(...).toX() counts once, at the matcher call.
          if (rest.length && /^(to|not|poll|soft|resolves|rejects)/.test(rest[0]!) && /^to[A-Z]/.test(last)) {
            assertions++;
            if (VISIBILITY_MATCHERS.test(last)) facts.visibilityAssertion = true;
            if (NAVIGATION_MATCHERS.test(last)) facts.urlAssertion = true;
            if (/lastRequest|callsFor/.test(n.getText())) facts.requestAssertion = true;
            if (last === 'toHaveLength' || last === 'toBeGreaterThan' || last === 'toEqual' || last === 'toBe') {
              if (/waitForRequest|waitForResponse|callsFor|lastRequest|requests?\b|calls?\b/.test(n.getText())) facts.requestAssertion = true;
            }
          }
        } else if (root === 'qa' && rest.length) {
          const helper = rest[0]!;
          if (!ctx.qaHelpers.includes(helper)) { pageObjectsValid = false; problems.push(`Calls qa.${helper}(), which the qa fixture does not have.`); }
          if (ASSERTING_QA.test(helper)) {
            assertions++;
            // Asserting that an intercepted endpoint was called only proves the setup ran;
            // it is evidence of behaviour for an observed request, or for a request NOT made.
            const alias = stringArg(n);
            // ...unless a user action in the test is what causes it (click History -> history request).
            const userAction = /\.(click|dblclick|fill|press|check|uncheck|selectOption|setChecked)\(|\b[a-z]\w*Page\s*\.\s*(?!goto\b|el\b)\w+\s*\(|\b[a-z]\w*Flows\s*\.\s*\w+\s*\(/.test(bodyText);
            // A request the page makes on every load proves nothing about behaviour behind an action.
            const aboutLoading = /\b(on (page )?load|when the page (loads|opens)|navigat\w*|initial (load|fetch))\b/i.test(t.title);
            const loadOnly = REQUEST_ASSERTING_QA.test(helper) && helper !== 'expectRequestNotMade' && !userAction && !aboutLoading;
            const circular = helper === 'expectRequestMade' || helper === 'waitFor'
              ? Boolean(alias && interceptAliases.has(alias) && !observeAliases.has(alias) && !userAction) : false;
            if (REQUEST_ASSERTING_QA.test(helper) && !circular && !loadOnly) facts.requestAssertion = true;
            if (helper === 'expectPath') facts.urlAssertion = true;
            if (/^expect(ErrorShown|EmptyState|NoAlert|Rejected|Accepted|MaxEnforced|AccessDenied)$/.test(helper)) facts.visibilityAssertion = true;
            if (helper === 'expectAccessDenied') facts.roleHandling = true;
          }
          if (helper === 'session' || helper === 'loginAs') facts.roleHandling = true;
          actions.push(helper === 'fill' ? 'fill' : helper);
        } else if (root === 'page') {
          if (last === 'goto') actions.push('goto');
          else if (INTERACTIONS.has(last)) actions.push(last);
          else if (/^waitFor(Request|Response)$/.test(rest[0] ?? '')) { actions.push(rest[0]!); facts.requestAssertion = true; }
          else if (rest[0] === 'route') actions.push('route');
        } else if (root === 'test' && rest[0] === 'skip') {
          actions.push('skip');
        } else if (root && instances.has(root)) {
          const cls = instances.get(root)!;
          const po = ctx.pageObjects.find((p) => p.className === cls);
          const member = rest[0];
          if (!po) {
            pageObjectsValid = false;
            problems.push(`${root} is constructed from ${cls}, which no page-object file defines.`);
          } else if (member && !PAGE_OBJECT_BUILTINS.has(member) && !po.methods.includes(member)) {
            pageObjectsValid = false;
            problems.push(`${root}.${member}() does not exist on ${cls} (methods: ${po.methods.join(', ') || 'none'}).`);
          } else if (member && po.brokenMethods?.[member]) {
            pageObjectsValid = false;
            problems.push(`${cls}.${member}() ${po.brokenMethods[member]} - it would fail before reaching the application.`);
          } else if (member === 'el' && rest.length === 1) {
            // The call x.el('name') itself; x.el('name').click() is visited separately.
            const locator = stringArg(n);
            if (locator && !po.locators.includes(locator)) {
              pageObjectsValid = false;
              problems.push(`${root}.el('${locator}') names a locator ${cls} does not define.`);
            }
          }
          if (member === 'goto') actions.push('goto');
          else if (member && /Flows$/.test(cls)) actions.push('flow');
          else if (member && member !== 'el') actions.push(`${root}.${member}`);
          if (INTERACTIONS.has(last)) actions.push(last);
        } else if (last === 'goto') {
          actions.push('goto');
        } else if (INTERACTIONS.has(last)) {
          actions.push(last);
        }
      }
      // this.locators.<name> / x.locators.<name> on a known page object
      if (ts.isPropertyAccessExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'locators'
        && ts.isIdentifier(n.expression.expression) && instances.has(n.expression.expression.text)) {
        const po = ctx.pageObjects.find((p) => p.className === instances.get((n.expression as ts.PropertyAccessExpression).expression.getText()));
        if (po && !po.locators.includes(n.name.text)) {
          pageObjectsValid = false;
          problems.push(`${n.getText()} is not a locator of ${po.className}.`);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(t.fn.body);

    // Clicking before any page is opened acts on about:blank.
    const firstNav = opensPageFirst ? 0 : bodyText.search(NAVIGATION);
    const firstAct = bodyText.search(/\.(click|dblclick|fill|press|check|uncheck|selectOption|setChecked)\s*\(/);
    if (firstAct >= 0 && (firstNav < 0 || firstAct < firstNav)) {
      problems.push('Interacts with the page before opening any page (it would act on about:blank).');
      branchesOnState = true;
    }
    // page.locator('button').first().click() acts on whichever button comes first, often a hidden one.
    const byTagAlone = bodyText.match(/\bpage\.locator\(\s*(['"`])(button|a|div|span|input|li|tr|td|svg|img|label|p|\*)\1\s*\)(?:\s*\.\s*(?:first|last|nth)\([^)]*\))?\s*\.\s*(click|dblclick|fill|press|check|uncheck|selectOption|setChecked|hover|tap)\s*\(/);
    if (byTagAlone) {
      problems.push(`Acts on an element chosen by tag alone (page.locator('${byTagAlone[2]}')): it ${byTagAlone[3]}s whichever ${byTagAlone[2]} comes first, not the control the scenario is about.`);
      pageObjectsValid = false;
    }
    // An id the source gives to several elements finds whichever comes first (Approve All or Reset Education).
    const shared = (ctx.sharedIds ?? []).filter((id) => new RegExp(`['"\`]#${id}\\b`).test(bodyText));
    if (shared.length) {
      problems.push(`Locates by #${shared.join(', #')}, which the application's source gives to several different elements - it does not identify the control the scenario is about.`);
      pageObjectsValid = false;
    }
    // "No request was made" proves nothing when the test did nothing that could have made one.
    const didSomething = /\.(click|dblclick|fill|press|check|uncheck|selectOption|setChecked|dispatchEvent)\(|\b[a-z]\w*Page\s*\.\s*(?!goto\b|el\b)\w+\s*\(|\b[a-z]\w*Flows\s*\.\s*\w+\s*\(/.test(bodyText);
    if (/qa\.expectRequestNotMade\s*\(/.test(bodyText) && !didSomething) {
      problems.push('Asserts a request was NOT made without performing any action that could make it - the assertion cannot fail.');
      branchesOnState = true;
    }
    // A controlled response must be shown to have happened, or the condition was never exercised.
    const assertedAliases = new Set(usedAliases);
    const unexercised = [...interceptAliases].filter((a) => !assertedAliases.has(a));
    if (unexercised.length && !/\bqa\.expectRequest|\bqa\.waitFor\b/.test(bodyText.replace(/qa\.observe[^\n]*/g, ''))) {
      problems.push(`Sets up a controlled response (${unexercised.map((a) => `"${a}"`).join(', ')}) but never shows the application requested it, so the condition may never have happened.`);
      branchesOnState = true;
    }
    let dependenciesValid = unknownAliases.length === 0;
    for (const a of unknownAliases) {
      problems.push(`Asserts on request alias "${a}", which the test never registers with qa.observe / qa.intercept - the assertion could never fail.`);
    }
    for (const name of referenced) {
      const kind = fixtureNames.has(name) ? 'fixture'
        : instances.has(name) ? `page-object ${instances.get(name)}`
        : locals.has(name) ? 'local'
        : moduleNames.get(name) ?? (GLOBALS.has(name) ? 'global' : null);
      declared[name] = kind ?? 'MISSING';
      if (!kind) {
        dependenciesValid = false;
        problems.push(`${name} is used but never declared, imported or provided as a fixture (it would throw "ReferenceError: ${name} is not defined").`);
      }
    }

    // test.fixme(true, 'PENDING: ...') is an honest "not implemented", not a broken test.
    const pendingCall = t.fn.body.getText().match(/test\.fixme\(\s*true\s*,\s*(['"`])((?:(?!\1).)*)\1/);
    if (pendingCall) {
      result.tests.push({
        specFile, scenarioId, title: t.title, referenced: [], declared: {}, assertions: 0, actions: ['fixme'],
        gates: { syntax_valid: true, dependencies_valid: true, fixtures_valid: true, page_objects_valid: true, assertions_present: false, behavior_covered: false, pr_relevant: true, safe_to_run: true, strategy_valid: false, evidence_source_valid: true },
        executable: false, problems: [`Not implemented (pending): ${pendingCall[2]!.replace(/^PENDING:\s*/, '')}`], semanticReason: null,
      });
      continue;
    }

    // try { ... } catch {} - a failure inside it is swallowed: the test passes whatever happens.
    if (/\bcatch\s*(\(\s*\w*\s*\))?\s*\{\s*(\/\/[^\n]*\s*|\/\*[\s\S]*?\*\/\s*)?\}|\.catch\(\s*\(\s*\w*\s*\)\s*=>\s*(\{\s*\}|undefined|null|false)\s*\)/.test(t.fn.body.getText())) {
      problems.push('Swallows errors (an empty catch): a failure of the steps inside it would not fail the test.');
      branchesOnState = true;
    }
        // if (await x.isVisible()) { ... } - a test that branches on page state can pass doing nothing.
    if (/\bif\s*\(\s*!?\s*\(?\s*await\s+[^)]*\.(isVisible|isEnabled|isHidden|count|isChecked)\s*\(/.test(t.fn.body.getText())) {
      problems.push('Branches on page state (if (await ...isVisible())): it can pass without performing the action or checking the effect.');
      branchesOnState = true;
    }

    const scenario = scenarioId ? ctx.scenarios[scenarioId] : undefined;
    const claim = [t.title.replace(/^\[[^\]]+\]\s*/, ''), scenario?.expectedResult].filter(Boolean).join(' — ');
    const source = t.fn.body.getText();
    // TEST_STRATEGY: what the generator declared, else what the scenario calls for.
    const declaredStrategy = source.match(/\/\/\s*strategy:\s*([A-Z_]+)(?:\s*·\s*evidence:\s*([^\n]+))?/);
    const inferred = classifyScenario({ title: claim, expectedResult: scenario?.expectedResult }, { networkEvidence: (ctx.apiPaths ?? []).length > 0 });
    const strategy = declaredStrategy?.[1] ?? inferred.strategy;
    const evidenceSource = declaredStrategy?.[2]?.trim() ?? inferred.evidence.join(' + ');
    const domEvidence = /\bDOM\b/.test(evidenceSource);
    // A page the beforeEach opened counts as this test's navigation.
    // A flow's journey is what makes the code's conditions (user_email, user_id) true or false: its
    // conditions count as exercised by a test that calls it.
    const flowConditions = (ctx.triggers ?? []).flatMap((tr) => Object.entries(tr.conditions ?? {}).filter(([f]) => calledFlows.has(f)).flatMap(([, c]) => c));
    const semanticSource = flowConditions.length ? `${source}\n/* conditions of the flows it calls: ${flowConditions.join('; ')} */` : source;
    const semanticReason = semanticCheck(claim, { assertions, actions: opensPageFirst && !actions.includes('goto') ? ['goto', ...actions] : actions, source: semanticSource, ...facts }, domEvidence ? null : strategy, ctx.changedTerms ?? []);
    if (semanticReason) problems.push(semanticReason);

    // Against the real backend: qa.stub does nothing, and a destructive click is real.
    const unsafe: string[] = [];
    if (ctx.mockApi === false) {
      const guarded = /test\.skip\(\s*!\s*qa\.mockApi/.test(source);
      const intercepts = /\bpage\.route\s*\(/.test(source);
      if (!guarded && /\bqa\.stub\s*\(/.test(source)) {
        unsafe.push('Relies on qa.stub, which is inactive against the real backend (TEST_MOCK_API=0): its assertions would check the real application instead of the stubbed condition. Guard it with test.skip(!qa.mockApi, ...) or intercept with page.route.');
      }
      const clicked = [...source.matchAll(/getByRole\(\s*['"]button['"]\s*,\s*\{\s*name:\s*(['"`])([^'"`]+)\1[^)]*\)\s*(?:\.\w+\([^)]*\)\s*)*\.(?:click|dblclick|press)\(/g), ...source.matchAll(/getByText\(\s*(['"`])([^'"`]+)\1\s*\)\s*(?:\.\w+\([^)]*\)\s*)*\.click\(/g)].map((m) => m[2]!);
      // Page-object methods named for a destructive action count too: clickApproveAll().
      const poCalls = [...source.matchAll(/\b[a-z]\w*Page\s*\.\s*(\w+)\s*\(/g)].map((m) => m[1]!.replace(/([a-z])([A-Z])/g, '$1 $2'));
      const destructive = [...clicked, ...poCalls].filter((name) => DESTRUCTIVE.test(name));
      // Allowed only when the test intercepts the endpoint of that same action (approve -> approve_all_education).
      const interceptedPatterns = [...source.matchAll(/qa\.intercept\(\s*['"`]\w+['"`]\s*,\s*(['"`])((?:(?!\1).)+)\1/g), ...source.matchAll(/page\.route\(\s*(['"`/])((?:(?!\1).)+)\1/g)].map((m) => m[2]!.toLowerCase());
      const uncovered = destructive.filter((name) => {
        const verb = name.toLowerCase().match(DESTRUCTIVE)?.[1]?.split(' ')[0] ?? '';
        return !interceptedPatterns.some((pat) => pat.includes(verb));
      });
      if (uncovered.length && !guarded) {
        unsafe.push(`Performs ${uncovered.map((d) => `"${d}"`).join(', ')} against the real backend without intercepting that action's own request - that would change shared data.`);
      }
    }
    problems.push(...unsafe);

    // The body must prove the behaviour the way its strategy says.
    const interacted = actions.some((a) => INTERACTIONS.has(a) || a === 'fill' || a === 'flow');
    const intercepted = /\bqa\.intercept\s*\(|\bpage\.route\s*\(|\bqa\.stub\s*\(/.test(source);
    const requirement = (st: string): string | null => {
      switch (st) {
        case 'NETWORK': return facts.requestAssertion ? null : 'NETWORK strategy, but no request is asserted (qa.expectRequestMade / NotMade / Count).';
        case 'UI_AND_NETWORK': return facts.requestAssertion && interacted ? null : 'UI_AND_NETWORK strategy needs a user action and a request assertion.';
        case 'API_MOCK': return intercepted && (facts.requestAssertion || facts.visibilityAssertion || facts.urlAssertion) ? null : 'API_MOCK strategy needs a controlled response (qa.intercept) and an assertion on its effect.';
        case 'UI': case 'DOM_STATE': return facts.visibilityAssertion || facts.urlAssertion ? null : `${strategy} strategy, but nothing shown on the page is asserted.`;
        case 'PAGE_OBJECT': return actions.some((a) => a.includes('.')) ? null : 'PAGE_OBJECT strategy, but no page-object method is used.';
        default: return `${st} is not executable in the Playwright suite.`;
      }
    };
    // A test that proves the behaviour through a neighbouring strategy is relabelled, not blocked:
    // observe + click + expectRequestMade is UI_AND_NETWORK even if it was declared API_MOCK.
    const FAMILY: Record<string, string[]> = {
      API_MOCK: ['UI_AND_NETWORK', 'NETWORK'], NETWORK: ['UI_AND_NETWORK', 'API_MOCK'], UI_AND_NETWORK: ['API_MOCK', 'NETWORK'],
      UI: ['DOM_STATE', 'API_MOCK'], DOM_STATE: ['UI', 'API_MOCK'], PAGE_OBJECT: ['UI'],
    };
    let effectiveStrategy = strategy;
    let strategyProblem = requirement(strategy);
    if (strategyProblem) {
      const alternative = (FAMILY[strategy] ?? []).find((alt) => requirement(alt) === null);
      if (alternative) { effectiveStrategy = alternative; strategyProblem = null; }
    }
    if (strategyProblem) problems.push(strategyProblem);

    // Network patterns must match an endpoint that exists.
    const known = ctx.apiPaths ?? [];
    // intercept/stub(method, pattern, ...), observe(alias, method, pattern), waitForRelevantResponse(pattern)
    const patterns = [
      ...source.matchAll(/qa\.(?:intercept|stub)\(\s*['"`]\w+['"`]\s*,\s*(['"`])((?:(?!\1).)+)\1/g),
      ...source.matchAll(/qa\.observe\(\s*['"`][^'"`]+['"`]\s*,\s*['"`][\w*]+['"`]\s*,\s*(['"`])((?:(?!\1).)+)\1/g),
      ...source.matchAll(/qa\.waitForRelevantResponse\(\s*(['"`])((?:(?!\1).)+)\1/g),
    ].map((m) => m[2]!);
    const matches = (pattern: string) => known.some((p) => { try { return new RegExp(pattern).test(p); } catch { return p.includes(pattern); } });
    const ungrounded = known.length ? patterns.filter((p) => !matches(p)) : [];
    if (ungrounded.length) problems.push(`Observes or intercepts ${ungrounded.map((p) => `"${p}"`).join(', ')}, which matches no endpoint the source or the running application uses.`);

    // An endpoint only a user action sends is never sent by a test that performs no action.
    const userInteractions = actions.filter((a) => INTERACTIONS.has(a) || a === 'fill').length;
    const flowsCalled = [...source.matchAll(FLOW_CALL)].map((m) => m[1]!);
    const aliasPaths = new Map([...source.matchAll(/qa\.observe\(\s*(['"`])([^'"`]+)\1\s*,\s*['"`]\w+['"`]\s*,\s*(['"`])([^'"`]+)\3/g)].map((m) => [m[2]!, m[4]!] as const));
    for (const trig of ctx.triggers ?? []) {
      const matchesTrig = (pat: string) => trig.paths.some((p) => { try { return new RegExp(pat).test(p); } catch { return p.includes(pat); } });
      // What the test waits for: an observed or intercepted pattern, or a flow's own alias (the endpoint's last segment).
      const expects = patterns.some(matchesTrig) || usedAliases.some((a) => trig.paths.some((p) => p.endsWith(`/${a}`)) || matchesTrig(aliasPaths.get(a) ?? '\u0000'));
      if (!expects) continue;
      if (flowsCalled.some((f) => trig.flows.includes(f)) || (!flowsCalled.length && userInteractions >= trig.steps)) continue;
      problems.push(flowsCalled.length
        ? `Expects ${trig.paths[0]}, but none of the flows it calls (${flowsCalled.join(', ')}) leads there - use ${trig.flows.join(' or ')}.`
        : `Expects ${trig.paths[0]}, which the application sends only after the user: ${trig.summary}. ${userInteractions ? `The test performs ${userInteractions} of these ${trig.steps} steps` : 'The test performs none of these steps'}, so the request is never sent - call ${trig.flows.join(' or ')} instead.`);
      branchesOnState = true;
    }

    // What the code says each flow does with a conditional request: a test asserting the opposite
    // tests the wrong journey (it can only fail, or pass for the wrong reason).
    const aliasPattern = (a: string) => aliasPaths.get(a) ?? [...source.matchAll(/qa\.intercept\(\s*['"`]\w+['"`]\s*,\s*(['"`])([^'"`]+)\1[^;]*?(['"`])([\w-]+)\3\s*\)/g)].find((m) => m[4] === a)?.[2] ?? `/${a}`;
    const madeAliases = [...source.matchAll(/qa\.(expectRequestMade\w*|expectRequestCount|waitFor)\(\s*(['"`])([^'"`]+)\2(?:\s*,\s*(\d+))?/g)]
      .filter((m) => m[1] !== 'expectRequestCount' || Number(m[4]) > 0).map((m) => m[3]!);
    const notMadeAliases = [...source.matchAll(/qa\.(expectRequestNotMade\w*|expectNotCalled)\(\s*(['"`])([^'"`]+)\2/g), ...source.matchAll(/qa\.expectRequestCount\(\s*(['"`])([^'"`]+)\1\s*,\s*0\s*\)/g)].map((m) => m[3] ?? m[2]!);
    const hits = (tr: NonNullable<PreflightContext['triggers']>[number], a: string) => { const pat = aliasPattern(a); return tr.paths.some((p) => { try { return new RegExp(pat).test(p) || p.endsWith(`/${a}`); } catch { return p.includes(pat); } }); };
    for (const tr of ctx.triggers ?? []) for (const f of calledFlows) {
      const exp = tr.expected?.[f];
      if (!exp || exp.sent === null) continue;
      if ((exp.sent === false && madeAliases.some((a) => hits(tr, a))) || (exp.sent === true && notMadeAliases.some((a) => hits(tr, a)))) branchesOnState = true;
      if (exp.sent === false && madeAliases.some((a) => hits(tr, a))) problems.push(`Asserts ${tr.paths[0]} is requested after ${f}, but ${exp.why} - pick the journey where the condition holds (${Object.entries(tr.expected ?? {}).filter(([, e]) => e.sent).map(([n]) => n).join(', ') || 'none traced'}).`);
      if (exp.sent === true && notMadeAliases.some((a) => hits(tr, a))) problems.push(`Asserts ${tr.paths[0]} is NOT requested after ${f}, but in that journey the request is ${exp.why} - use a journey where the condition is false (${Object.entries(tr.expected ?? {}).filter(([, e]) => e.sent === false).map(([n]) => n).join(', ') || 'none traced'}).`);
    }
    // A journey that failed its live proof would fail (or search every row until it times out):
    // when a proven journey reaches the same requests with the same outcome, that one is used.
    for (const f of calledFlows) {
      const failed = (ctx.triggers ?? []).find((tr) => tr.proofFailures?.[f]);
      if (!failed) continue;
      const sibling = failed.flows.find((g) => g !== f && failed.proven?.[g] === true
        && (ctx.triggers ?? []).every((tr) => !tr.flows.includes(f) || !tr.expected?.[f] || tr.expected?.[g]?.sent === tr.expected[f]!.sent));
      problems.push(`Calls ${f}, which failed its live proof (${failed.proofFailures![f]!.slice(0, 160)})${sibling ? ` - use ${sibling}, which was proven and leads to the same requests` : ''}.`);
      branchesOnState = true;
    }

    // A scenario about a condition in the code (handleOnSaveSuperSave's user_email && user_id check) is only
    // verified by asserting a request that condition guards.
    const guardedBy = new Map<string, Set<string>>();
    for (const tr of ctx.triggers ?? []) for (const conds of Object.values(tr.conditions ?? {})) for (const c of conds) {
      // The function the condition is in, and the fields it checks (user_email, user_id).
      const fn = c.match(/^(\w+):/)?.[1];
      const fields = [...c.replace(/^[\w.]+:\s*/, '').matchAll(/\.(\w{4,})\b/g)].map((m) => m[1]!);
      for (const key of [fn, ...fields]) if (key) guardedBy.set(key, new Set([...(guardedBy.get(key) ?? []), tr.paths[0]!]));
    }
    const claimLower = claim.toLowerCase();
    const mentioned = (key: string) => new RegExp(`\\b${key}\\b`).test(claim)
      || (key.includes('_') && claimLower.includes(key.replace(/_/g, ' ')));
    const reported = new Set<string>();
    for (const [fn, paths] of guardedBy) {
      if (!mentioned(fn) || !calledFlows.size) continue;
      const pathsKey = [...paths].sort().join();
      if (reported.has(pathsKey)) continue;
      reported.add(pathsKey);
      const asserted = [...madeAliases, ...notMadeAliases].some((a) => [...paths].some((p) => { const pat = aliasPattern(a); try { return new RegExp(pat).test(p) || p.endsWith(`/${a}`); } catch { return false; } }));
      if (!asserted) {
        problems.push(`The scenario is about the condition on ${fn}, which decides whether ${[...paths].join(', ')} ${paths.size > 1 ? 'are' : 'is'} requested, but the test asserts none of ${paths.size > 1 ? 'them' : 'it'} - observe it before the flow and assert it after (qa.expectRequestMadeAfterFlow / qa.expectRequestNotMadeAfterFlow).`);
        branchesOnState = true;
      }
    }

    const terms = (ctx.changedTerms ?? []).filter((x) => x.length >= 4);
    const prRelevant = terms.length === 0 || terms.some((x) => source.includes(x) || claim.includes(x));

    const gates: TestGates = {
      syntax_valid: syntax.length === 0 && redeclared.length === 0,
      dependencies_valid: dependenciesValid && !result.fileProblems.some((p) => p.startsWith('Import')),
      fixtures_valid: fixturesValid,
      page_objects_valid: pageObjectsValid,
      assertions_present: assertions > 0,
      behavior_covered: semanticReason === null && !branchesOnState,
      pr_relevant: prRelevant,
      safe_to_run: unsafe.length === 0,
      strategy_valid: strategyProblem === null,
      evidence_source_valid: ungrounded.length === 0,
    };
    result.tests.push({
      specFile, scenarioId, title: t.title, referenced: [...referenced].sort(), declared, assertions,
      actions: [...new Set(actions)], gates, executable: MANDATORY.every((g) => gates[g]),
      problems: [...new Set(problems)], semanticReason, strategy: effectiveStrategy, evidenceSource,
    });
  }
  return result;
}

/**
 * A scenario the generator was asked to implement but did not: recorded like a
 * test that failed preflight, so the report never silently drops it.
 */
export function notImplemented(
  specFile: string, scenarioId: string, title: string, reason: string,
  extra: { strategy?: string; strategiesAttempted?: { strategy: string; whyNot: string }[] } = {},
): TestDiagnostic {
  return {
    strategy: extra.strategy ?? 'UNIMPLEMENTED', evidenceSource: null, strategiesAttempted: extra.strategiesAttempted ?? [],
    specFile, scenarioId, title: `[${scenarioId}] ${title}`, referenced: [], declared: {}, assertions: 0, actions: [],
    gates: { syntax_valid: true, dependencies_valid: true, fixtures_valid: true, page_objects_valid: true, assertions_present: false, behavior_covered: false, pr_relevant: true, safe_to_run: true, strategy_valid: false, evidence_source_valid: true },
    executable: false, problems: [`Not implemented by the test generator: ${reason}`], semanticReason: null,
  };
}

/** A readable diagnostic, in the shape the report and the logs use. */
export function describeDiagnostic(d: TestDiagnostic): string {
  const lines = [
    `Scenario: ${d.scenarioId ?? '(none)'}`,
    `Title: ${d.title}`,
    `Referenced objects: ${d.referenced.join(', ') || 'none'}`,
    `Declared/imported: ${Object.entries(d.declared).map(([k, v]) => `${k}: ${v}`).join('; ') || 'none'}`,
    `Assertions: ${d.assertions}`,
    `Behavioral actions: ${d.actions.join(', ') || 'none'}`,
    `Semantic coverage: ${d.gates.behavior_covered ? 'PASS' : 'FAIL'}`,
  ];
  if (d.problems.length) lines.push(`Problems: ${d.problems.join(' | ')}`);
  const fixes = [...new Set(d.problems.flatMap((p) => FIXES.filter(([re]) => re.test(p)).map(([, fix]) => fix)))];
  if (fixes.length) lines.push(`How to fix: ${fixes.join(' ')}`);
  return lines.join('\n');
}

/** The concrete correction for each kind of rejection, for the generator's corrected attempt. */
const FIXES: [RegExp, string][] = [
  [/before opening any page/, 'Open the page first (page.goto(route) or pageObject.goto()) before any click or fill.'],
  [/never shows the application requested it/, 'After the navigation or action that triggers it, await qa.expectRequestMade(\'<alias>\') for each intercepted alias.'],
  [/NOT made without performing any action/, 'qa.observe the endpoint, then perform the user action that runs the changed code (click the control that calls the handler), and only then assert expectRequestNotMade / expectRequestCount. If no such control appears in the evidence, list the scenario under "unimplemented" instead.'],
  [/does not verify any request/, 'qa.observe the endpoint named in API CALLS, perform the triggering action, then assert qa.expectRequestMade / expectRequestCount (or expect(qa.lastRequest(alias)...)).'],
  [/names a locator .* does not define|is not a locator of/, 'Use only locators the page object defines, or return the page object with that locator added (selector taken from the evidence), or use page.getByRole / getByText with a label from the evidence.'],
  [/Branches on page state/, 'Remove the if (await ...isVisible()) branch: perform the action unconditionally so the test fails when the control is missing.'],
  [/never asserts that the error or notification is shown/, 'Assert the error is shown with await qa.expectErrorShown().'],
  [/does not assert what is rendered/, 'Assert the rendered effect: expect(locator).toBeVisible() / toHaveCount(n) / toHaveText(...).'],
  [/never navigates to or interacts with the application|only navigates to the page/, 'Open the page, perform the action the scenario is about, and assert its effect.'],
  [/asserts nothing/, 'Add an assertion on the effect the scenario claims.'],
  [/which the application sends only after the user|none of the flows it calls/, 'Do not write the steps yourself: construct the flows class (const xFlows = new XFlows(page, qa) is added for you when you use its lowerCamelCase name), set up qa.observe / qa.intercept, call the flow that leads to the request, then assert.'],
  [/pick the journey where the condition holds|use a journey where the condition is false/, 'Each flow in FLOWS says, per request, whether it is expected in that journey: assert "made" only after a journey where it is expected, and "NOT made" only after one where it is not.'],
  [/The scenario is about the condition on/, 'qa.observe the guarded request, call the journey the scenario describes, and assert it with qa.expectRequestMadeAfterFlow / qa.expectRequestNotMadeAfterFlow as the FLOWS section says for that journey.'],
  [/Swallows errors/, 'Remove the try/catch (or .catch(() => {})): let a failing step fail the test.'],
  [/which failed its live proof/, 'Call the proven journey named in the problem instead; keep the rest of the test.'],
  [/Relies on qa\.stub/, 'Use qa.intercept(method, pattern, response, alias) - it answers the request against the real backend too.'],
  [/which the application's source gives to several different elements/, 'Locate the control by role and its visible name (page.getByRole(\'button\', { name: ... })) or its own label, not by the shared id.'],
  [/element chosen by tag alone/, 'Select the control by role and accessible name (page.getByRole(\'button\', { name: ... })), a label, a test id or an id from the evidence.'],
  [/never shows the application requested it|expected a request aliased/, 'If API CALLS says "sent when the user: ...", perform every step of it (open the dialog, fill it, submit, confirm) before asserting.'],
];
