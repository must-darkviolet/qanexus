/**
 * Change-impact analysis.
 *
 *   Changed files -> Affected components -> Affected functionality
 *     -> Related tests -> Potential coverage gaps -> Recommended regression
 *
 * Everything here is deterministic and derived from recorded structure: the
 * static analysis, the feature map, the traceability graph and the tests that
 * exist. Each link carries the reason it was drawn, so "why is this affected?"
 * always has an answer a reviewer can check. The AI layer (RegressionAdvisor)
 * adds reasoning on top of this; it never replaces it.
 */
import type {
  AffectedFeature, CoverageGap, ExistingTestInfo, FeatureInfo, HistoricalFinding,
  ImpactReport, ImpactRisk, ImpactSource, ImpactTrace, Priority, RegressionRecommendation,
  RelatedTest, RepositoryDiff, StaticAnalysis,
} from '@qa-agent/shared';
import { shouldForceFullRegression } from '../agents/regressionSelector.js';
import { sha256 } from '../util/ids.js';
import type { StoredBusinessRule, StoredScenario, TraceLink } from './store.js';

export interface GeneratedTestRef {
  specFile: string;
  featureKey: string;
  scenarioKeys: string[];
  lastOutcome: string | null;
}

export interface ComputeImpactInput {
  source: ImpactSource;
  diff: RepositoryDiff;
  analysis: StaticAnalysis;
  features: FeatureInfo[];
  rules: StoredBusinessRule[];
  scenarios: StoredScenario[];
  traces: TraceLink[];
  generatedTests: GeneratedTestRef[];
  historicalFindings?: HistoricalFinding[];
  /** file -> files that import it (see analysis/imports.ts). */
  importedBy?: Record<string, string[]>;
}

const RISK_ORDER: Record<ImpactRisk, number> = { high: 3, medium: 2, low: 1 };
const maxRisk = (a: ImpactRisk, b: ImpactRisk): ImpactRisk => (RISK_ORDER[a] >= RISK_ORDER[b] ? a : b);
const riskToPriority = (risk: ImpactRisk): Priority => (risk === 'high' ? 'high' : risk === 'medium' ? 'medium' : 'low');

const NON_BEHAVIOURAL = /\.(md|mdx|txt|css|scss|sass|less|svg|png|jpe?g|gif|ico|lock)$/i;
const SENSITIVE = /(auth|session|permission|role|guard|middleware|login|security|payment|checkout)/i;

/** Next-style dynamic segments ([id], :id) become wildcards for matching. */
function routeMatcher(route: string): RegExp {
  const pattern = route
    .split('/')
    .map((segment) => {
      if (/^:[A-Za-z_]\w*\*$/.test(segment) || /^\[\.\.\.[^\]]+\]$/.test(segment) || /^\[\[\.\.\.[^\]]+\]\]$/.test(segment)) return '.*';
      if (/^:[A-Za-z_]\w*$/.test(segment) || /^\[[^\]]+\]$/.test(segment)) return '[^/]+';
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return new RegExp(`^${pattern}/?(\\?.*)?$`);
}

function visitMatchesRoute(visit: string, route: string): boolean {
  const path = visit.replace(/^https?:\/\/[^/]+/, '').split('#')[0] || '/';
  try { return routeMatcher(route).test(path); } catch { return path === route; }
}

/**
 * Walks "who renders this component" upwards, so a change to a leaf component
 * reaches the pages (and therefore the routes) that show it.
 */
function dependentsOf(names: string[], analysis: StaticAnalysis, depth = 3): { name: string; file: string }[] {
  const found = new Map<string, string>();
  let frontier = new Set(names);
  for (let level = 0; level < depth && frontier.size > 0; level++) {
    const next = new Set<string>();
    for (const component of analysis.components) {
      if (found.has(component.name) || names.includes(component.name)) continue;
      if (component.usesComponents.some((used) => frontier.has(used))) {
        found.set(component.name, component.file);
        next.add(component.name);
      }
    }
    frontier = next;
  }
  return [...found.entries()].map(([name, file]) => ({ name, file }));
}

/**
 * One field often carries several constraints, and a rewritten rule shows up
 * as removed + added. Collapse to one entry per field and file.
 */
function collapseValidations(items: RepositoryDiff['changedValidations']) {
  const byKey = new Map<string, { field: string; file: string; change: string }>();
  for (const v of items) {
    // Keyed on the field alone: callers pass one file (or a file and its
    // pre-rename path), and a rename must not read as "removed + added".
    const key = v.field;
    const prev = byKey.get(key);
    byKey.set(key, { field: v.field, file: v.file, change: !prev || prev.change === v.change ? v.change : 'modified' });
  }
  return [...byKey.values()];
}

/** Files that import `file`, directly or through up to `depth` hops. */
function importersOf(file: string, importedBy: Record<string, string[]>, depth = 3): string[] {
  const found = new Set<string>();
  let frontier = [file];
  for (let level = 0; level < depth && frontier.length; level++) {
    const next: string[] = [];
    for (const f of frontier) {
      for (const importer of importedBy[f] ?? []) {
        if (importer === file || found.has(importer) || /\.(cy|spec|test)\.[jt]sx?$/.test(importer)) continue;
        found.add(importer);
        next.push(importer);
      }
    }
    frontier = next;
    if (found.size > 60) break;
  }
  return [...found];
}

function pushTest(list: RelatedTest[], test: RelatedTest): void {
  const existing = list.find((t) => t.file === test.file);
  if (!existing) { list.push(test); return; }
  if (!existing.why.includes(test.why)) existing.why = `${existing.why}; ${test.why}`;
}

/** A remembered reference that names a test file, rather than a scenario or a rule. */
export function isSpecFile(reference: string): boolean {
  return /\.(spec|test|cy)\.[jt]sx?$/.test(reference);
}

export function computeImpact(input: ComputeImpactInput): ImpactReport {
  const { diff, analysis, features, rules, scenarios, traces, generatedTests } = input;
  const history = input.historicalFindings ?? [];
  const existingSpecs = analysis.existingTests.filter((t) => t.kind === 'spec');
  const componentsByFile = groupBy(analysis.components, (c) => c.file);
  const routesByFile = groupBy(analysis.routes, (r) => r.file);
  const apisByFile = groupBy(analysis.apis, (a) => a.file);

  const traces_: ImpactTrace[] = [];

  for (const file of diff.files) {
    const paths = file.previousPath ? [file.path, file.previousPath] : [file.path];
    const reasoning: string[] = [];
    let risk: ImpactRisk = NON_BEHAVIOURAL.test(file.path) ? 'low' : 'medium';

    const changedSymbols = diff.changedFunctions
      .filter((f) => paths.includes(f.file))
      .map((f) => ({ name: f.name, change: f.change }));
    if (changedSymbols.length) {
      reasoning.push(`Changed declarations: ${changedSymbols.slice(0, 8).map((s) => `${s.name} (${s.change})`).join(', ')}.`);
    }

    // Constants such as TASK_TITLE_MIN are extracted alongside components but
    // are not something a user sees; they are reported as changed symbols.
    const declared = paths.flatMap((p) => componentsByFile.get(p) ?? []).map((c) => c.name);
    const components = declared.filter((n) => !/^[A-Z0-9_]+$/.test(n));
    // Dependency tracing uses every declaration, constants included: a page
    // that imports TASK_TITLE_MIN is affected when that limit changes.
    const dependents = dependentsOf(declared, analysis);
    if (components.length) reasoning.push(`Defines component(s) ${components.slice(0, 6).join(', ')}.`);
    if (dependents.length) {
      reasoning.push(`Used or rendered by ${dependents.length} other component(s): ${dependents.slice(0, 6).map((d) => d.name).join(', ')}.`);
    }

    const importers = input.importedBy ? paths.flatMap((p) => importersOf(p, input.importedBy!)) : [];
    if (importers.length) {
      reasoning.push(`Imported by ${importers.length} file(s): ${importers.slice(0, 5).join(', ')}${importers.length > 5 ? ', ...' : ''}.`);
      for (const importer of importers) {
        for (const c of componentsByFile.get(importer) ?? []) {
          if (!/^[A-Z0-9_]+$/.test(c.name) && !dependents.some((d) => d.name === c.name) && !declared.includes(c.name)) {
            dependents.push({ name: c.name, file: importer });
          }
        }
      }
    }
    const impactedFiles = new Set([...paths, ...dependents.map((d) => d.file), ...importers]);
    const routes = [...new Set([...impactedFiles].flatMap((p) => routesByFile.get(p) ?? []).map((r) => r.path))];
    if (routes.length) reasoning.push(`Reachable on route(s) ${routes.slice(0, 6).join(', ')}.`);

    const apis = [...new Set(paths.flatMap((p) => apisByFile.get(p) ?? []).map((a) => `${a.method} ${a.path}`))];
    const changedApis = diff.changedApis.filter((a) => apis.includes(`${a.method} ${a.path}`) || paths.some((p) => (apisByFile.get(p) ?? []).some((x) => x.path === a.path)));
    if (apis.length) reasoning.push(`Calls API(s) ${apis.slice(0, 5).join(', ')}.`);
    if (changedApis.length) {
      risk = 'high';
      reasoning.push(`API usage changed: ${changedApis.map((a) => `${a.change} ${a.method} ${a.path}`).join(', ')}.`);
    }

    const validations = collapseValidations(diff.changedValidations.filter((v) => paths.includes(v.file)));
    if (validations.length) {
      risk = 'high';
      reasoning.push(`Validation rules changed for field(s) ${validations.map((v) => `${v.field} (${v.change})`).join(', ')}.`);
    }
    const routeChanges = diff.changedRoutes.filter((r) => routes.includes(r.path) || paths.some((p) => (routesByFile.get(p) ?? []).some((x) => x.path === r.path)));
    if (routeChanges.length) {
      risk = 'high';
      reasoning.push(`Route(s) ${routeChanges.map((r) => `${r.path} ${r.change}`).join(', ')}.`);
    }
    if (SENSITIVE.test(file.path)) {
      risk = 'high';
      reasoning.push('Path suggests authentication, authorization or another sensitive flow.');
    }
    if (dependents.length >= 3) {
      risk = maxRisk(risk, 'high');
      reasoning.push('Shared by several components, so a regression would surface in more than one place.');
    }

    const touchedFeatures = features.filter((f) =>
      f.files.some((ff) => impactedFiles.has(ff))
      || f.components.some((c) => components.includes(c))
      || f.routes.some((r) => routes.includes(r)),
    );
    if (touchedFeatures.length) {
      reasoning.push(`Belongs to feature(s) ${touchedFeatures.map((f) => f.name).join(', ')} in the application map.`);
    }

    const relatedRules = rules.filter((r) => r.relatedFiles.some((rf) => paths.includes(rf)));
    if (relatedRules.length) {
      risk = maxRisk(risk, relatedRules.some((r) => r.category === 'authorization' || r.category === 'validation') ? 'high' : 'medium');
      reasoning.push(`Evidence for business rule(s) ${relatedRules.slice(0, 5).map((r) => r.id).join(', ')}.`);
    }

    /* ---- related tests ------------------------------------------------ */
    const relatedTests: RelatedTest[] = [];
    for (const trace of traces) {
      if (!trace.specFile || !paths.includes(trace.sourceFile)) continue;
      const generated = generatedTests.find((g) => g.specFile === trace.specFile);
      pushTest(relatedTests, {
        file: trace.specFile,
        origin: generated ? 'generated' : 'existing',
        titles: [],
        why: `Traceability: ${trace.sourceFile}${trace.scenarioKey ? ` → scenario ${trace.scenarioKey}` : ''} → ${trace.specFile}`,
        lastOutcome: generated?.lastOutcome ?? null,
      });
    }
    for (const feature of touchedFeatures) {
      for (const test of generatedTests.filter((g) => g.featureKey === feature.key)) {
        pushTest(relatedTests, {
          file: test.specFile, origin: 'generated', titles: [],
          why: `Covers feature ${feature.name}`, lastOutcome: test.lastOutcome,
        });
      }
    }
    for (const spec of existingSpecs) {
      const why = existingSpecReason(spec, { paths, routes, components, analysis });
      if (why) pushTest(relatedTests, { file: spec.file, origin: 'existing', titles: spec.titles.slice(0, 8), why, lastOutcome: null });
    }

    if (relatedTests.length === 0 && risk !== 'low') {
      reasoning.push('No existing or generated test is linked to this file.');
    }

    traces_.push({
      file: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changedSymbols,
      components,
      dependentComponents: dependents.map((d) => d.name),
      routes,
      apis,
      features: touchedFeatures.map((f) => ({ key: f.key, name: f.name })),
      relatedTests,
      risk,
      reasoning,
    });
  }

  /* ---- a removed route breaks every test that visits it ---------------- */
  const testsNeedingUpdate: { file: string; route: string }[] = [];
  for (const route of diff.changedRoutes.filter((r) => r.change === 'removed')) {
    for (const spec of existingSpecs) {
      if (spec.visits.some((v) => visitMatchesRoute(v, route.path))) testsNeedingUpdate.push({ file: spec.file, route: route.path });
    }
  }

  /* ---- affected features ----------------------------------------------- */
  const affected = new Map<string, AffectedFeature>();
  for (const trace of traces_) {
    for (const feature of trace.features) {
      const entry = affected.get(feature.key) ?? {
        key: feature.key, name: feature.name, risk: 'low' as ImpactRisk,
        changedFiles: [], reasons: [], relatedTests: [],
        scenarioCount: scenarios.filter((s) => s.feature === feature.key && !s.isObsolete).length,
        rulesAffected: 0,
      };
      entry.risk = maxRisk(entry.risk, trace.risk);
      entry.changedFiles.push(trace.file);
      const firstReason = trace.reasoning.find((r) => !r.startsWith('Belongs to feature'));
      if (firstReason) entry.reasons.push(`${trace.file}: ${firstReason}`);
      for (const test of trace.relatedTests) {
        // A generated spec belongs to one feature; do not credit it to another.
        const owner = generatedTests.find((g) => g.specFile === test.file)?.featureKey;
        if (owner && owner !== feature.key && features.some((f) => f.key === owner)) continue;
        pushTest(entry.relatedTests, { ...test });
      }
      affected.set(feature.key, entry);
    }
  }
  for (const entry of affected.values()) {
    entry.rulesAffected = rules.filter((r) => r.feature === entry.key
      && r.relatedFiles.some((f) => entry.changedFiles.includes(f))).length;
    entry.reasons = [...new Set(entry.reasons)].slice(0, 6);
  }
  const affectedFeatures = [...affected.values()].sort((a, b) => RISK_ORDER[b.risk] - RISK_ORDER[a.risk]);

  /* ---- coverage -------------------------------------------------------- */
  const allRelated: RelatedTest[] = [];
  for (const trace of traces_) for (const test of trace.relatedTests) pushTest(allRelated, { ...test });
  const gaps: CoverageGap[] = [];

  for (const feature of affectedFeatures) {
    if (feature.relatedTests.length === 0) {
      gaps.push({
        feature: feature.key, subject: feature.name, kind: 'no_tests',
        reason: `Feature is affected by this change but no existing or generated test covers it.`,
      });
    }
    const featureRules = rules.filter((r) => r.feature === feature.key);
    for (const rule of featureRules) {
      const verified = scenarios.some((s) => !s.isObsolete && s.businessRuleIds.includes(rule.id));
      if (!verified && rule.relatedFiles.some((f) => feature.changedFiles.includes(f))) {
        gaps.push({
          feature: feature.key, subject: `${rule.id}: ${rule.description}`, kind: 'rule_untested',
          reason: 'A business rule whose evidence changed has no scenario verifying it.',
        });
      }
    }
    for (const test of feature.relatedTests.filter((t) => t.origin === 'generated' && t.lastOutcome !== 'passed')) {
      gaps.push({
        feature: feature.key, subject: test.file, kind: 'never_passed',
        reason: test.lastOutcome ? `Last recorded outcome was "${test.lastOutcome}", so it cannot vouch for this area.` : 'This spec has never been executed.',
      });
    }
  }
  for (const trace of traces_) {
    if (trace.relatedTests.length === 0 && trace.risk !== 'low' && trace.features.length === 0) {
      gaps.push({
        feature: null, subject: trace.file, kind: 'changed_without_test',
        reason: trace.changedSymbols.length
          ? `Behavioural change (${trace.changedSymbols.length} declaration(s)) with no linked test or feature.`
          : 'Changed file with no linked test or feature.',
      });
    }
  }
  for (const route of diff.changedRoutes.filter((r) => r.change === 'added')) {
    const visited = existingSpecs.some((s) => s.visits.some((v) => visitMatchesRoute(v, route.path)))
      || traces_.some((tr) => tr.routes.includes(route.path) && tr.relatedTests.some((t) => t.origin === 'generated'));
    if (!visited) {
      gaps.push({ feature: null, subject: route.path, kind: 'route_untested', reason: 'New route that no test visits.' });
    }
  }
  for (const api of diff.changedApis.filter((a) => a.change !== 'removed')) {
    const tested = traces_.some((t) => t.apis.includes(`${api.method} ${api.path}`) && t.relatedTests.length > 0);
    if (!tested) {
      gaps.push({ feature: null, subject: `${api.method} ${api.path}`, kind: 'api_unexercised', reason: `API call ${api.change} with no related test.` });
    }
  }

  const seenGaps = new Set<string>();
  const uniqueGaps = gaps.filter((g) => {
    const key = `${g.kind}|${g.subject}`;
    if (seenGaps.has(key)) return false;
    seenGaps.add(key);
    return true;
  });

  /* ---- recommendations ------------------------------------------------- */
  const recommendations: RegressionRecommendation[] = [];
  const add = (rec: Omit<RegressionRecommendation, 'id'>) => {
    const id = `REC-${sha256(`${rec.type}|${rec.title}`).slice(0, 8)}`;
    if (!recommendations.some((r) => r.id === id)) recommendations.push({ id, ...rec });
  };

  const fullRegressionAdvised = shouldForceFullRegression(diff);
  const fullRegressionReason = fullRegressionAdvised
    ? `A broad change was detected (${diff.files.filter((f) => shouldForceFullRegression({ ...diff, files: [f] })).map((f) => f.path).slice(0, 4).join(', ')}): dependencies, build configuration, root layout, routing or auth. Targeted selection cannot be trusted.`
    : null;
  if (fullRegressionAdvised) {
    add({
      type: 'full_regression', title: 'Run the full regression suite', priority: 'critical', feature: null,
      relatedTests: [], reasoning: fullRegressionReason!, evidence: diff.files.slice(0, 6).map((f) => f.path),
      source: 'deterministic', confidence: 0.9,
    });
  }

  for (const test of testsNeedingUpdate) {
    add({
      type: 'update_test', title: `Update ${test.file}: it visits removed route ${test.route}`, priority: 'critical',
      feature: null, relatedTests: [test.file],
      reasoning: `The route ${test.route} no longer exists in the application, but this spec still navigates to it. It will fail for a reason unrelated to product behaviour.`,
      evidence: [`route ${test.route} removed`], source: 'deterministic', confidence: 0.9,
    });
  }

  for (const feature of affectedFeatures) {
    if (feature.relatedTests.length === 0) continue;
    add({
      type: 'run_existing_test',
      title: `Re-run ${feature.relatedTests.length} test(s) covering ${feature.name}`,
      priority: riskToPriority(feature.risk),
      feature: feature.key,
      relatedTests: feature.relatedTests.map((t) => t.file),
      reasoning: feature.reasons.slice(0, 3).join(' ') || `${feature.changedFiles.length} changed file(s) belong to this feature.`,
      evidence: feature.changedFiles.slice(0, 6),
      source: 'deterministic', confidence: 0.85,
    });
  }

  for (const trace of traces_) {
    const validations = collapseValidations(diff.changedValidations.filter((v) => v.file === trace.file));
    for (const v of validations) {
      add({
        type: 'add_scenario',
        title: `Boundary and negative checks for "${v.field}" validation (${v.change})`,
        priority: 'high', feature: trace.features[0]?.key ?? null,
        relatedTests: trace.relatedTests.map((t) => t.file),
        reasoning: v.change === 'removed'
          ? `The validation rule for "${v.field}" was removed from ${v.file}. Verify that input formerly rejected is now handled deliberately, not silently accepted.`
          : `The validation rule for "${v.field}" was ${v.change} in ${v.file}. Values just inside and just outside the limit, and the error message, should be verified.`,
        evidence: [`${v.file}: ${v.field}`], source: 'deterministic', confidence: 0.8,
      });
    }
  }

  for (const gap of uniqueGaps) {
    if (gap.kind === 'never_passed') continue;
    add({
      type: 'add_scenario',
      title: gap.kind === 'no_tests' ? `Add coverage for ${gap.subject}`
        : gap.kind === 'rule_untested' ? `Add a scenario verifying ${gap.subject.split(':')[0]}`
        : gap.kind === 'route_untested' ? `Add a navigation test for new route ${gap.subject}`
        : gap.kind === 'api_unexercised' ? `Exercise ${gap.subject} in a test`
        : `Add a test for changes in ${gap.subject}`,
      priority: gap.kind === 'no_tests' || gap.kind === 'rule_untested'
        || (gap.kind === 'changed_without_test' && traces_.some((t) => t.file === gap.subject && t.risk === 'high'))
        ? 'high' : 'medium',
      feature: gap.feature, relatedTests: [], reasoning: gap.reason, evidence: [gap.subject],
      source: 'deterministic', confidence: 0.75,
    });
  }

  for (const finding of history) {
    add({
      type: 'historical_recheck',
      title: finding.recommendation,
      priority: finding.kind === 'past_defect' || finding.kind === 'past_failure' ? 'high' : 'medium',
      feature: null,
      relatedTests: finding.reference && isSpecFile(finding.reference) ? [finding.reference] : [],
      reasoning: `${finding.summary} (matched on ${finding.matchedOn}).`,
      evidence: [finding.matchedOn],
      source: 'history', confidence: 0.7,
    });
  }

  const PRIORITY_ORDER: Record<Priority, number> = { critical: 4, high: 3, medium: 2, low: 1 };
  recommendations.sort((a, b) => PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority]);

  const relatedExistingTests = allRelated.filter((t) => t.origin === 'existing');
  const relatedGeneratedTests = allRelated.filter((t) => t.origin === 'generated');
  const highRisk = affectedFeatures.filter((f) => f.risk === 'high').length;

  const summary = diff.files.length === 0
    ? (input.source.kind === 'first_analysis'
        ? 'First analysis of this repository: there is no earlier version to compare against, so no change impact was computed.'
        : 'No file changes between the compared versions.')
    : `${diff.files.length} file(s) changed, affecting ${affectedFeatures.length} feature(s)` +
      `${highRisk ? ` (${highRisk} high risk)` : ''}. ` +
      `${allRelated.length} related test(s) found (${relatedExistingTests.length} existing, ${relatedGeneratedTests.length} generated); ` +
      `${uniqueGaps.length} potential coverage gap(s)` +
      `${history.length ? `, ${history.length} related historical finding(s)` : ''}.`;

  return {
    generatedAt: new Date().toISOString(),
    source: input.source,
    summary,
    changedFiles: diff.files.map((f) => ({ path: f.path, status: f.status, additions: f.additions, deletions: f.deletions })),
    traces: traces_.sort((a, b) => RISK_ORDER[b.risk] - RISK_ORDER[a.risk]),
    affectedFeatures,
    coverage: {
      relatedExistingTests,
      relatedGeneratedTests,
      featuresAffected: affectedFeatures.length,
      featuresWithAnyTest: affectedFeatures.filter((f) => f.relatedTests.length > 0).length,
      gaps: uniqueGaps,
    },
    recommendations,
    historicalFindings: history,
    fullRegressionAdvised,
    fullRegressionReason,
    ai: { source: 'fallback', note: 'Deterministic analysis only.' },
  };
}

/** Why an existing repository spec is related to a changed file, or null. */
function existingSpecReason(
  spec: ExistingTestInfo,
  ctx: { paths: string[]; routes: string[]; components: string[]; analysis: StaticAnalysis },
): string | null {
  if (ctx.paths.includes(spec.file)) return 'The spec itself changed.';

  const visited = ctx.routes.filter((r) => spec.visits.some((v) => visitMatchesRoute(v, r)));
  if (visited.length) return `Visits affected route(s) ${visited.join(', ')}`;

  const selectors = new Set(
    ctx.analysis.components
      .filter((c) => ctx.paths.includes(c.file))
      .flatMap((c) => c.elements.map((e) => e.selector).filter((s): s is string => Boolean(s))),
  );
  const shared = spec.selectorsUsed.filter((s) => selectors.has(s));
  if (shared.length) return `Uses selector(s) defined in the changed component: ${shared.slice(0, 3).join(', ')}`;

  const po = spec.pageObjects.filter((p) => ctx.components.some((c) => p.toLowerCase().includes(c.toLowerCase())));
  if (po.length) return `Uses page object(s) ${po.join(', ')} named after a changed component`;
  return null;
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k) ?? [];
    list.push(item);
    map.set(k, list);
  }
  return map;
}

export { visitMatchesRoute };
