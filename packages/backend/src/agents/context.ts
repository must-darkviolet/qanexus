/**
 * Prompt context construction (spec sections 4 and 26).
 *
 * "Do not send the entire repository blindly to the AI... Then provide
 * relevant context to the AI."
 *
 * Every function here renders *structured findings*, not source code, and
 * every list is capped. A 5,000-file repository and a 50-file repository
 * produce prompts of a similar size.
 */
import type { StaticAnalysis } from '@qa-agent/shared';
import { bulletList, truncate } from './base.js';
import { sanitizeForAi } from '../analysis/secrets.js';
import { env } from '../config/env.js';
import { rankTests, type RelevanceSubject } from './relevance.js';

export interface FeatureSlice {
  key: string;
  name: string;
  routes: string[];
  components: string[];
  files: string[];
  apis: string[];
}

/** A compact, repo-wide overview - used by RepositoryAnalyzer. */
export function renderRepositoryOverview(analysis: StaticAnalysis, opts?: { maxChars?: number }): string {
  const sections: string[] = [];

  sections.push(`FRAMEWORK: ${analysis.framework}${analysis.usesTypeScript ? ' (TypeScript)' : ' (JavaScript)'}`);
  if (analysis.packageName) sections.push(`PACKAGE NAME: ${analysis.packageName}`);

  const notableDeps = Object.keys(analysis.dependencies)
    .filter((d) => !/^@types\//.test(d))
    .slice(0, 40);
  sections.push(`DEPENDENCIES (${Object.keys(analysis.dependencies).length} total):\n${bulletList(notableDeps, 40)}`);

  if (analysis.readme) {
    sections.push(`README (truncated):\n${truncate(sanitizeForAi(analysis.readme), 3000, 'README')}`);
  }
  if (analysis.docs.length) {
    sections.push(`DOCUMENTATION FILES:\n${bulletList(analysis.docs.map((d) => d.file), 15)}`);
  }

  sections.push(`ROUTES (${analysis.routes.length}):\n${bulletList(
    analysis.routes.map((r) => `${r.path} [${r.kind}] -> ${r.file}${r.requiresAuth ? ' (auth required)' : ''}${r.guardedByRoles.length ? ` roles: ${r.guardedByRoles.join(',')}` : ''}`),
    70,
  )}`);

  const pageComponents = analysis.components.filter((c) => c.kind === 'page' || c.kind === 'component');
  sections.push(`COMPONENTS (${analysis.components.length} total, showing pages and components):\n${bulletList(
    pageComponents.map((c) => `${c.name} (${c.kind}) ${c.file}${c.forms.length ? ` forms:${c.forms.length}` : ''}${c.callsApis.length ? ` apis:${c.callsApis.join('|')}` : ''}`),
    70,
  )}`);

  sections.push(`API CALLS (${analysis.apis.length}):\n${bulletList(
    analysis.apis.map((a) => `${a.method} ${a.path} (${a.file})${a.errorCodes.length ? ` handles:${a.errorCodes.join(',')}` : ''}`),
    60,
  )}`);

  sections.push(`ENTITIES / TYPES (${analysis.entities.length}):\n${bulletList(
    analysis.entities.map((e) => `${e.name} [${e.kind}] fields: ${e.fields.slice(0, 10).map((f) => f.name).join(', ')}`),
    40,
  )}`);

  sections.push(`ROLES (${analysis.roles.length}):\n${bulletList(
    analysis.roles.map((r) => `${r.name}${r.permissions.length ? ` -> ${r.permissions.join(', ')}` : ''}`), 30,
  )}`);

  sections.push(`STATUS VALUES / STATE MACHINES:\n${bulletList(
    analysis.stateMachines.map((s) => `${s.entity}: ${s.states.join(' | ')}${s.transitions.length ? ` (${s.transitions.length} observed transitions)` : ''}`),
    25,
  )}`);

  sections.push(`BUSINESS CONSTANTS:\n${bulletList(
    analysis.constants.map((c) => `${c.name} = ${c.value}`), 30,
  )}`);

  sections.push(`EXISTING TEST FILES (${analysis.existingTests.length}):\n${bulletList(
    analysis.existingTests.map((t) => `${t.file} [${t.kind}]${t.titles.length ? ` ${t.titles.length} tests` : ''}`), 30,
  )}`);

  if (analysis.excludedForSecrets.length) {
    sections.push(`NOTE: ${analysis.excludedForSecrets.length} file(s) were excluded from analysis because they may contain secrets. Their contents were never read.`);
  }

  return truncate(sections.join('\n\n'), opts?.maxChars ?? 28_000, 'repository overview');
}

/** Evidence for one feature - used by BusinessRuleAnalyzer and ScenarioGenerator. */
export function renderFeatureEvidence(analysis: StaticAnalysis, feature: FeatureSlice, opts?: { maxChars?: number }): string {
  const fileSet = new Set(feature.files);
  const sections: string[] = [`FEATURE: ${feature.name} (key: ${feature.key})`];

  const routes = analysis.routes.filter((r) => feature.routes.includes(r.path) || fileSet.has(r.file));
  sections.push(`ROUTES:\n${bulletList(routes.map((r) =>
    `${r.path} [${r.kind}] file=${r.file} auth=${r.requiresAuth ? 'yes' : 'unknown'}${r.guardedByRoles.length ? ` roles=${r.guardedByRoles.join(',')}` : ''}`,
  ), 25)}`);

  const components = analysis.components.filter((c) => fileSet.has(c.file) || feature.components.includes(c.name));
  const formLines: string[] = [];
  const elementLines: string[] = [];
  const stateLines: string[] = [];
  for (const c of components) {
    for (const form of c.forms) {
      for (const field of form.fields) {
        formLines.push(
          `${c.name}${form.name ? `/${form.name}` : ''}.${field.name} type=${field.inputType ?? '?'}` +
          `${field.required ? ' required' : ''}${field.validation.length ? ` constraints=[${field.validation.join(', ')}]` : ''}` +
          `${field.selector ? ` selector=${field.selector}` : ''}`,
        );
      }
    }
    for (const el of c.elements.slice(0, 15)) {
      elementLines.push(`${c.name}: ${el.kind}${el.label ? ` "${el.label}"` : ''} selector=${el.selector ?? 'none'} (${el.selectorStrategy ?? 'none'})`);
    }
    if (c.loadingStates.length) stateLines.push(`${c.name} loading: ${c.loadingStates.slice(0, 3).join(' | ')}`);
    if (c.errorStates.length) stateLines.push(`${c.name} error: ${c.errorStates.slice(0, 3).join(' | ')}`);
    if (c.emptyStates.length) stateLines.push(`${c.name} empty: ${c.emptyStates.slice(0, 3).join(' | ')}`);
  }

  sections.push(`COMPONENTS:\n${bulletList(components.map((c) => `${c.name} (${c.kind}) ${c.file}`), 30)}`);
  sections.push(`FORM FIELDS AND THEIR CONSTRAINTS:\n${bulletList(formLines, 60)}`);
  sections.push(`INTERACTIVE ELEMENTS AND AVAILABLE SELECTORS:\n${bulletList(elementLines, 60)}`);
  sections.push(`UI STATES OBSERVED IN CONDITIONAL RENDERING:\n${bulletList(stateLines, 30)}`);

  const apis = analysis.apis.filter((a) => fileSet.has(a.file) || feature.apis.includes(`${a.method} ${a.path}`));
  sections.push(`API CALLS:\n${bulletList(apis.map((a) =>
    `${a.method} ${a.path} file=${a.file}${a.requestShape ? ` body=${a.requestShape.slice(0, 120)}` : ''}${a.errorCodes.length ? ` handled_status=[${a.errorCodes.join(', ')}]` : ''}`,
  ), 30)}`);

  const validations = analysis.validations.filter((v) => fileSet.has(v.file));
  sections.push(`VALIDATION RULES DECLARED IN CODE (these are OBSERVED facts):\n${bulletList(validations.map((v) =>
    `${v.entity ? `${v.entity}.` : ''}${v.field}: ${v.rule}${v.message ? ` message="${v.message}"` : ''} [${v.library}] ${v.file}:${v.line ?? '?'}`,
  ), 60)}`);

  const permissions = analysis.permissionChecks.filter((p) => fileSet.has(p.file));
  sections.push(`AUTHORIZATION CHECKS FOUND IN CODE (OBSERVED):\n${bulletList(permissions.map((p) =>
    `${p.file}:${p.line ?? '?'} if (${p.expression})${p.guards ? ` then ${p.guards.slice(0, 80)}` : ''}${p.roles.length ? ` roles=[${p.roles.join(', ')}]` : ''}`,
  ), 40)}`);

  const machines = analysis.stateMachines.filter((s) => fileSet.has(s.file));
  sections.push(`STATE MACHINES:\n${bulletList(machines.map((s) =>
    `${s.entity}: states=[${s.states.join(', ')}] transitions=[${s.transitions.map((t) => `${t.from}->${t.to}`).join(', ') || 'none observed'}]`,
  ), 20)}`);

  const entities = analysis.entities.filter((e) => fileSet.has(e.file));
  sections.push(`TYPES:\n${bulletList(entities.map((e) =>
    `${e.name}: ${e.fields.slice(0, 15).map((f) => `${f.name}${f.optional ? '?' : ''}:${f.type}`).join(', ')}`,
  ), 25)}`);

  const errors = analysis.errorHandling.filter((e) => fileSet.has(e.file));
  sections.push(`ERROR HANDLING:\n${bulletList(errors.map((e) => `${e.file}: ${e.detail}`), 20)}`);

  return truncate(sanitizeForAi(sections.join('\n\n')), opts?.maxChars ?? 16_000, 'feature evidence');
}

/**
 * Existing test infrastructure - used by TestGenerator (spec section 14).
 *
 * With a subject (the feature being generated), only the specs, page objects
 * and fixtures related to it are listed, capped at AI_MAX_TESTS_PER_REQUEST;
 * custom commands are always listed because they are few and apply everywhere.
 */
export function renderExistingTestInfrastructure(
  analysis: StaticAnalysis,
  opts?: { maxChars?: number; subject?: RelevanceSubject; maxTests?: number },
): string {
  if (analysis.existingTests.length === 0) {
    return 'EXISTING TEST INFRASTRUCTURE: none found. You are creating the first tests for this repository.';
  }
  const sections: string[] = ['EXISTING TEST INFRASTRUCTURE IN THE REPOSITORY (reuse its selectors and flows, do not duplicate its tests):'];
  const maxTests = opts?.maxTests ?? env.AI_MAX_TESTS_PER_REQUEST;
  const pick = (kind: string, max: number) => {
    const all = analysis.existingTests.filter((t) => t.kind === kind);
    return opts?.subject ? rankTests(all, opts.subject, max) : { selected: all.slice(0, max), skipped: Math.max(0, all.length - max) };
  };
  const more = (n: number, what: string) => (n ? `\n  (${n} unrelated ${what} not shown)` : '');

  const pageObjects = pick('page_object', Math.min(maxTests, 25));
  const specs = pick('spec', maxTests);
  const fixtures = pick('fixture', Math.min(maxTests, 25));
  const commands = [...new Set(analysis.existingTests.flatMap((t) => t.commands))];
  const selectors = [...new Set([...specs.selected, ...pageObjects.selected].flatMap((t) => t.selectorsUsed))];

  sections.push(`PAGE OBJECTS:\n${bulletList(pageObjects.selected.map((p) => `${p.file} exports: ${p.pageObjects.join(', ') || '(unnamed)'}`), 25)}${more(pageObjects.skipped, 'page objects')}`);
  if (commands.length) {
    sections.push(`CYPRESS CUSTOM COMMANDS (not callable from Playwright; their behaviour shows how the app is driven, e.g. how login works):\n${bulletList(commands.map((c) => `cy.${c}()`), 25)}`);
  }
  sections.push(`FIXTURES:\n${bulletList(fixtures.selected.map((f) => f.file), 25)}${more(fixtures.skipped, 'fixtures')}`);
  sections.push(`RELATED SPECS AND THEIR TESTS (do not duplicate these):\n${bulletList(
    specs.selected.flatMap((s) => [`${s.file}:`, ...s.titles.slice(0, 12).map((t) => `    "${t}"`)]), 90,
  )}${more(specs.skipped, 'specs')}`);
  sections.push(`SELECTORS ALREADY IN USE (prefer consistency with these):\n${bulletList(selectors, 50)}`);

  return truncate(sections.join('\n\n'), opts?.maxChars ?? 10_000, 'existing tests');
}

/**
 * Keeps the parts of a unified diff a reviewer reads: hunk headers, changed
 * lines and one line of context either side. Git's default three context
 * lines roughly triple the size of a small change for little extra meaning.
 */
export function compactPatch(patch: string, context = 1): string {
  const lines = patch.split('\n');
  const keep = new Set<number>();
  lines.forEach((line, i) => {
    if (line.startsWith('@@')) { keep.add(i); return; }
    if ((line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---')) {
      for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep.add(j);
    }
  });
  const out: string[] = [];
  let last = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (last !== -1 && i > last + 1 && !lines[i]!.startsWith('@@')) out.push(' ...');
    out.push(lines[i]!);
    last = i;
  }
  return out.join('\n');
}

/** The repository diff - used by ChangeAnalyzer. */
export function renderDiff(diff: {
  previousCommitSha: string | null; currentCommitSha: string;
  files: { path: string; status: string; additions: number; deletions: number; patch?: string }[];
  changedFunctions: { file: string; name: string; change: string }[];
  changedComponents: string[];
  changedRoutes: { path: string; change: string }[];
  changedApis: { method: string; path: string; change: string }[];
  changedValidations: { field: string; file: string; change: string }[];
  commits: { sha: string; message: string; author: string; date: string }[];
}, opts?: { maxChars?: number; maxPatchFiles?: number }): string {
  const sections: string[] = [
    `COMPARING ${diff.previousCommitSha?.slice(0, 8) ?? '(first analysis)'} -> ${diff.currentCommitSha.slice(0, 8)}`,
  ];

  sections.push(`COMMIT MESSAGES:\n${bulletList(diff.commits.map((c) => `${c.sha.slice(0, 8)} ${c.message.split('\n')[0]} (${c.author})`), 25)}`);
  sections.push(`CHANGED FILES (${diff.files.length}):\n${bulletList(
    diff.files.map((f) => `${f.status.toUpperCase().padEnd(8)} ${f.path} (+${f.additions}/-${f.deletions})`), 60,
  )}`);
  sections.push(`CHANGED FUNCTIONS/COMPONENTS:\n${bulletList(
    diff.changedFunctions.map((f) => `${f.change}: ${f.name} in ${f.file}`), 60,
  )}`);
  sections.push(`CHANGED ROUTES:\n${bulletList(diff.changedRoutes.map((r) => `${r.change}: ${r.path}`), 25)}`);
  sections.push(`CHANGED API CALLS:\n${bulletList(diff.changedApis.map((a) => `${a.change}: ${a.method} ${a.path}`), 25)}`);
  sections.push(`CHANGED VALIDATION RULES:\n${bulletList(
    diff.changedValidations.map((v) => `${v.change}: ${v.field} in ${v.file}`), 40,
  )}`);

  // Patches are the most token-expensive part, so only the most relevant few,
  // compacted, sharing whatever the structural summary above left of the budget.
  const maxChars = opts?.maxChars ?? env.AI_MAX_DIFF_CHARS;
  const candidates = diff.files.filter((f) => f.patch && /\.[jt]sx?$/.test(f.path));
  const patchFiles = candidates
    .sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions))
    .slice(0, opts?.maxPatchFiles ?? env.AI_MAX_FILES_PER_REQUEST);
  if (patchFiles.length) {
    const skipped = candidates.length - patchFiles.length;
    const header = `RELEVANT DIFFS (compacted${skipped ? `; ${skipped} smaller patch(es) not shown, see CHANGED FILES` : ''}):`;
    const room = maxChars - sections.join('\n\n').length - header.length - 100;
    const perPatch = Math.max(600, Math.min(4000, Math.floor(room / patchFiles.length) - 80));
    sections.push(`${header}\n${patchFiles.map((f) => `--- ${f.path} ---\n${truncate(compactPatch(f.patch!), perPatch, 'patch')}`).join('\n\n')}`);
  }

  return truncate(sanitizeForAi(sections.join('\n\n')), maxChars, 'diff');
}
