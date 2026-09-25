/**
 * Deterministic relevance ranking for prompt context.
 *
 * Before anything reaches a model, the candidate tests, page objects and
 * fixtures are ranked against the thing being worked on (a feature or a set
 * of changed files) using names, paths and visited routes. Only the top of
 * that list is sent; the rest is counted, not shown.
 */
import type { ExistingTestInfo } from '@qa-agent/shared';

/** Words that appear in every path and say nothing about the feature. */
const NOISE = new Set([
  'src', 'app', 'apps', 'lib', 'libs', 'page', 'pages', 'index', 'component', 'components', 'test', 'tests',
  'spec', 'specs', 'cypress', 'playwright', 'tests', 'e2e', 'support', 'fixture', 'fixtures', 'the', 'and', 'for', 'new', 'feature',
  'features', 'layout', 'utils', 'util', 'types', 'jsx', 'tsx', 'json', 'module', 'modules', 'view', 'views',
]);

/** Splits camelCase, kebab-case, snake_case and paths into lowercase terms, singularized. */
export function terms(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((t) => (t.length > 4 && t.endsWith('s') ? t.slice(0, -1) : t))
    .filter((t) => t.length >= 3 && !NOISE.has(t));
}

export interface RelevanceSubject {
  names: string[];
  routes?: string[];
  files?: string[];
}

export function subjectTerms(subject: RelevanceSubject): Set<string> {
  return new Set([...subject.names, ...(subject.routes ?? []), ...(subject.files ?? [])].flatMap(terms));
}

/** Higher is more relevant; 0 means nothing links the test to the subject. */
export function scoreTest(test: ExistingTestInfo, subject: RelevanceSubject, subjectSet = subjectTerms(subject)): number {
  let score = 0;
  const routes = subject.routes ?? [];
  // A spec that visits the subject's route exercises it directly.
  if (test.visits.some((v) => routes.some((r) => r !== '/' && (v === r || v.startsWith(`${r}/`) || r.startsWith(v) && v !== '/')))) score += 5;
  for (const t of new Set(terms(test.file))) if (subjectSet.has(t)) score += 2;
  for (const t of new Set([...test.pageObjects, ...test.titles.slice(0, 20)].flatMap(terms))) if (subjectSet.has(t)) score += 1;
  return score;
}

/**
 * The most relevant tests first. Unrelated ones are dropped unless there is
 * spare room and nothing related exists at all - then a few are kept so the
 * model can still see the suite's conventions.
 */
export function rankTests(tests: ExistingTestInfo[], subject: RelevanceSubject, max: number): { selected: ExistingTestInfo[]; skipped: number } {
  const set = subjectTerms(subject);
  const scored = tests.map((t, i) => ({ t, i, score: scoreTest(t, subject, set) }))
    .sort((a, b) => b.score - a.score || a.i - b.i);
  const related = scored.filter((x) => x.score > 0);
  const chosen = (related.length ? related : scored.slice(0, Math.min(3, max))).slice(0, max).map((x) => x.t);
  return { selected: chosen, skipped: tests.length - chosen.length };
}
