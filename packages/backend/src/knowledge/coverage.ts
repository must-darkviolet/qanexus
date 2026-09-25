/**
 * Coverage model (spec section 12).
 *
 * "Do not claim 100% coverage merely because tests were generated."
 *
 * Every number here is counted from stored data. A business rule counts as
 * covered only when a scenario references it AND that scenario is implemented
 * by a test that actually ran. Generation alone never counts as coverage.
 */
import type { CoverageSnapshot, StaticAnalysis } from '@qa-agent/shared';
import { getDb } from '../db/client.js';
import { listBusinessRules, listFeatures, listScenarios } from './store.js';

export interface CoverageInput {
  projectId: string;
  runId: string | null;
  analysis: StaticAnalysis;
}

interface ExecutedRow { scenario_key: string | null; outcome: string; spec_file: string }

export async function computeCoverage(input: CoverageInput): Promise<CoverageSnapshot> {
  const db = await getDb();
  const [features, rules, scenarios] = await Promise.all([
    listFeatures(input.projectId),
    listBusinessRules(input.projectId, { activeOnly: true }),
    listScenarios(input.projectId),
  ]);

  // Scenarios that have actually been executed at least once (ever), so a
  // targeted run does not erase the coverage earned by earlier runs.
  const executed = await db.query<ExecutedRow>(
    `SELECT DISTINCT scenario_key, outcome, spec_file FROM test_results
     WHERE project_id = ? AND scenario_key IS NOT NULL AND outcome IN ('passed', 'failed')`,
    [input.projectId],
  );
  const executedScenarioKeys = new Set(executed.map((r) => r.scenario_key).filter((k): k is string => Boolean(k)));

  // A scenario linked to a pre-existing repo test also counts, because that
  // test is real coverage even though this system did not generate it.
  for (const scenario of scenarios) {
    if (scenario.coveredByExistingTest) executedScenarioKeys.add(scenario.id);
  }

  const coveredScenarios = scenarios.filter((s) => executedScenarioKeys.has(s.id));

  /* -- features -------------------------------------------------------- */
  // Only features that still exist count: scenarios recorded for a feature that
  // was since renamed or removed must not push "tested" above "discovered".
  const liveFeatureKeys = new Set(features.map((f) => f.key));
  const testedFeatureKeys = new Set(coveredScenarios.map((s) => s.feature).filter((k) => liveFeatureKeys.has(k)));

  /* -- business rules --------------------------------------------------- */
  const coveredRuleIds = new Set<string>();
  const liveRuleIds = new Set(rules.map((r) => r.id));
  for (const scenario of coveredScenarios) {
    for (const ruleId of scenario.businessRuleIds) if (liveRuleIds.has(ruleId)) coveredRuleIds.add(ruleId);
  }

  /* -- routes ----------------------------------------------------------- */
  const pageRoutes = input.analysis.routes.filter((r) => r.kind !== 'api');
  const visitedRoutes = new Set<string>();
  for (const scenario of coveredScenarios) {
    const haystack = `${scenario.title} ${scenario.steps.join(' ')} ${scenario.description}`;
    for (const route of pageRoutes) {
      if (haystack.includes(route.path)) visitedRoutes.add(route.path);
    }
  }

  /* -- forms ------------------------------------------------------------ */
  const allForms = input.analysis.components.flatMap((c) =>
    c.forms.map((f, i) => ({ key: `${c.name}#${f.name ?? i}`, fields: f.fields.map((x) => x.name) })),
  );
  const testedForms = new Set<string>();
  for (const scenario of coveredScenarios) {
    const haystack = `${scenario.title} ${scenario.steps.join(' ')}`.toLowerCase();
    for (const form of allForms) {
      if (form.fields.some((field) => haystack.includes(field.toLowerCase()))) testedForms.add(form.key);
    }
  }

  /* -- APIs ------------------------------------------------------------- */
  const exercisedApis = new Set<string>();
  for (const scenario of coveredScenarios) {
    const haystack = `${scenario.title} ${scenario.steps.join(' ')} ${scenario.expectedResult}`;
    for (const api of input.analysis.apis) {
      if (haystack.includes(api.path)) exercisedApis.add(`${api.method} ${api.path}`);
    }
  }

  /* -- roles ------------------------------------------------------------ */
  const allRoles = new Set(input.analysis.roles.map((r) => r.name));
  for (const route of input.analysis.routes) for (const role of route.guardedByRoles) allRoles.add(role);
  const testedRoles = new Set(
    coveredScenarios.map((s) => s.role).filter((r): r is string => Boolean(r)),
  );

  /* -- gaps: the honest part ------------------------------------------- */
  const gaps: CoverageSnapshot['gaps'] = [];

  for (const feature of features) {
    if (testedFeatureKeys.has(feature.key)) continue;
    const generated = scenarios.filter((s) => s.feature === feature.key).length;
    gaps.push({
      kind: 'feature',
      subject: feature.name,
      reason: generated > 0
        ? `${generated} scenario(s) exist but none has been executed yet.`
        : 'No scenarios have been generated for this feature.',
    });
  }

  for (const rule of rules) {
    if (coveredRuleIds.has(rule.id)) continue;
    const scenariosForRule = scenarios.filter((s) => s.businessRuleIds.includes(rule.id)).length;
    gaps.push({
      kind: 'business_rule',
      subject: `${rule.id}: ${rule.description.slice(0, 120)}`,
      reason: scenariosForRule > 0
        ? `${scenariosForRule} scenario(s) reference this rule but none has been executed.`
        : 'No scenario verifies this rule.',
    });
  }

  for (const route of pageRoutes) {
    if (visitedRoutes.has(route.path)) continue;
    gaps.push({ kind: 'route', subject: route.path, reason: 'No executed scenario visits this route.' });
  }

  for (const role of allRoles) {
    if (testedRoles.has(role)) continue;
    gaps.push({ kind: 'role', subject: role, reason: 'No executed scenario runs as this role.' });
  }

  for (const api of input.analysis.apis) {
    const key = `${api.method} ${api.path}`;
    if (exercisedApis.has(key)) continue;
    gaps.push({ kind: 'api', subject: key, reason: 'No executed scenario exercises this endpoint.' });
  }

  // Rules that remain unknown or weakly inferred are a different kind of gap:
  // not untested, but not confidently understood either.
  for (const rule of rules.filter((r) => r.status === 'weakly_inferred' || r.status === 'unknown')) {
    gaps.push({
      kind: 'uncertain_rule',
      subject: `${rule.id}: ${rule.description.slice(0, 120)}`,
      reason: `Recorded as ${rule.status} (confidence ${rule.confidence.toFixed(2)}). ${rule.unknown[0] ?? 'Needs human confirmation.'}`,
    });
  }

  return {
    featuresDiscovered: features.length,
    featuresTested: testedFeatureKeys.size,
    businessRulesDiscovered: rules.length,
    businessRulesTested: coveredRuleIds.size,
    routesDiscovered: pageRoutes.length,
    routesTested: visitedRoutes.size,
    formsDiscovered: allForms.length,
    formsTested: testedForms.size,
    apisDiscovered: input.analysis.apis.length,
    apisExercised: exercisedApis.size,
    rolesDiscovered: allRoles.size,
    rolesTested: testedRoles.size,
    negativeScenarios: scenarios.filter((s) => s.category === 'negative').length,
    boundaryScenarios: scenarios.filter((s) => s.category === 'boundary').length,
    stateTransitionScenarios: scenarios.filter((s) => s.category === 'state_transition').length,
    gaps: gaps.slice(0, 500),
  };
}
