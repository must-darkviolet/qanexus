/**
 * Relevant memory retrieval (spec section 24).
 *
 * "Before every AI operation, retrieve relevant memory... Do NOT send the
 * entire database to the model. Use relevant retrieval."
 *
 * Retrieval is scoped by subject (a feature, a file, a test) and ranked by
 * lexical overlap, then hard-capped. Nothing goes into a prompt unbounded.
 */
import { fromJson, getDb } from '../db/client.js';
import { normalizeText, similarity } from '../knowledge/dedupe.js';
import { listBusinessRules, listScenarios, type StoredBusinessRule, type StoredScenario } from '../knowledge/store.js';
import { allMemory, type MemoryEntry } from './store.js';

export interface RetrievedMemory {
  featureKey: string | null;
  businessRules: StoredBusinessRule[];
  scenarios: StoredScenario[];
  pastFailures: PastFailure[];
  notes: MemoryEntry[];
  existingSpecs: string[];
  previousCommits: string[];
}

export interface PastFailure {
  id: string;
  testTitle: string;
  specFile: string;
  scenarioKey: string | null;
  classification: string | null;
  rootCause: string | null;
  resolution: string;
  occurrenceCount: number;
  isFlaky: boolean;
  signature: string;
  occurredAt: string;
  commitSha: string | null;
}

function scoreAgainst(query: string[], text: string): number {
  if (query.length === 0) return 0;
  const tokens = new Set(normalizeText(text));
  let hits = 0;
  for (const q of query) if (tokens.has(q)) hits++;
  return hits / query.length;
}

export async function pastFailuresFor(projectId: string, opts: { specFile?: string; scenarioKey?: string; signature?: string; limit?: number }): Promise<PastFailure[]> {
  const db = await getDb();
  const clauses: string[] = ['project_id = ?'];
  const params: unknown[] = [projectId];
  if (opts.signature) { clauses.push('signature = ?'); params.push(opts.signature); }
  else if (opts.scenarioKey) { clauses.push('scenario_key = ?'); params.push(opts.scenarioKey); }
  else if (opts.specFile) { clauses.push('spec_file = ?'); params.push(opts.specFile); }

  const rows = await db.query<Record<string, unknown>>(
    `SELECT id, test_title, spec_file, scenario_key, classification, root_cause, resolution,
            occurrence_count, is_flaky, signature, occurred_at, commit_sha
     FROM failures WHERE ${clauses.join(' AND ')} ORDER BY occurred_at DESC LIMIT ?`,
    [...params, opts.limit ?? 10],
  );

  return rows.map((row) => ({
    id: String(row['id']),
    testTitle: String(row['test_title']),
    specFile: String(row['spec_file']),
    scenarioKey: (row['scenario_key'] as string | null) ?? null,
    classification: (row['classification'] as string | null) ?? null,
    rootCause: (row['root_cause'] as string | null) ?? null,
    resolution: String(row['resolution'] ?? 'open'),
    occurrenceCount: Number(row['occurrence_count']) || 1,
    isFlaky: row['is_flaky'] === 1 || row['is_flaky'] === true,
    signature: String(row['signature']),
    occurredAt: String(row['occurred_at']),
    commitSha: (row['commit_sha'] as string | null) ?? null,
  }));
}

/**
 * The main entry point: everything the agents should know about one subject,
 * bounded in size.
 */
export async function retrieveMemory(projectId: string, opts: {
  featureKey?: string | null;
  subject?: string;
  files?: string[];
  maxRules?: number;
  maxScenarios?: number;
  maxNotes?: number;
}): Promise<RetrievedMemory> {
  const query = normalizeText([opts.subject ?? '', opts.featureKey ?? ''].join(' '));
  const maxRules = opts.maxRules ?? 25;
  const maxScenarios = opts.maxScenarios ?? 25;
  const maxNotes = opts.maxNotes ?? 15;

  const [allRules, allScenarios, notes] = await Promise.all([
    listBusinessRules(projectId, { activeOnly: true }),
    listScenarios(projectId),
    allMemory(projectId),
  ]);

  const matchesFeature = (candidateFeature: string) =>
    opts.featureKey ? candidateFeature === opts.featureKey : true;

  const businessRules = allRules
    .filter((r) => matchesFeature(r.feature))
    .map((r) => ({ r, score: scoreAgainst(query, `${r.feature} ${r.description}`) + r.confidence * 0.2 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxRules)
    .map((x) => x.r);

  const scenarios = allScenarios
    .filter((s) => matchesFeature(s.feature))
    .map((s) => ({ s, score: scoreAgainst(query, `${s.feature} ${s.title} ${s.expectedResult}`) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxScenarios)
    .map((x) => x.s);

  const relevantNotes = notes
    .filter((n) => !opts.featureKey || n.subject === opts.featureKey || n.scope !== 'application')
    .map((n) => ({ n, score: Math.max(scoreAgainst(query, `${n.subject} ${n.summary} ${n.keywords}`), n.scope === 'qa' ? 0.15 : 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxNotes)
    .map((x) => x.n);

  const specFiles = [...new Set(scenarios.map((s) => s.coveredByExistingTest).filter((f): f is string => Boolean(f)))];

  const pastFailures: PastFailure[] = [];
  for (const scenario of scenarios.slice(0, 8)) {
    pastFailures.push(...await pastFailuresFor(projectId, { scenarioKey: scenario.id, limit: 3 }));
  }

  const db = await getDb();
  const commitRows = await db.query<{ commit_sha: string }>(
    'SELECT commit_sha FROM repo_snapshots WHERE project_id = ? ORDER BY analyzed_at DESC LIMIT 5',
    [projectId],
  );

  return {
    featureKey: opts.featureKey ?? null,
    businessRules,
    scenarios,
    pastFailures,
    notes: relevantNotes,
    existingSpecs: specFiles,
    previousCommits: commitRows.map((r) => r.commit_sha),
  };
}

/** Renders retrieved memory into a compact prompt block. */
export function renderMemoryForPrompt(memory: RetrievedMemory, opts?: { maxChars?: number }): string {
  const max = opts?.maxChars ?? 6000;
  const parts: string[] = [];

  if (memory.businessRules.length) {
    parts.push('PREVIOUSLY DISCOVERED BUSINESS RULES:');
    for (const rule of memory.businessRules) {
      parts.push(`  ${rule.id} [${rule.status}, confidence ${rule.confidence.toFixed(2)}] ${rule.description}`);
    }
  }
  if (memory.scenarios.length) {
    parts.push('', 'SCENARIOS ALREADY GENERATED (do not repeat these):');
    for (const s of memory.scenarios) {
      parts.push(`  ${s.id} [${s.category}] ${s.title}${s.coveredByExistingTest ? ` (covered by ${s.coveredByExistingTest})` : ''}`);
    }
  }
  if (memory.pastFailures.length) {
    parts.push('', 'PAST FAILURES FOR THESE SCENARIOS:');
    for (const f of memory.pastFailures) {
      parts.push(`  ${f.testTitle}: ${f.classification ?? 'unclassified'} (${f.resolution}, seen ${f.occurrenceCount}x)${f.isFlaky ? ' [known flaky]' : ''}`);
    }
  }
  if (memory.notes.length) {
    parts.push('', 'KNOWN APPLICATION BEHAVIOUR AND QA NOTES:');
    for (const n of memory.notes) parts.push(`  [${n.kind}] ${n.subject}: ${n.summary}`);
  }

  if (parts.length === 0) return 'NO PRIOR MEMORY: this is the first time this area has been analysed.';
  const text = parts.join('\n');
  return text.length > max ? `${text.slice(0, max)}\n... [memory truncated]` : text;
}

export { fromJson };
