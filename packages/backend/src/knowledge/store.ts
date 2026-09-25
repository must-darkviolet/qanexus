/**
 * Persistence for the Application Knowledge Model (spec sections 6 and 7).
 *
 * Knowledge is *accumulated*, not replaced: each run upserts what it learned,
 * stamps first/last seen commits, and leaves prior knowledge intact so the
 * next run starts from what is already known rather than from zero.
 */
import type {
  ApiEndpoint, BusinessRule, EntityInfo, FeatureInfo, PermissionCheck, RoleInfo,
  Route, StateMachine, StaticAnalysis, TestScenario, UserFlow, ValidationRule,
} from '@qa-agent/shared';
import { fromJson, getDb, toBool } from '../db/client.js';
import { seqId, slug, uuid } from '../util/ids.js';
import { dedupeHash, similarity, DUPLICATE_THRESHOLD } from './dedupe.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('knowledge');
const now = () => new Date().toISOString();

/* -------------------------------------------------------------------------- */
/* Application                                                                 */
/* -------------------------------------------------------------------------- */
export interface ApplicationRecord {
  projectId: string;
  name: string;
  purpose: string;
  domain: string;
  framework: string;
  architecture: string[];
  openQuestions: string[];
  updatedAt: string;
  updatedCommit: string | null;
}

export async function upsertApplication(rec: Omit<ApplicationRecord, 'updatedAt'>): Promise<void> {
  const db = await getDb();
  await db.run(
    `INSERT INTO applications (project_id, name, purpose, domain, framework, architecture_json, open_questions_json, updated_at, updated_commit)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (project_id) DO UPDATE SET
       name = excluded.name, purpose = excluded.purpose, domain = excluded.domain,
       framework = excluded.framework, architecture_json = excluded.architecture_json,
       open_questions_json = excluded.open_questions_json, updated_at = excluded.updated_at,
       updated_commit = excluded.updated_commit`,
    [rec.projectId, rec.name, rec.purpose, rec.domain, rec.framework,
     JSON.stringify(rec.architecture), JSON.stringify(rec.openQuestions), now(), rec.updatedCommit],
  );
}

export async function getApplication(projectId: string): Promise<ApplicationRecord | null> {
  const db = await getDb();
  const row = await db.one<Record<string, unknown>>('SELECT * FROM applications WHERE project_id = ?', [projectId]);
  if (!row) return null;
  return {
    projectId,
    name: String(row['name'] ?? ''),
    purpose: String(row['purpose'] ?? ''),
    domain: String(row['domain'] ?? ''),
    framework: String(row['framework'] ?? 'unknown'),
    architecture: fromJson<string[]>(row['architecture_json'], []),
    openQuestions: fromJson<string[]>(row['open_questions_json'], []),
    updatedAt: String(row['updated_at'] ?? ''),
    updatedCommit: (row['updated_commit'] as string | null) ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* Features                                                                    */
/* -------------------------------------------------------------------------- */
export async function upsertFeatures(projectId: string, features: FeatureInfo[], commitSha: string): Promise<FeatureInfo[]> {
  const db = await getDb();
  const stored: FeatureInfo[] = [];
  for (const feature of features) {
    const key = slug(feature.key || feature.name);
    await db.run(
      `INSERT INTO features (id, project_id, key, name, description, evidence_level, routes_json, components_json,
                             files_json, apis_json, entities_json, first_seen_commit, last_seen_commit, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, key) DO UPDATE SET
         name = excluded.name,
         description = CASE WHEN excluded.description = '' THEN features.description ELSE excluded.description END,
         evidence_level = excluded.evidence_level,
         routes_json = excluded.routes_json, components_json = excluded.components_json,
         files_json = excluded.files_json, apis_json = excluded.apis_json, entities_json = excluded.entities_json,
         last_seen_commit = excluded.last_seen_commit, updated_at = excluded.updated_at`,
      [uuid(), projectId, key, feature.name, feature.description ?? '', feature.evidenceLevel,
       JSON.stringify(feature.routes), JSON.stringify(feature.components), JSON.stringify(feature.files),
       JSON.stringify(feature.apis), JSON.stringify(feature.entities), commitSha, commitSha, now()],
    );
    stored.push({ ...feature, key });
  }
  return stored;
}

/**
 * Removes feature rows that the current analysis no longer recognises.
 *
 * Without this a renamed or deleted feature lingers forever, and the dashboard
 * reports a feature count that does not match the application.
 */
export async function pruneFeatures(projectId: string, liveKeys: string[]): Promise<number> {
  const db = await getDb();
  const existing = await db.query<{ key: string }>('SELECT key FROM features WHERE project_id = ?', [projectId]);
  const live = new Set(liveKeys);
  let removed = 0;
  for (const row of existing) {
    if (live.has(row.key)) continue;
    await db.run('DELETE FROM features WHERE project_id = ? AND key = ?', [projectId, row.key]);
    removed++;
  }
  if (removed) log.info(`Pruned ${removed} feature(s) that no longer exist in the repository.`);
  return removed;
}

export async function listFeatures(projectId: string): Promise<FeatureInfo[]> {
  const db = await getDb();
  const rows = await db.query<Record<string, unknown>>('SELECT * FROM features WHERE project_id = ? ORDER BY key', [projectId]);
  return rows.map((row) => ({
    key: String(row['key']),
    name: String(row['name']),
    description: String(row['description'] ?? ''),
    routes: fromJson<string[]>(row['routes_json'], []),
    components: fromJson<string[]>(row['components_json'], []),
    files: fromJson<string[]>(row['files_json'], []),
    apis: fromJson<string[]>(row['apis_json'], []),
    entities: fromJson<string[]>(row['entities_json'], []),
    evidenceLevel: (row['evidence_level'] as FeatureInfo['evidenceLevel']) ?? 'inferred',
  }));
}

/* -------------------------------------------------------------------------- */
/* Application map (routes, components, APIs, roles, flows, ...)               */
/* -------------------------------------------------------------------------- */
export type MapKind =
  | 'route' | 'component' | 'api' | 'entity' | 'role' | 'permission'
  | 'state_machine' | 'validation' | 'user_flow' | 'navigation';

export async function upsertMapEntries(
  projectId: string, kind: MapKind, commitSha: string,
  entries: { key: string; payload: unknown; file?: string; featureKey?: string }[],
): Promise<void> {
  if (entries.length === 0) return;
  const db = await getDb();
  await db.transaction(async (tx) => {
    for (const entry of entries) {
      await tx.run(
        `INSERT INTO app_map (id, project_id, kind, key, payload_json, file, feature_key, commit_sha, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, kind, key) DO UPDATE SET
           payload_json = excluded.payload_json, file = excluded.file,
           feature_key = COALESCE(excluded.feature_key, app_map.feature_key),
           commit_sha = excluded.commit_sha, updated_at = excluded.updated_at`,
        [uuid(), projectId, kind, entry.key, JSON.stringify(entry.payload),
         entry.file ?? null, entry.featureKey ?? null, commitSha, now()],
      );
    }
  });
}

export async function listMapEntries<T>(projectId: string, kind: MapKind): Promise<{ key: string; payload: T; file: string | null; featureKey: string | null }[]> {
  const db = await getDb();
  const rows = await db.query<Record<string, unknown>>(
    'SELECT key, payload_json, file, feature_key FROM app_map WHERE project_id = ? AND kind = ? ORDER BY key',
    [projectId, kind],
  );
  return rows.map((row) => ({
    key: String(row['key']),
    payload: fromJson<T>(row['payload_json'], {} as T),
    file: (row['file'] as string | null) ?? null,
    featureKey: (row['feature_key'] as string | null) ?? null,
  }));
}

/** Writes the whole static analysis into the map in one pass. */
export async function persistStaticAnalysis(
  projectId: string, commitSha: string, analysis: StaticAnalysis,
  featureOfFile: (file: string) => string | undefined,
): Promise<void> {
  await upsertMapEntries(projectId, 'route', commitSha, analysis.routes.map((r: Route) => ({
    key: `${r.framework}:${r.path}`, payload: r, file: r.file, featureKey: featureOfFile(r.file),
  })));
  await upsertMapEntries(projectId, 'component', commitSha, analysis.components.map((c) => ({
    key: `${c.file}#${c.name}`, payload: c, file: c.file, featureKey: featureOfFile(c.file),
  })));
  await upsertMapEntries(projectId, 'api', commitSha, analysis.apis.map((a: ApiEndpoint) => ({
    key: `${a.method} ${a.path}`, payload: a, file: a.file, featureKey: featureOfFile(a.file),
  })));
  await upsertMapEntries(projectId, 'entity', commitSha, analysis.entities.map((e: EntityInfo) => ({
    key: `${e.file}#${e.name}`, payload: e, file: e.file, featureKey: featureOfFile(e.file),
  })));
  await upsertMapEntries(projectId, 'role', commitSha, analysis.roles.map((r: RoleInfo) => ({
    key: r.name, payload: r,
  })));
  await upsertMapEntries(projectId, 'permission', commitSha, analysis.permissionChecks.map((p: PermissionCheck, i) => ({
    key: `${p.file}:${p.line ?? i}`, payload: p, file: p.file, featureKey: featureOfFile(p.file),
  })));
  await upsertMapEntries(projectId, 'state_machine', commitSha, analysis.stateMachines.map((s: StateMachine) => ({
    key: `${s.file}#${s.entity}`, payload: s, file: s.file, featureKey: featureOfFile(s.file),
  })));
  await upsertMapEntries(projectId, 'validation', commitSha, analysis.validations.map((v: ValidationRule, i) => ({
    key: `${v.file}:${v.field}:${v.rule}:${i}`, payload: v, file: v.file, featureKey: featureOfFile(v.file),
  })));
  log.info(`Persisted application map for commit ${commitSha.slice(0, 8)}.`);
}

export async function upsertUserFlows(projectId: string, commitSha: string, flows: UserFlow[]): Promise<void> {
  await upsertMapEntries(projectId, 'user_flow', commitSha, flows.map((f) => ({
    key: f.key, payload: f, featureKey: f.feature,
  })));
}

/* -------------------------------------------------------------------------- */
/* Business rules                                                              */
/* -------------------------------------------------------------------------- */
export interface StoredBusinessRule extends BusinessRule {
  dbId: string;
  isActive: boolean;
  firstSeenCommit: string | null;
  lastSeenCommit: string | null;
  approvalState: string;
}

function rowToRule(row: Record<string, unknown>): StoredBusinessRule {
  return {
    dbId: String(row['id']),
    id: String(row['rule_key']),
    feature: String(row['feature_key'] ?? ''),
    description: String(row['description'] ?? ''),
    category: (row['category'] as BusinessRule['category']) ?? 'other',
    status: (row['status'] as BusinessRule['status']) ?? 'weakly_inferred',
    confidence: Number(row['confidence']) || 0,
    evidence: fromJson(row['evidence_json'], []),
    observed: fromJson<string[]>(row['observed_json'], []),
    inferred: fromJson<string[]>(row['inferred_json'], []),
    unknown: fromJson<string[]>(row['unknown_json'], []),
    relatedRoutes: fromJson<string[]>(row['related_routes_json'], []),
    relatedApis: fromJson<string[]>(row['related_apis_json'], []),
    relatedFiles: fromJson<string[]>(row['related_files_json'], []),
    isActive: toBool(row['is_active']),
    firstSeenCommit: (row['first_seen_commit'] as string | null) ?? null,
    lastSeenCommit: (row['last_seen_commit'] as string | null) ?? null,
    approvalState: String(row['approval_state'] ?? 'ai_generated'),
  };
}

export async function listBusinessRules(projectId: string, opts?: { activeOnly?: boolean }): Promise<StoredBusinessRule[]> {
  const db = await getDb();
  const rows = await db.query<Record<string, unknown>>(
    `SELECT * FROM business_rules WHERE project_id = ?${opts?.activeOnly ? ' AND is_active = 1' : ''} ORDER BY rule_key`,
    [projectId],
  );
  return rows.map(rowToRule);
}

async function nextRuleNumber(projectId: string): Promise<number> {
  const db = await getDb();
  const row = await db.one<{ c: number }>('SELECT COUNT(*) AS c FROM business_rules WHERE project_id = ?', [projectId]);
  return (Number(row?.c) || 0) + 1;
}

/** Inserts new rules and refreshes the ones already known. */
export async function upsertBusinessRules(
  projectId: string, commitSha: string, rules: Omit<BusinessRule, 'id'>[],
): Promise<{ created: StoredBusinessRule[]; updated: StoredBusinessRule[] }> {
  const db = await getDb();
  const existing = await listBusinessRules(projectId);
  const byHash = new Map(existing.map((r) => [dedupeHash([r.feature, r.description]), r]));
  let counter = await nextRuleNumber(projectId);

  const created: StoredBusinessRule[] = [];
  const updated: StoredBusinessRule[] = [];

  for (const rule of rules) {
    const hash = dedupeHash([rule.feature, rule.description]);
    const prior = byHash.get(hash);

    if (prior) {
      await db.run(
        `UPDATE business_rules SET confidence = ?, status = ?, evidence_json = ?, observed_json = ?,
           inferred_json = ?, unknown_json = ?, related_routes_json = ?, related_apis_json = ?,
           related_files_json = ?, category = ?, last_seen_commit = ?, is_active = 1, updated_at = ?
         WHERE id = ?`,
        [rule.confidence, rule.status, JSON.stringify(rule.evidence), JSON.stringify(rule.observed),
         JSON.stringify(rule.inferred), JSON.stringify(rule.unknown), JSON.stringify(rule.relatedRoutes),
         JSON.stringify(rule.relatedApis), JSON.stringify(rule.relatedFiles), rule.category,
         commitSha, now(), prior.dbId],
      );
      updated.push({ ...prior, ...rule, id: prior.id, dbId: prior.dbId, isActive: true, lastSeenCommit: commitSha });
      continue;
    }

    const ruleKey = seqId('BR', counter++);
    const id = uuid();
    await db.run(
      `INSERT INTO business_rules (id, project_id, rule_key, feature_key, description, category, status, confidence,
         evidence_json, observed_json, inferred_json, unknown_json, related_routes_json, related_apis_json,
         related_files_json, approval_state, dedupe_hash, first_seen_commit, last_seen_commit, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai_generated', ?, ?, ?, 1, ?, ?)`,
      [id, projectId, ruleKey, rule.feature, rule.description, rule.category, rule.status, rule.confidence,
       JSON.stringify(rule.evidence), JSON.stringify(rule.observed), JSON.stringify(rule.inferred),
       JSON.stringify(rule.unknown), JSON.stringify(rule.relatedRoutes), JSON.stringify(rule.relatedApis),
       JSON.stringify(rule.relatedFiles), hash, commitSha, commitSha, now(), now()],
    );
    const stored: StoredBusinessRule = {
      ...rule, id: ruleKey, dbId: id, isActive: true,
      firstSeenCommit: commitSha, lastSeenCommit: commitSha, approvalState: 'ai_generated',
    };
    created.push(stored);
    byHash.set(hash, stored);
  }

  log.info(`Business rules: ${created.length} new, ${updated.length} reconfirmed.`);
  return { created, updated };
}

/* -------------------------------------------------------------------------- */
/* Scenarios                                                                   */
/* -------------------------------------------------------------------------- */
export interface StoredScenario extends TestScenario {
  dbId: string;
  isObsolete: boolean;
  obsoleteReason: string | null;
  firstSeenCommit: string | null;
}

function rowToScenario(row: Record<string, unknown>): StoredScenario {
  return {
    dbId: String(row['id']),
    id: String(row['scenario_key']),
    feature: String(row['feature_key'] ?? ''),
    category: row['category'] as TestScenario['category'],
    title: String(row['title'] ?? ''),
    description: String(row['description'] ?? ''),
    preconditions: fromJson<string[]>(row['preconditions_json'], []),
    steps: fromJson<string[]>(row['steps_json'], []),
    expectedResult: String(row['expected_result'] ?? ''),
    businessRuleIds: fromJson<string[]>(row['business_rules_json'], []),
    sourceEvidence: fromJson(row['evidence_json'], []),
    confidence: Number(row['confidence']) || 0,
    priority: (row['priority'] as TestScenario['priority']) ?? 'medium',
    role: (row['role'] as string | null) ?? undefined,
    relatedTestIds: [],
    coveredByExistingTest: (row['covered_by_existing'] as string | null) ?? undefined,
    approvalState: (row['approval_state'] as TestScenario['approvalState']) ?? 'ai_generated',
    isObsolete: toBool(row['is_obsolete']),
    obsoleteReason: (row['obsolete_reason'] as string | null) ?? null,
    firstSeenCommit: (row['first_seen_commit'] as string | null) ?? null,
  };
}

export async function listScenarios(projectId: string, opts?: { includeObsolete?: boolean }): Promise<StoredScenario[]> {
  const db = await getDb();
  const rows = await db.query<Record<string, unknown>>(
    `SELECT * FROM scenarios WHERE project_id = ?${opts?.includeObsolete ? '' : ' AND is_obsolete = 0'} ORDER BY scenario_key`,
    [projectId],
  );
  return rows.map(rowToScenario);
}

export async function upsertScenarios(
  projectId: string, commitSha: string, scenarios: Omit<TestScenario, 'id'>[],
): Promise<{ created: StoredScenario[]; existing: StoredScenario[] }> {
  const db = await getDb();
  const prior = await listScenarios(projectId, { includeObsolete: true });
  const byHash = new Map(prior.map((s) => [dedupeHash([s.feature, s.category, s.title, s.expectedResult]), s]));
  const countRow = await db.one<{ c: number }>('SELECT COUNT(*) AS c FROM scenarios WHERE project_id = ?', [projectId]);
  let counter = (Number(countRow?.c) || 0) + 1;

  const created: StoredScenario[] = [];
  const existing: StoredScenario[] = [];

  for (const scenario of scenarios) {
    const hash = dedupeHash([scenario.feature, scenario.category, scenario.title, scenario.expectedResult]);
    // Exact match, or a live scenario of the same feature saying the same thing in other words.
    const known = byHash.get(hash) ?? prior.find((p) => !p.isObsolete && p.feature === scenario.feature
      && similarity(p.title, scenario.title) >= DUPLICATE_THRESHOLD);
    if (known) {
      await db.run(
        `UPDATE scenarios SET steps_json = ?, expected_result = ?, business_rules_json = ?, evidence_json = ?,
           confidence = ?, priority = ?, is_obsolete = 0, obsolete_reason = NULL, last_seen_commit = ?, updated_at = ?
         WHERE id = ?`,
        [JSON.stringify(scenario.steps), scenario.expectedResult, JSON.stringify(scenario.businessRuleIds),
         JSON.stringify(scenario.sourceEvidence), scenario.confidence, scenario.priority, commitSha, now(), known.dbId],
      );
      existing.push(known);
      continue;
    }

    const scenarioKey = seqId('SC', counter++);
    const id = uuid();
    await db.run(
      `INSERT INTO scenarios (id, project_id, scenario_key, feature_key, category, title, description,
         preconditions_json, steps_json, expected_result, business_rules_json, evidence_json, confidence,
         priority, role, dedupe_hash, covered_by_existing, approval_state, is_obsolete,
         first_seen_commit, last_seen_commit, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai_generated', 0, ?, ?, ?, ?)`,
      [id, projectId, scenarioKey, scenario.feature, scenario.category, scenario.title, scenario.description,
       JSON.stringify(scenario.preconditions), JSON.stringify(scenario.steps), scenario.expectedResult,
       JSON.stringify(scenario.businessRuleIds), JSON.stringify(scenario.sourceEvidence), scenario.confidence,
       scenario.priority, scenario.role ?? null, hash, scenario.coveredByExistingTest ?? null,
       commitSha, commitSha, now(), now()],
    );
    const stored: StoredScenario = {
      ...scenario, id: scenarioKey, dbId: id, relatedTestIds: [],
      isObsolete: false, obsoleteReason: null, firstSeenCommit: commitSha,
      approvalState: 'ai_generated',
    };
    created.push(stored);
    byHash.set(hash, stored);
  }

  log.info(`Scenarios: ${created.length} new, ${existing.length} already known.`);
  return { created, existing };
}

/**
 * Collapses near-duplicate scenarios of a feature (repeated runs rephrasing the
 * same scenario) into the oldest one; the rest are marked obsolete with the id
 * they duplicate, so they are neither generated nor reported twice.
 */
export async function collapseDuplicateScenarios(projectId: string, featureKey: string): Promise<{ key: string; duplicateOf: string }[]> {
  const live = (await listScenarios(projectId)).filter((s) => s.feature === featureKey)
    .sort((a, b) => Number(a.id.replace(/\D/g, '')) - Number(b.id.replace(/\D/g, '')));
  const kept: StoredScenario[] = [];
  const dropped: { key: string; duplicateOf: string }[] = [];
  for (const s of live) {
    const original = kept.find((k) => similarity(k.title, s.title) >= DUPLICATE_THRESHOLD);
    if (original) dropped.push({ key: s.id, duplicateOf: original.id });
    else kept.push(s);
  }
  for (const d of dropped) await markScenariosObsolete(projectId, [d.key], `duplicate of ${d.duplicateOf}`);
  if (dropped.length) log.info(`Collapsed ${dropped.length} duplicate scenario(s) of ${featureKey}: ${dropped.map((d) => `${d.key}->${d.duplicateOf}`).join(', ')}.`);
  return dropped;
}

export async function markScenariosObsolete(projectId: string, scenarioKeys: string[], reason: string): Promise<number> {
  if (scenarioKeys.length === 0) return 0;
  const db = await getDb();
  let count = 0;
  for (const key of scenarioKeys) {
    await db.run(
      'UPDATE scenarios SET is_obsolete = 1, obsolete_reason = ?, updated_at = ? WHERE project_id = ? AND scenario_key = ?',
      [reason, now(), projectId, key],
    );
    count++;
  }
  return count;
}

export async function linkScenarioToExistingTest(projectId: string, scenarioKey: string, specFile: string): Promise<void> {
  const db = await getDb();
  await db.run(
    'UPDATE scenarios SET covered_by_existing = ?, updated_at = ? WHERE project_id = ? AND scenario_key = ?',
    [specFile, now(), projectId, scenarioKey],
  );
}

export async function setScenarioApproval(projectId: string, scenarioKey: string, state: string): Promise<void> {
  const db = await getDb();
  await db.run(
    'UPDATE scenarios SET approval_state = ?, updated_at = ? WHERE project_id = ? AND scenario_key = ?',
    [state, now(), projectId, scenarioKey],
  );
}

/* -------------------------------------------------------------------------- */
/* Traceability: source file -> feature -> rule -> scenario -> spec            */
/* -------------------------------------------------------------------------- */
export interface TraceLink {
  sourceFile: string;
  featureKey?: string | null;
  businessRuleKey?: string | null;
  scenarioKey?: string | null;
  specFile?: string | null;
}

export async function replaceTraceability(projectId: string, links: TraceLink[]): Promise<void> {
  const db = await getDb();
  await db.transaction(async (tx) => {
    await tx.run('DELETE FROM traceability WHERE project_id = ?', [projectId]);
    for (const link of links) {
      await tx.run(
        `INSERT INTO traceability (id, project_id, source_file, feature_key, business_rule_key, scenario_key, spec_file, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuid(), projectId, link.sourceFile, link.featureKey ?? null, link.businessRuleKey ?? null,
         link.scenarioKey ?? null, link.specFile ?? null, now()],
      );
    }
  });
}

export async function tracesForFiles(projectId: string, files: string[]): Promise<TraceLink[]> {
  if (files.length === 0) return [];
  const db = await getDb();
  const placeholders = files.map(() => '?').join(', ');
  const rows = await db.query<Record<string, unknown>>(
    `SELECT source_file, feature_key, business_rule_key, scenario_key, spec_file
     FROM traceability WHERE project_id = ? AND source_file IN (${placeholders})`,
    [projectId, ...files],
  );
  return rows.map((row) => ({
    sourceFile: String(row['source_file']),
    featureKey: (row['feature_key'] as string | null) ?? null,
    businessRuleKey: (row['business_rule_key'] as string | null) ?? null,
    scenarioKey: (row['scenario_key'] as string | null) ?? null,
    specFile: (row['spec_file'] as string | null) ?? null,
  }));
}
