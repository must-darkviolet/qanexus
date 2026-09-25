/**
 * The pull-request comment: the AI QA report.
 *
 *   Status (PASS / FAIL / BLOCKED) · Change Analysis · Affected Modules ·
 *   Tests Executed · Results · Authentication · Findings · Regression
 *   Assessment · Evidence · Browser Recording · Test Report · Conclusion
 *
 * Pure rendering - everything shown comes from the run's recorded data. A
 * diagnosis is labelled as a hypothesis, never as a confirmed defect; a link is
 * only rendered for a file that exists; a count is never shown for work that
 * did not run.
 */
import path from 'node:path';
import { failureCategory, type FailureCategory, type FailureRecord, type RunSummary, type TestResult } from '@qa-agent/shared';
import { COMMENT_MARKER } from '../github/pullRequests.js';
import type { PullRequestContext, RunDetails } from './orchestrator.js';
import type { TestDiagnostic } from '../playwright/preflight.js';

/**
 * passed: the required tests ran and passed · failed: they ran and some failed ·
 * blocked: they could not run (authentication, timeout, availability) ·
 * partial: some ran, others could not · error: the review itself failed.
 * No execution is never a pass.
 */
export type ReviewVerdict = 'passed' | 'failed' | 'blocked' | 'partial' | 'no_tests' | 'error' | 'cancelled';

export interface ArtifactLinker {
  /** A URL for one recording or screenshot, or null when files are not served. */
  link(filePath: string): string | null;
  /** One place where all of a run's recordings can be found (a CI run page, a folder). */
  where: string;
  /** Whether a file is really there; the report never points at one that is not. Default: trust the path. */
  exists?(filePath: string): boolean;
}

/** What changed since the previous review of this pull request. */
export interface SinceLastReview {
  previousHead: string;
  previousVerdict: string;
  /** Files changed between the previously reviewed head and this one; null when it could not be computed. */
  files: { path: string; status: string }[] | null;
  /** Tests that failed in the previous review. */
  previouslyFailed: string[];
}

export interface PrCommentInput {
  pr: PullRequestContext;
  run: RunSummary | null;
  details: RunDetails | null;
  baseUrl: string;
  artifacts: ArtifactLinker;
  /** Why the review could not run, when it could not. */
  error?: string | null;
  /** Someone stopped the review before it finished. */
  cancelled?: boolean;
  /** Notes about the environment (app started from the PR, not reachable, ...). */
  notes?: string[];
  aiSource?: string;
  sinceLastReview?: SinceLastReview | null;
}

/* -------------------------------------------------------------------------- */
/* Verdict                                                                     */
/* -------------------------------------------------------------------------- */

interface Tally { passed: number; failed: number; skipped: number; flaky: number; total: number; executed: number }

function tally(details: RunDetails): Tally {
  const e = details.execution;
  const repo = details.repoTests?.ran ? details.repoTests.results : [];
  const flakyGenerated = details.results.filter((r) => r.flaky).length;
  const count = (o: string) => repo.filter((r) => r.outcome === o).length;
  const generatedTotal = e ? e.total : 0;
  return {
    passed: (e?.passed ?? 0) + count('passed') + count('flaky'),
    failed: (e?.failed ?? 0) + count('failed'),
    skipped: (e ? e.skipped + e.pending : 0) + count('skipped'),
    flaky: flakyGenerated + count('flaky'),
    total: generatedTotal + repo.length,
    executed: (e ? e.passed + e.failed : 0) + count('passed') + count('flaky') + count('failed'),
  };
}

function diagnosisOf(details: RunDetails, result: Pick<TestResult, 'id' | 'title' | 'specFile'>): FailureRecord | undefined {
  return details.failures.find((f) => f.testResultId === result.id)
    ?? details.failures.find((f) => f.testTitle === result.title && f.specFile === result.specFile);
}

/** The category of every failed generated test; repository tests are not diagnosed and count as unknown. */
function failureCategories(details: RunDetails): FailureCategory[] {
  const generated = details.results.filter((r) => r.outcome === 'failed').map((r) => failureCategory(diagnosisOf(details, r)?.classification));
  const repo = (details.repoTests?.ran ? details.repoTests.results : []).filter((r) => r.outcome === 'failed').map((): FailureCategory => 'unknown');
  return [...generated, ...repo];
}

/** The authentication prerequisite failed for a protected module. */
function authBlocked(details: RunDetails): boolean {
  const state = details.authCheck?.state;
  return Boolean(state && state !== 'VERIFIED' && state !== 'NOT_REQUIRED');
}

/**
 * The review's findings as separate statuses, never conflated:
 *
 *   PR verification  PASSED   valid tests targeting the change ran and passed
 *                    FAILED   a valid targeted test failed, diagnosed as an application defect
 *                    UNVERIFIED  anything less: blocked, test-suite defects, incomplete
 *   Application      DEFECT CONFIRMED / DEFECT SUSPECTED / NO DEFECT FOUND / NOT CONFIRMED
 *   Test suite       OK / TEST BUG (preflight rejections or tests that broke on their own)
 *   Execution        COMPLETED / PARTIAL / BLOCKED_BY_AUTH / BLOCKED_BY_TEST_BUG / BLOCKED
 *   Regression       tests outside the change: PASSED / FAILURES DETECTED / NOT RUN
 *
 * A Playwright exit code is not a verdict: a test that failed before it
 * reached the application says nothing about the application.
 */
export interface Assessment {
  prVerification: 'PASSED' | 'FAILED' | 'UNVERIFIED';
  application: 'DEFECT CONFIRMED' | 'DEFECT SUSPECTED' | 'NO DEFECT FOUND' | 'NOT CONFIRMED';
  testSuite: 'OK' | 'TEST BUG' | 'INCOMPLETE';
  execution: 'COMPLETED' | 'PARTIAL' | 'BLOCKED_BY_AUTH' | 'BLOCKED_BY_TEST_BUG' | 'BLOCKED';
  regression: 'PASSED' | 'FAILURES DETECTED' | 'NOT RUN';
}

/** Specs that target the change (tier 1). A run with no tiers treats every spec as targeted. */
function prSpecs(details: RunDetails): Set<string> {
  const tier1 = details.selection.filter((s) => s.tier === 1).map((s) => s.specFile);
  return new Set(tier1.length ? tier1 : details.results.map((r) => r.specFile));
}

/** A product-defect diagnosis below this confidence is only suspected, and does not fail the PR. */
const CONFIRMED_CONFIDENCE = 0.9;

const isUnimplemented = (t: TestDiagnostic) => /^Not implemented/.test(t.problems[0] ?? '');

const categoryOf = (details: RunDetails, r: TestResult): FailureCategory => failureCategory(diagnosisOf(details, r)?.classification);

export function assess(details: RunDetails): Assessment {
  const targeted = prSpecs(details);
  const executedOf = (rs: TestResult[]) => rs.filter((r) => r.outcome === 'passed' || r.outcome === 'failed');
  const pr = executedOf(details.results.filter((r) => targeted.has(r.specFile)));
  const regression = executedOf(details.results.filter((r) => !targeted.has(r.specFile)));
  const prFailures = pr.filter((r) => r.outcome === 'failed');
  const cats = prFailures.map((r) => categoryOf(details, r));
  const unexecutable = details.preflight.filter((t) => !t.executable);
  const prUnexecutable = unexecutable.filter((t) => targeted.has(t.specFile));
  const allFailures = details.results.filter((r) => r.outcome === 'failed').map((r) => categoryOf(details, r));
  const t = tally(details);
  const auth = details.authentication;
  const signInsFailed = auth?.mode === 'real' && auth.failed > 0 && auth.succeeded === 0;

  const execution: Assessment['execution'] = authBlocked(details) || signInsFailed ? 'BLOCKED_BY_AUTH'
    : /UNEXECUTABLE_TEST/.test(details.executionError ?? '') ? 'BLOCKED_BY_TEST_BUG'
    : t.executed === 0 ? 'BLOCKED'
    : details.executionError || unexecutable.length ? 'PARTIAL'
    : 'COMPLETED';

  // A diagnosis is a hypothesis: only a confident one confirms a defect and fails the PR.
  const confirmed = prFailures.some((r) => categoryOf(details, r) === 'product_defect' && (diagnosisOf(details, r)?.confidence ?? 0) >= CONFIRMED_CONFIDENCE);
  const suspected = cats.includes('unknown') || (cats.includes('product_defect') && !confirmed);
  const prPassedCleanly = pr.length > 0 && cats.every((c) => c === 'preexisting') && prUnexecutable.length === 0
    && !details.executionError && !authBlocked(details) && !signInsFailed;
  // Only a failure diagnosed as an application defect fails the PR; an unexplained one needs a person, not a verdict.
  const prVerification: Assessment['prVerification'] = confirmed ? 'FAILED' : prPassedCleanly ? 'PASSED' : 'UNVERIFIED';

  return {
    prVerification,
    application: confirmed ? 'DEFECT CONFIRMED' : suspected ? 'DEFECT SUSPECTED' : prVerification === 'PASSED' ? 'NO DEFECT FOUND' : 'NOT CONFIRMED',
    // A broken test is a bug; a scenario nobody could implement is only incomplete coverage.
    testSuite: unexecutable.some((u) => !isUnimplemented(u)) || allFailures.includes('test_maintenance') ? 'TEST BUG'
      : unexecutable.length ? 'INCOMPLETE' : 'OK',
    execution,
    regression: regression.length === 0 ? 'NOT RUN' : regression.some((r) => r.outcome === 'failed') ? 'FAILURES DETECTED' : 'PASSED',
  };
}

export function reviewVerdict(
  run: RunSummary | null, details: RunDetails | null, error?: string | null, cancelled = false,
): ReviewVerdict {
  if (cancelled || run?.status === 'cancelled') return 'cancelled';
  if (error || !run || run.status === 'failed' || !details) return 'error';
  const a = assess(details);
  if (a.prVerification === 'PASSED') return 'passed';
  if (a.prVerification === 'FAILED') return 'failed';
  // Unverified: nothing valid got through (blocked), or only part of it did (partial).
  const anyPassed = details.results.some((r) => r.outcome === 'passed');
  return a.execution.startsWith('BLOCKED') || !anyPassed ? 'blocked' : 'partial';
}

const STATUS: Record<ReviewVerdict, string> = {
  passed: '✅ PASSED',
  failed: '❌ FAILED',
  blocked: '⚠️ BLOCKED',
  partial: '🟡 PARTIAL',
  no_tests: '⚠️ BLOCKED',
  error: '⚠️ BLOCKED',
  cancelled: '⏹️ CANCELLED',
};

const AUTH_LABEL: Record<string, string> = {
  VERIFIED: '✅ VERIFIED',
  NOT_REQUIRED: 'not required',
  AUTHENTICATION_REQUIRED: '❌ REQUIRED (no credentials)',
  AUTHENTICATION_FAILED: '❌ FAILED',
  AUTHENTICATED_ACCESS_FAILED: '❌ ACCESS FAILED',
};

const TIER_LABEL: Record<number, string> = { 1: 'Tier 1 · required', 2: 'Tier 2 · related', 3: 'Tier 3 · broader' };

/* -------------------------------------------------------------------------- */
/* Formatting helpers                                                          */
/* -------------------------------------------------------------------------- */

const RISK_ICON: Record<string, string> = { high: '🔴', medium: '🟠', low: '🟢' };
const OUTCOME_ICON: Record<string, string> = { passed: '✅', failed: '❌', skipped: '⏭️', pending: '🕓', flaky: '🔁' };

/** Keeps a value on one table row: no pipes, no newlines. */
function cell(text: string | number | null | undefined, max = 160): string {
  const value = String(text ?? '').replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

const code = (text: string) => `\`${text.replace(/`/g, "'")}\``;
const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : '?');
const seconds = (ms: number) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s` : `${Math.round(ms / 1000)}s`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function fileRef(file: string, artifacts: ArtifactLinker, label: string): string | null {
  if (artifacts.exists && !artifacts.exists(file)) return null;
  const url = artifacts.link(file);
  return url ? `[${label}](${url})` : `${label}: ${code(path.basename(path.dirname(file)) + '/' + path.basename(file))}`;
}

function mediaLinks(result: Pick<TestResult, 'videoPath' | 'screenshotPaths' | 'tracePath'>, artifacts: ArtifactLinker): string {
  return [
    result.videoPath ? fileRef(result.videoPath, artifacts, '🎥 recording') : null,
    ...result.screenshotPaths.slice(0, 2).map((s, i) => fileRef(s, artifacts, i === 0 ? '📷 screenshot' : '📷 screenshot 2')),
    result.tracePath ? fileRef(result.tracePath, artifacts, '🔍 trace') : null,
  ].filter(Boolean).join(' · ');
}

function firstLines(text: string | null, lines = 8, chars = 900): string {
  const value = (text ?? '').split('\n').slice(0, lines).join('\n');
  return value.length > chars ? `${value.slice(0, chars)}…` : value;
}

/** Playwright's own "Expected: … / Received: …" lines, when the error has them. */
function expectedAndActual(message: string | null): { expected: string | null; actual: string | null } {
  const text = message ?? '';
  const line = (label: RegExp) => text.split('\n').map((l) => l.trim()).find((l) => label.test(l))?.replace(label, '').trim() || null;
  return {
    expected: line(/^Expected( string| pattern| value|:)?:?\s*/i),
    actual: line(/^(Received|Actual)( string| value)?:?\s*/i),
  };
}

const CATEGORY_LABEL: Record<FailureCategory, string> = {
  product_defect: 'Possible product defect',
  infrastructure: 'Test environment / infrastructure',
  test_maintenance: 'Test needs updating',
  preexisting: 'Pre-existing, not caused by this PR',
  unknown: 'Not yet classified',
};

function severityOf(category: FailureCategory, moduleRisk: string | undefined, confidence: number | null): string {
  switch (category) {
    case 'product_defect':
      if (moduleRisk === 'high') return (confidence ?? 0) >= 0.8 ? '🔴 Critical' : '🔴 High';
      return moduleRisk === 'low' ? '🟡 Low' : '🟠 Medium';
    case 'infrastructure': return '⚠️ Blocker (environment)';
    case 'test_maintenance': return '🟡 Low';
    case 'preexisting': return 'ℹ️ Info';
    default: return '🟠 Medium';
  }
}

/** The generated suite's spec for a feature is tests/<feature>.spec.ts. */
const featureOfSpec = (specFile: string) => path.basename(specFile).replace(/\.spec\.[cm]?[jt]sx?$/, '');
/** The module a spec belongs to: from the test registry, else its file name. */
const moduleOf = (details: RunDetails, specFile: string) => details.specFeatures[specFile] || featureOfSpec(specFile);

/* -------------------------------------------------------------------------- */
/* The comment                                                                 */
/* -------------------------------------------------------------------------- */

export function renderPrComment(input: PrCommentInput): string {
  const { pr, run, details, artifacts } = input;
  const verdict = reviewVerdict(run, details, input.error, input.cancelled);
  const out: string[] = [COMMENT_MARKER, '## 🤖 AI QA Report', ''];

  out.push(`**Status:** ${STATUS[verdict]}${statusReason(verdict, details) ? ` — ${statusReason(verdict, details)}` : ''}`, '');
  if (details && verdict !== 'cancelled') {
    const a = assess(details);
    out.push('| PR verification | Application defect | Test suite | Execution | Regression suite |', '|---|---|---|---|---|');
    out.push(`| ${a.prVerification} | ${a.application} | ${a.testSuite} | ${a.execution} | ${a.regression} |`, '');
  }
  out.push(`**PR:** ${pr.number ? `#${pr.number}` : 'local review'} ${quoteAuthorText(cell(pr.title, 200))}`, '');
  out.push([
    `${code(pr.headRef)} → ${code(pr.baseRef)}`,
    `head ${code(short(details?.commitSha))}, compared with merge base ${code(short(details?.previousCommitSha))}`,
    `app ${input.baseUrl}`,
    run ? `run ${code(run.id.slice(0, 8))}` : null,
  ].filter(Boolean).join(' · '));

  if (verdict === 'cancelled') {
    out.push('', '> This review was cancelled from the QA dashboard before it produced results. Review the pull request again to get them.');
  } else if (input.error || (run?.status === 'failed' && run.error)) {
    out.push('', `> **Could not complete:** ${cell(input.error ?? run?.error ?? 'unknown error', 600)}`);
  }
  for (const note of input.notes ?? []) out.push('', `> ${note}`);

  if (!details) {
    out.push('', '### Conclusion', conclusion(verdict, null, input));
    out.push('', footer(input));
    return out.join('\n');
  }

  blocker(out, verdict, details, artifacts);
  changeAnalysis(out, input, details);
  behaviorCoverage(out, details);
  affectedModules(out, details, artifacts);
  testsExecuted(out, details);
  results(out, details);
  authentication(out, details, artifacts);
  findings(out, details, artifacts);
  regressionAssessment(out, details, input.sinceLastReview ?? null);
  evidence(out, details, artifacts);
  recordings(out, details, artifacts);
  testReport(out, details, artifacts);

  out.push('', '### Conclusion', conclusion(verdict, details, input));

  // Coverage measured after this run's tests executed, not the gaps the impact
  // analysis saw before they were written.
  const recs = (details.impact?.recommendations ?? []).slice(0, 6);
  // Only gaps in the modules this change reaches; the rest of the application is not this PR's concern.
  const affectedKeys = new Set((details.impact?.affectedFeatures ?? []).flatMap((f) => [f.key, f.name]));
  const gaps = (details.coverage?.gaps ?? details.impact?.coverage.gaps ?? [])
    .filter((g) => {
      if (affectedKeys.size === 0) return true;
      const feature = (g as { feature?: string | null }).feature;
      if (feature) return affectedKeys.has(feature);
      // Module-level gaps name the module in their subject.
      return g.kind !== 'feature' || affectedKeys.has(g.subject);
    }).slice(0, 6);
  if (recs.length || gaps.length) {
    out.push('', '<details><summary>Coverage gaps and regression recommendations</summary>', '');
    for (const g of gaps) out.push(`- **gap** (${g.kind}) ${g.subject}: ${g.reason}`);
    for (const r of recs) out.push(`- **${r.priority}** ${r.title} _(${r.source})_ — ${r.reasoning}`);
    out.push('</details>');
  }

  out.push('', footer(input));
  return out.join('\n');
}

/** The one-line reason the change could not be (fully) verified, or null. */
function blockerReason(details: RunDetails): string | null {
  const a = details.authCheck;
  if (a && authBlocked(details)) return `${a.state}: ${a.reason}`;
  if (details.executionError) return details.executionError;
  if (details.selection.length === 0) return 'No test was selected for the affected modules.';
  if (details.authentication?.mode === 'real' && details.authentication.succeeded === 0 && details.authentication.failed > 0) {
    return `Signing in failed in every test: ${details.authentication.failures[0] ?? 'unknown reason'}`;
  }
  const t = tally(details);
  if (t.executed === 0) return `None of the ${plural(t.total, 'discovered test')} executed (all skipped or not implemented).`;
  return null;
}

function statusReason(verdict: ReviewVerdict, details: RunDetails | null): string {
  if (!details) return verdict === 'error' ? 'the review could not run' : '';
  const t = tally(details);
  const a = assess(details);
  const blockedTests = details.preflight.filter((x) => !x.executable).length;
  switch (verdict) {
    case 'passed': {
      if (t.failed) return 'the tests targeting this change passed; other failures are pre-existing or outside the change';
      return t.skipped ? `${t.passed} of ${plural(t.total, 'test')} passed, ${t.skipped} skipped or not implemented` : `all ${plural(t.executed, 'executed test')} passed`;
    }
    case 'failed': return `${t.failed} of ${plural(t.executed, 'executed test')} failed, and a failure in a test targeting the change is not explained by the test itself`;
    case 'partial': {
      const pending = details.preflight.filter((x) => !x.executable && isUnimplemented(x)).length;
      const broken = blockedTests - pending;
      const why = [pending && `${plural(pending, 'scenario')} not implemented`, broken && `${plural(broken, 'test')} blocked by preflight validation`].filter(Boolean).join(', ');
      return `the change is only partly verified${why ? ` (${why})` : ''}`;
    }
    case 'blocked':
      if (a.execution === 'BLOCKED_BY_TEST_BUG') return 'every selected test was rejected by preflight validation, so no browser was launched';
      if (t.executed === 0) return 'no test was executed, so the change is unverified';
      return a.testSuite === 'TEST BUG' ? 'the executed tests failed because of the test suite, not the application' : 'every failure was caused by the test environment or sign-in, not by the application';
    case 'no_tests': return 'no test was executed for this change';
    case 'error': return 'the review could not complete';
    default: return '';
  }
}

function changeAnalysis(out: string[], input: PrCommentInput, details: RunDetails): void {
  const { pr } = input;
  out.push('', '### Change Analysis');
  out.push(`**Stated intent:** ${quoteAuthorText(cell(pr.title, 200))}`);
  const description = pr.body.replace(/<!--[\s\S]*?-->/g, '').trim();
  if (description) {
    const excerpt = description.length > 600 ? `${description.slice(0, 600)}…` : description;
    out.push(excerpt.split('\n').map((l) => `> ${quoteAuthorText(l)}`).join('\n'));
  } else {
    out.push('> _The pull request has no description; the change was analysed from the diff alone._');
  }

  const files = details.changedFiles;
  const byStatus = (s: string) => files.filter((f) => f.status === s).length;
  const kinds = [
    byStatus('added') && `${byStatus('added')} added`,
    byStatus('modified') && `${byStatus('modified')} modified`,
    byStatus('deleted') && `${byStatus('deleted')} deleted`,
    byStatus('renamed') && `${byStatus('renamed')} renamed`,
  ].filter(Boolean).join(', ');
  out.push('', `**${plural(files.length, 'file')} changed**${kinds ? ` (${kinds})` : ''}, ${files.reduce((n, f) => n + f.additions, 0)}+ / ${files.reduce((n, f) => n + f.deletions, 0)}−.`);

  const a = details.changeAreas;
  const areas = [
    a.ui && `UI components (${a.ui})`,
    a.routes && `routes (${a.routes})`,
    a.apis && `APIs (${a.apis})`,
    a.auth && `authentication / authorization (${plural(a.auth, 'file')})`,
    a.validations && `validation rules (${a.validations})`,
    a.businessLogic && `business logic (${plural(a.businessLogic, 'file')})`,
    a.tests && `tests (${plural(a.tests, 'file')})`,
  ].filter(Boolean);
  if (areas.length) out.push(`**Touches:** ${areas.join(' · ')}`);

  const summary = details.changeAnalysis?.summary || details.impact?.summary;
  if (summary) out.push('', summary.trim());
  if (details.impact?.fullRegressionAdvised) {
    out.push('', `> **Full regression advised:** ${cell(details.impact.fullRegressionReason ?? '', 400)}`);
  }

  const since = input.sinceLastReview;
  if (since) {
    out.push('', `**Since the last review** (${code(short(since.previousHead))}, ${since.previousVerdict}):`);
    if (!since.files) out.push('the previous head is no longer in the repository (force-pushed?), so everything was reviewed again.');
    else if (!since.files.length) out.push('no file changes; this review re-checks the same code.');
    else {
      out.push(since.files.slice(0, 12).map((f) => `${code(f.path)} (${f.status})`).join(', ')
        + (since.files.length > 12 ? `, and ${since.files.length - 12} more` : '') + '.');
    }
  }
}

function blocker(out: string[], verdict: ReviewVerdict, details: RunDetails, artifacts: ArtifactLinker): void {
  if (verdict !== 'blocked' && verdict !== 'partial') return;
  const reason = blockerReason(details);
  if (!reason) return;
  out.push('', '### Blocker', `> ⛔ ${cell(reason, 700)}`);
  const a = details.authCheck;
  if (a && authBlocked(details)) {
    const shot = a.evidence.screenshot ? fileRef(a.evidence.screenshot, artifacts, '📷 what the browser showed') : null;
    if (shot || a.evidence.url) out.push('', [shot, a.evidence.url ? `at ${code(a.evidence.url)}` : null].filter(Boolean).join(' '));
    if (/captcha/i.test(a.reason)) {
      out.push('', `**To unblock:** sign in once by hand with ${code(`npm run qa -- auth ${a.reason.match(/qa -- auth (\S+?)"/)?.[1] ?? '<project>'}`)} (the saved session is reused until it expires), or use CAPTCHA test keys in this environment.`);
    } else if (a.state === 'AUTHENTICATION_REQUIRED') {
      out.push('', `**To unblock:** set ${code('TEST_USER_EMAIL')} / ${code('TEST_USER_PASSWORD')} (or project credentials) for a test account, or save a session with ${code('npm run qa -- auth <project>')}.`);
    }
  }
}

/**
 * What the pull request changed, and for each scenario targeting it: how it is
 * proven (strategy, evidence source), and whether a valid test verified it.
 */
function behaviorCoverage(out: string[], details: RunDetails): void {
  const targeted = prSpecs(details);
  const prTests = details.preflight.filter((t) => targeted.has(t.specFile) && t.scenarioId);
  if (!details.changedBehaviors.length && !prTests.length) return;
  out.push('', '### PR Behavior Coverage');
  if (details.changedBehaviors.length) {
    out.push('**Changed behavior:**', ...details.changedBehaviors.map((b) => `- ${cell(b, 200)}`));
  }
  if (details.behaviorMap.length) {
    out.push('', '**Behavior map** (condition → action → observable effect):');
    for (const b of details.behaviorMap.slice(0, 10)) out.push(`- ${cell(b.condition, 90)} → ${cell(b.action, 90)} → ${cell(b.effect, 120)}`);
  }
  if (!prTests.length) return;

  const resultOf = (id: string) => details.results.find((r) => r.scenarioId === id);
  const rows = prTests.map((t) => {
    const r = resultOf(t.scenarioId!);
    let status: string;
    let reason: string;
    if (!t.executable && isUnimplemented(t)) {
      status = '⚪ NOT IMPLEMENTED';
      const tried = (t.strategiesAttempted ?? []).map((a) => `${a.strategy}: ${a.whyNot}`).join('; ');
      reason = `${t.problems[0]?.replace(/^Not implemented[^:]*:\s*/, '') ?? ''}${tried ? ` (tried ${tried})` : ''}`;
    } else if (!t.executable) {
      status = '⛔ BLOCKED';
      reason = `preflight: ${t.problems[0] ?? 'failed validation'}`;
    } else if (!r) {
      status = '⏭️ NOT RUN'; reason = details.executionError ?? 'not executed';
    } else if (r.outcome === 'passed') {
      status = '✅ VERIFIED'; reason = 'a valid test proved it';
    } else if (r.outcome === 'failed') {
      const cat = categoryOf(details, r);
      status = cat === 'product_defect' ? '❌ FAILED' : '⚠️ UNVERIFIED';
      reason = cat === 'test_maintenance' ? 'the test itself broke' : cat === 'infrastructure' ? 'the environment failed' : cat === 'product_defect' ? 'application defect' : 'failed, cause not established';
    } else {
      status = '⏭️ NOT RUN'; reason = `${r.outcome}${r.skipReason ? `: ${r.skipReason}` : ''}`;
    }
    return `| ${t.scenarioId} ${cell(t.title.replace(/^\[[^\]]+\]\s*/, ''), 70)} | ${t.strategy ?? '—'} | ${cell(t.evidenceSource ?? '—', 40)} | ${status} | ${cell(reason, 220)} |`;
  });
  out.push('', '| Scenario | Strategy | Evidence | Status | Reason |', '|---|---|---|---|---|', ...rows);
}

function affectedModules(out: string[], details: RunDetails, artifacts: ArtifactLinker): void {
  const affected = details.impact?.affectedFeatures ?? [];
  out.push('', '### Affected Modules');
  if (affected.length === 0) {
    out.push('No feature of the application was traced to these changes.');
    return;
  }
  const blocked = authBlocked(details);
  const protectedRoutes = new Set(details.authCheck?.protectedRoutes ?? []);
  out.push('| Module | Risk | Tier | Selected | Executable | Executed | Verified | Result | Authentication | Evidence |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const f of affected.slice(0, 15)) {
    const selected = details.selection.filter((s) => s.feature === f.key);
    const specsOf = new Set(selected.map((s) => s.specFile));
    const checked = details.preflight.filter((t) => specsOf.has(t.specFile));
    const rs = details.results.filter((r) => moduleOf(details, r.specFile) === f.key);
    const executed = rs.filter((r) => r.outcome === 'passed' || r.outcome === 'failed');
    const failed = executed.filter((r) => r.outcome === 'failed').length;
    const untested = checked.filter((t) => !t.executable).length;
    const brokenTests = executed.filter((r) => r.outcome === 'failed' && categoryOf(details, r) === 'test_maintenance').length;
    const result = executed.length === 0 ? (blocked || details.executionError || checked.length ? '⚠️ BLOCKED' : '⚪ UNVERIFIED')
      : failed && brokenTests === failed ? `⚠️ TEST BUG (${failed})`
      : failed ? `❌ FAIL (${failed})`
      : untested ? `🟡 PARTIAL (${executed.length} of ${checked.length})` : '✅ PASS';
    const routes = details.moduleRoutes[f.key] ?? [];
    const auth = !details.authCheck ? '—'
      : routes.some((r) => protectedRoutes.has(r)) || (details.authCheck.state !== 'NOT_REQUIRED' && routes.length === 0)
        ? AUTH_LABEL[details.authCheck.state] ?? details.authCheck.state
        : details.authCheck.state === 'NOT_REQUIRED' || routes.length ? 'not required' : '—';
    const exists = (x: string | null | undefined) => Boolean(x && (!artifacts.exists || artifacts.exists(x)));
    const evidence = [
      rs.some((r) => exists(r.videoPath)) && 'video',
      rs.some((r) => r.screenshotPaths.some(exists)) && 'screenshot',
      rs.some((r) => exists(r.tracePath)) && 'trace',
      executed.length === 0 && blocked && exists(details.authCheck?.evidence.screenshot) && 'login screenshot',
    ].filter(Boolean).join(' + ') || '—';
    const tier = selected.length ? `${Math.min(...selected.map((s) => s.tier))}` : '—';
    // Verified only when valid tests ran, none failed, and none of the module's scenarios went untested.
    const verified = executed.length > 0 && failed === 0 && untested === 0 ? '✅' : executed.length > 0 && failed === 0 ? '◐ partly' : '—';
    const testsSelected = checked.length || selected.length;
    out.push(`| ${cell(f.name)} | ${RISK_ICON[f.risk] ?? ''} ${f.risk} | ${tier} | ${testsSelected} | ${checked.length ? checked.filter((t) => t.executable).length : '—'} | ${executed.length} | ${verified} | ${result} | ${auth} | ${evidence} |`);
  }
  if (affected.length > 15) out.push(`\n…and ${affected.length - 15} more.`);
  out.push('', '<details><summary>Why each module was implicated</summary>', '');
  for (const f of affected.slice(0, 15)) {
    out.push(`- **${cell(f.name)}** — ${cell(f.changedFiles.slice(0, 3).map((x) => code(x)).join(', ') || 'no file of its own', 220)}: ${cell(f.reasons[0] ?? '', 220)}`);
  }
  out.push('</details>');
}

function testsExecuted(out: string[], details: RunDetails): void {
  out.push('', '### Tests Executed');

  const bySpec = new Map<string, TestResult[]>();
  for (const r of details.results) bySpec.set(r.specFile, [...(bySpec.get(r.specFile) ?? []), r]);
  const changeOf = new Map(details.testChanges.map((t) => [t.file, t.change]));
  const repo = details.repoTests;

  if (details.selection.length) {
    out.push(`**Selected for this change** (${plural(details.selection.length, 'spec')}, by tier):`);
    const lines = details.selection.map((sel) => {
      const rs = bySpec.get(sel.specFile) ?? [];
      const mark = changeOf.get(sel.specFile) === 'new' ? '🆕 ' : changeOf.get(sel.specFile) === 'updated' ? '✏️ ' : '';
      const counts = (['passed', 'failed', 'skipped', 'pending'] as const)
        .map((o) => [o, rs.filter((r) => r.outcome === o).length] as const)
        .filter(([, n]) => n).map(([o, n]) => `${OUTCOME_ICON[o]} ${n}`).join(' ');
      return `- ${TIER_LABEL[sel.tier]} · ${mark}${code(sel.specFile)} — ${rs.length ? `${plural(rs.length, 'test')}: ${counts}` : '**not run**'} · _${cell(sel.reasons[0] ?? '', 140)}_`;
    });
    pushMaybeCollapsed(out, lines, 12, 'every selected spec');
  } else {
    out.push('No generated spec was selected for the affected modules.');
  }

  if (repo) {
    out.push('', `**The repository's own tests** (${code(repo.configFile)}, run with its own configuration and fixtures):`);
    if (!repo.ran) {
      out.push(`Not run: ${cell(repo.skippedReason ?? 'unknown reason', 400)}`);
    } else {
      const bySpecRepo = new Map<string, typeof repo.results>();
      for (const r of repo.results) bySpecRepo.set(r.specFile, [...(bySpecRepo.get(r.specFile) ?? []), r]);
      const lines = repo.selected.map((sel) => {
        const rs = bySpecRepo.get(sel.spec) ?? [];
        const counts = (['passed', 'flaky', 'failed', 'skipped'] as const)
          .map((o) => [o, rs.filter((r) => r.outcome === o).length] as const)
          .filter(([, n]) => n).map(([o, n]) => `${OUTCOME_ICON[o]} ${n}`).join(' ');
        return `- ${code(sel.spec)} — ${counts || 'no result'} · _${cell(sel.reasons[0] ?? 'related', 120)}_`;
      });
      pushMaybeCollapsed(out, lines, 12, 'every repository spec');
    }
  }

  const tc = details.testChanges;
  if (tc.length || details.rejectedTests.length) {
    out.push('', '**Tests written or updated:**');
    for (const t of tc) out.push(`- ${t.change === 'new' ? '🆕' : '✏️'} ${code(t.file)} (${t.change === 'new' ? 'new' : 'updated'}) · ${plural(t.scenarios, 'scenario')} · module ${code(t.feature)}`);
    for (const r of details.rejectedTests) {
      out.push(`- ⛔ ${code(r.file)} rejected, not run: breaks ${r.reasons.map(code).join(', ')}. The previous version (if any) was kept.`);
    }
  } else {
    out.push('', 'No test file needed to change: the existing generated tests already match this code.');
  }
}

function results(out: string[], details: RunDetails): void {
  out.push('', '### Execution');
  const t = tally(details);
  const m = details.executionMeta;
  const notRun = Math.max(0, (m.discovered ?? t.total) - t.total);
  out.push(`- Selected specs: ${details.selection.length}`);
  if (m.discovered !== null) out.push(`- Tests discovered: ${m.discovered}`);
  out.push(`- **Executed: ${t.executed}**`);
  out.push(`- ✅ Passed: ${t.passed}`);
  out.push(`- ❌ Failed: ${t.failed}`);
  const reasons = [...new Set(details.results.filter((r) => r.skipReason).map((r) => r.skipReason!))].slice(0, 2);
  out.push(`- ⏭️ Skipped: ${t.skipped}${reasons.length ? ` (${reasons.map((r) => cell(r, 120)).join('; ')})` : ''}`);
  if (t.flaky) out.push(`- 🔁 Flaky: ${t.flaky} (failed, then passed when retried; counted as passed)`);
  if (notRun) out.push(`- ⚪ Not run: ${notRun} (the run was cut short)`);
  if (details.execution) out.push(`- Duration: ${seconds(details.execution.durationMs)}`);
  if (details.executionError) {
    // The blocker section already carries the full reason when authentication stopped the run.
    const text = authBlocked(details) ? 'blocked by authentication (see the Blocker above).' : cell(details.executionError, 600);
    out.push('', `> **${t.executed ? 'Execution incomplete' : 'Tests could not run'}:** ${text}`);
  }
  const repo = details.repoTests?.ran ? details.repoTests.results.length : 0;
  const notes = [
    repo && details.execution ? `${details.execution.total} generated + ${repo} from the repository's own suite.` : null,
    t.executed ? 'Every failure was retried once before being reported.' : null,
    m.command ? `Command: ${code(m.command)}${m.exitCode !== null ? `, exit code ${m.exitCode}` : ''}.` : null,
  ].filter(Boolean);
  if (notes.length) out.push('', `<sub>${notes.join(' ')}</sub>`);
}

function authentication(out: string[], details: RunDetails, artifacts: ArtifactLinker): void {
  out.push('', '### Authentication');
  const check = details.authCheck;
  const a = details.authentication;
  if (check) {
    const protectedList = check.protectedRoutes.map(code).join(', ');
    switch (check.state) {
      case 'VERIFIED':
        out.push(`✅ Authentication verified (${check.source === 'saved-session' ? 'saved session' : "the application's own login form"}, role ${code(check.role)}): `
          + `${protectedList} opened signed in. The walkthrough and every generated test used this session.`);
        break;
      case 'NOT_REQUIRED':
        out.push(`ℹ️ Not required: the affected route(s) ${check.publicRoutes.map(code).join(', ') || ''} open without signing in.`);
        break;
      default: {
        out.push(`❌ **${check.state}**${protectedList ? ` for ${protectedList}` : ''}: ${cell(check.reason, 500)}`);
        out.push('', `Login attempted: ${check.loginAttempted ? 'yes' : 'no'}. Protected tests were **not run** and the protected pages were not walked through, so nothing behind the login was tested.`);
        const shot = check.evidence.screenshot ? fileRef(check.evidence.screenshot, artifacts, '📷 screenshot') : null;
        if (shot) out.push('', `Evidence: ${shot}${check.evidence.url ? ` at ${code(check.evidence.url)}` : ''}`);
      }
    }
  }
  if (a?.mode === 'real' && a.failed > 0) {
    out.push('', `${a.succeeded ? '⚠️' : '❌'} Signing in failed in ${a.failed} of ${plural(a.attempts, 'test')}:`);
    for (const f of a.failures) out.push(`- ${cell(f, 240)}`);
  } else if (a?.mode === 'stubbed') {
    out.push('', `⚠️ Tests ran with a simulated session (${code('TEST_MOCK_API=1')}), not a real login.`);
  } else if (!check && !a) {
    out.push('Not assessed: no test was executed.');
  }
  if (a?.fallbacks.length) out.push('', `Roles with no account of their own were tested as the ordinary user: ${a.fallbacks.map(code).join(', ')}.`);
  if (details.repoTests?.ran) out.push('', "The repository's own tests used their own authentication setup (fixtures, storage state or login helpers).");
}

/** Failures that share one cause: the same first error line (and the same locator it waited for). */
export function rootCauseKey(message: string | null): string {
  const lines = (message ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const head = (lines[0] ?? 'unknown error').replace(/\d+(ms)?/g, 'N');
  const waiting = lines.find((l) => /^-?\s*waiting for /.test(l)) ?? '';
  return `${head}\u0000${waiting}`;
}

/** Whether a failure happened before the test reached the application (a defect in the test code). */
function reachedApplication(r: TestResult): boolean {
  const first = (r.errorMessage ?? '').split('\n')[0] ?? '';
  if (/^(ReferenceError|TypeError|SyntaxError)\b/.test(first)) return false;
  return Boolean(r.pageUrl && r.pageUrl !== 'about:blank');
}

function findings(out: string[], details: RunDetails, artifacts: ArtifactLinker): void {
  out.push('', '### Findings');
  const failed = details.results.filter((r) => r.outcome === 'failed');
  const repoFailed = details.repoTests?.ran ? details.repoTests.results.filter((r) => r.outcome === 'failed') : [];
  const blocked = details.preflight.filter((t) => !t.executable);
  const a = assess(details);

  if (failed.length === 0 && repoFailed.length === 0 && blocked.length === 0) {
    const t = tally(details);
    if (t.executed === 0) {
      out.push('No product findings can be concluded because the affected functionality was not executed.');
    } else if (details.executionError || authBlocked(details)) {
      out.push(`No failures among the ${plural(t.executed, 'test')} that ran, but the run was incomplete (see the Blocker), so this is not a pass.`);
    } else {
      out.push(`No findings: all ${plural(t.executed, 'executed test')} passed.`);
    }
    return;
  }

  /* -- Tests rejected before execution, grouped by their first problem ------- */
  if (blocked.length) {
    const groups = new Map<string, TestDiagnostic[]>();
    for (const t of blocked) {
      const key = `${t.specFile}\u0000${(t.problems[0] ?? 'failed preflight').replace(/"[^"]*"/g, '"…"')}`;
      groups.set(key, [...(groups.get(key) ?? []), t]);
    }
    for (const group of groups.values()) {
      const first = group[0]!;
      out.push('', isUnimplemented(first)
        ? `<details><summary>⚪ <b>NOT IMPLEMENTED</b> — ${plural(group.length, 'scenario')} with no executable test in ${escapeHtml(first.specFile)}</summary>`
        : `<details><summary>🧪 <b>TEST SUITE BUG</b> — ${plural(group.length, 'scenario')} blocked before execution (UNEXECUTABLE_TEST) in ${escapeHtml(first.specFile)}</summary>`, '');
      out.push(`**${isUnimplemented(first) ? 'Why' : 'Root cause'}:** ${cell(first.problems[0] ?? 'failed preflight validation', 400)}`, '');
      out.push(`**Affected scenarios:** ${group.map((t) => t.scenarioId ?? cell(t.title, 60)).join(', ')}`, '');
      out.push('Application interaction: **NOT REACHED** (never launched) · Application defect: **NOT CONFIRMED** · PR verification: **UNVERIFIED**', '');
      for (const t of group) {
        const failedGates = Object.entries(t.gates).filter(([k, v]) => !v && k !== 'pr_relevant').map(([k]) => k);
        out.push(`- **${t.scenarioId ?? '—'}** ${cell(t.title.replace(/^\[[^\]]+\]\s*/, ''), 110)} — failed ${failedGates.map(code).join(', ')}; assertions ${t.assertions}; actions ${t.actions.join(', ') || 'none'}`);
        const missing = Object.entries(t.declared).filter(([, v]) => v === 'MISSING').map(([k]) => code(k));
        if (missing.length) out.push(`  - undeclared: ${missing.join(', ')}`);
        if (t.semanticReason) out.push(`  - ${cell(t.semanticReason, 300)}`);
      }
      out.push('</details>');
    }
  }

  /* -- Executed failures, consolidated by root cause ------------------------- */
  if (failed.length) {
    out.push('', '_Each diagnosis is a hypothesis drawn from the evidence, not a confirmed defect. Failures were reproduced on a retry before being reported; failures that share one cause are reported once._');
  }
  const targeted = prSpecs(details);
  const groups = new Map<string, TestResult[]>();
  for (const r of failed) groups.set(rootCauseKey(r.errorMessage), [...(groups.get(rootCauseKey(r.errorMessage)) ?? []), r]);
  const riskOf = new Map((details.impact?.affectedFeatures ?? []).flatMap((f) => [[f.key, f], [f.name, f]] as const));

  let shown = 0;
  for (const group of groups.values()) {
    if (shown++ >= 15) break;
    const result = group[0]!;
    const d = diagnosisOf(details, result);
    const category = categoryOf(details, result);
    const scenario = result.scenarioId ? details.scenarios[result.scenarioId] : undefined;
    const feature = riskOf.get(scenario?.feature ?? '') ?? riskOf.get(moduleOf(details, result.specFile));
    const moduleName = d?.affectedArea || feature?.name || scenario?.feature || moduleOf(details, result.specFile);
    const { expected, actual } = expectedAndActual(result.errorMessage);
    const severity = severityOf(category, feature?.risk, d?.confidence ?? null);
    const reached = group.some(reachedApplication);
    const label = d?.classification
      ? `${CATEGORY_LABEL[category]} (${d.classification}${d.confidence !== null ? ` · ${Math.round(d.confidence * 100)}%` : ''})`
      : CATEGORY_LABEL[category];
    const inPr = group.some((r) => targeted.has(r.specFile));
    const defect = category === 'product_defect' && inPr && (d?.confidence ?? 0) >= CONFIRMED_CONFIDENCE ? 'CONFIRMED'
      : (category === 'unknown' || category === 'product_defect') && inPr ? 'SUSPECTED' : 'NOT CONFIRMED';

    const headline = group.length > 1
      ? `${category === 'test_maintenance' ? '🧪 <b>TEST SUITE BUG</b> — ' : `${severity} · `}${plural(group.length, 'scenario')} failed from one cause: <b>${escapeHtml(firstLines(result.errorMessage, 1, 140))}</b>`
      : `${severity} · ❌ <b>${escapeHtml(result.title)}</b> — ${escapeHtml(label)}`;
    out.push('', `<details><summary>${headline}</summary>`, '');
    if (group.length > 1) {
      out.push(`**Affected scenarios:** ${group.map((r) => r.scenarioId ?? cell(r.title, 60)).join(', ')} (in ${[...new Set(group.map((r) => code(r.specFile)))].join(', ')})`, '');
    }
    out.push(`Application interaction: **${reached ? 'REACHED' : 'NOT REACHED'}** · Application defect: **${defect}** · ${inPr ? `PR verification: **${a.prVerification}**` : 'Regression test (outside the change)'}`, '');
    out.push('| | |', '|---|---|');
    out.push(`| **Severity** | ${severity} |`);
    out.push(`| **Classification** | ${escapeHtml(label)} |`);
    out.push(`| **Module** | ${cell(moduleName)} |`);
    if (group.length === 1) {
      out.push(`| **Scenario** | ${cell(scenario?.title ?? result.title, 240)}${scenario ? ` _(${scenario.category}, ${scenario.priority})_` : ''} |`);
      out.push(`| **Expected** | ${cell(scenario?.expectedResult ?? expected ?? 'see the error below', 300)}${scenario && expected ? ` (assertion expected ${cell(expected, 120)})` : ''} |`);
      out.push(`| **Actual** | ${cell(actual ?? firstLines(result.errorMessage, 1, 240), 300)} |`);
    }
    if (result.pageUrl) out.push(`| **URL** | ${cell(result.pageUrl, 200)} |`);
    const media = mediaLinks(result, artifacts);
    out.push(`| **Evidence** | ${media || 'no recording was produced'} |`);
    if (d?.rootCause) out.push(`| **Likely cause** | ${cell(d.rootCause, 400)} |`);
    if (d?.recommendedAction) out.push(`| **Recommended action** | ${cell(d.recommendedAction, 300)} |`);
    if (group.length === 1) out.push(`| **Spec** | ${code(result.specFile)} |`);

    const consoleErrors = result.consoleLogs.filter((l) => /^\[(error|uncaught)\]/.test(l)).slice(0, 5);
    const networkFailures = result.networkLogs.filter((l) => /-> (FAILED|[45]\d\d)\b/.test(l)).slice(0, 5);
    out.push('', '```', firstLines(result.errorMessage), '```');
    if (consoleErrors.length) out.push('', '**Console errors**', '```', ...consoleErrors.map((l) => l.slice(0, 300)), '```');
    if (networkFailures.length) out.push('', '**Failed requests**', '```', ...networkFailures.map((l) => l.slice(0, 300)), '```');
    out.push('</details>');
  }
  if (groups.size > 15) out.push('', `…and ${groups.size - 15} more root cause(s).`);

  for (const r of repoFailed.slice(0, 10)) {
    out.push('', `<details><summary>🟠 Medium · ❌ <b>${escapeHtml(r.title)}</b> — repository test, not yet classified</summary>`, '');
    out.push(`- **Spec:** ${code(r.specFile)}${r.project ? ` (project ${code(r.project)})` : ''}`);
    const media = mediaLinks({ videoPath: r.videoPath, screenshotPaths: r.screenshotPaths, tracePath: r.tracePath }, artifacts);
    if (media) out.push(`- **Evidence:** ${media}`);
    out.push('', '```', firstLines(r.errorMessage), '```', '</details>');
  }
}

function regressionAssessment(out: string[], details: RunDetails, since: SinceLastReview | null): void {
  out.push('', '### Regression Assessment');
  const affected = details.impact?.affectedFeatures ?? [];
  const bySpecFeature = new Map<string, TestResult[]>();
  for (const r of details.results) {
    const key = moduleOf(details, r.specFile);
    bySpecFeature.set(key, [...(bySpecFeature.get(key) ?? []), r]);
  }

  if (affected.length) {
    out.push('| Module | Risk | Tests run | Result |', '|---|---|---|---|');
    for (const f of affected.slice(0, 15)) {
      const rs = bySpecFeature.get(f.key) ?? [];
      const failed = rs.filter((r) => r.outcome === 'failed').length;
      const ran = rs.filter((r) => r.outcome === 'passed' || r.outcome === 'failed').length;
      const result = ran === 0 ? '⚪ not tested' : failed ? `❌ ${failed} failed` : '✅ passed';
      out.push(`| ${cell(f.name)} | ${RISK_ICON[f.risk] ?? ''} ${f.risk} | ${ran} | ${result} |`);
    }
    const untested = affected.filter((f) => !(bySpecFeature.get(f.key) ?? []).some((r) => r.outcome === 'passed' || r.outcome === 'failed'));
    if (untested.length) {
      out.push('', `${plural(untested.length, 'affected module')} had no executed generated test: ${untested.slice(0, 8).map((f) => f.name).join(', ')}. Treat ${untested.length === 1 ? 'it' : 'them'} as unverified.`);
    }
  } else {
    out.push('No module was traced to this change, so no targeted regression applies.');
  }

  const others = [...bySpecFeature.keys()].filter((k) => !affected.some((f) => f.key === k));
  if (others.length) {
    const failedOthers = others.filter((k) => bySpecFeature.get(k)!.some((r) => r.outcome === 'failed'));
    out.push('', `Related regression specs outside the directly affected modules: ${plural(others.length, 'module')}, ${failedOthers.length ? `${failedOthers.length} with failures (${failedOthers.slice(0, 5).map(code).join(', ')})` : 'all passing'}.`);
  }
  const repo = details.repoTests;
  if (repo?.ran) {
    const failed = repo.results.filter((r) => r.outcome === 'failed').length;
    out.push('', `The repository's own related tests: ${failed ? `❌ ${failed} of ${repo.results.length} failed` : `✅ all ${repo.results.length} passed`}.`);
  }

  if (since?.previouslyFailed.length) {
    const now = new Map(details.results.map((r) => [r.title, r.outcome]));
    const fixed = since.previouslyFailed.filter((t) => now.get(t) === 'passed');
    const still = since.previouslyFailed.filter((t) => now.get(t) === 'failed');
    const notRun = since.previouslyFailed.filter((t) => !now.has(t));
    out.push('', '**Previously failing tests:**');
    if (fixed.length) out.push(`- ✅ now passing: ${fixed.slice(0, 8).map((t) => cell(t, 80)).join('; ')}`);
    if (still.length) out.push(`- ❌ still failing: ${still.slice(0, 8).map((t) => cell(t, 80)).join('; ')}`);
    if (notRun.length) out.push(`- ⚪ not re-run this time: ${notRun.slice(0, 8).map((t) => cell(t, 80)).join('; ')}`);
  }
}

/** Tests the review corrected by itself: rejected by preflight or broken while running, fixed, checked and run again. */
function selfHealing(out: string[], details: RunDetails): void {
  const healed = (details.repairs ?? []).filter((r) => /rejected by preflight|broke by itself|written from the traced journey/.test(r));
  if (!healed.length) return;
  out.push('', '### Self-healing', `<details><summary>${healed.length} test correction(s) made during this review</summary>`, '');
  for (const r of healed.slice(0, 30)) out.push(`- ${escapeHtml(r)}`);
  out.push('</details>');
}

function evidence(out: string[], details: RunDetails, artifacts: ArtifactLinker): void {
  selfHealing(out, details);
  const walk = details.exploration;
  out.push('', '### Evidence');
  out.push('_Per-failure evidence (recording, screenshot, trace, console, network) is under each finding above._', '');
  if (!walk.enabled) {
    out.push(`Recorded walkthrough of the affected pages: not recorded (${walk.reason ?? 'disabled'}).`);
    return;
  }
  if (walk.pages.length === 0) {
    out.push('Recorded walkthrough of the affected pages: no affected page to visit.');
    return;
  }
  out.push('**Recorded walkthrough of the affected pages**', '');
  out.push('| Route | Page | Load | Console errors | Recording |', '|---|---|---|---|---|');
  for (const page of walk.pages) {
    const status = !page.loaded ? '❌ did not load'
      : page.statusCode && page.statusCode >= 400 ? `❌ HTTP ${page.statusCode}`
      : page.redirectedTo ? `↪️ redirected to ${code(page.redirectedTo)}` : '✅ loaded';
    const media = mediaLinks({ videoPath: page.videoPath, screenshotPaths: page.screenshotPath ? [page.screenshotPath] : [], tracePath: null }, artifacts);
    out.push(`| ${code(page.route)} | ${status} | ${page.loaded ? `${page.loadTimeMs}ms` : '—'} | ${page.consoleErrors.length || '—'} | ${media || '—'} |`);
  }
  if (walk.discrepancies.length) {
    out.push('', '<details><summary>Differences between the code and what the browser showed</summary>', '');
    out.push(...groupDiscrepancies(walk.discrepancies).slice(0, 25));
    out.push('', '_The walkthrough visits each page as a signed-out user against the real API, so pages that sign in or load data first can legitimately differ._');
    out.push('</details>');
  }
}

function recordings(out: string[], details: RunDetails, artifacts: ArtifactLinker): void {
  out.push('', '### Browser Recording');
  const real = (file: string | null | undefined): file is string => Boolean(file && (!artifacts.exists || artifacts.exists(file)));
  const tests = details.results.filter((r) => real(r.videoPath));
  const repo = (details.repoTests?.ran ? details.repoTests.results : []).filter((r) => real(r.videoPath));
  const pages = details.exploration.pages.filter((p) => real(p.videoPath));
  const total = tests.length + repo.length + pages.length;
  if (total === 0) {
    out.push('No browser recording was produced.');
    return;
  }
  // Failures first: those are the recordings a reviewer needs.
  const ordered = [...tests].sort((a, b) => Number(b.outcome === 'failed') - Number(a.outcome === 'failed'));
  const lines = [
    ...ordered.map((r) => `- ${OUTCOME_ICON[r.outcome] ?? ''} ${fileRef(r.videoPath!, artifacts, `🎥 ${cell(r.title, 90)}`)}`),
    ...repo.map((r) => `- ${OUTCOME_ICON[r.outcome] ?? ''} ${fileRef(r.videoPath!, artifacts, `🎥 ${cell(r.title, 90)}`)} _(repository test)_`),
    ...pages.map((p) => `- ${fileRef(p.videoPath!, artifacts, `🎥 walkthrough of ${p.route}`)}`),
  ];
  out.push(`${plural(total, 'recording')}: ${tests.length} generated test(s), ${repo.length} repository test(s), ${pages.length} walkthrough page(s).`);
  pushMaybeCollapsed(out, lines, 8, 'every recording');
  out.push('', artifacts.where);
}

function testReport(out: string[], details: RunDetails, artifacts: ArtifactLinker): void {
  out.push('', '### Test Report');
  const reports: [string, string][] = [];
  if (details.htmlReport) reports.push([details.htmlReport, '📊 View Full Playwright Report']);
  const repoReport = details.repoTests?.reportDir ? path.join(details.repoTests.reportDir, 'index.html') : null;
  if (repoReport) reports.push([repoReport, "📊 Repository tests' Playwright report"]);
  const refs = reports.map(([file, label]) => fileRef(file, artifacts, label)).filter(Boolean);
  if (!refs.length) {
    out.push('No Playwright HTML report was produced for this review.');
    return;
  }
  for (const ref of refs) out.push(`- ${ref}`);
  if (!artifacts.link(reports[0]![0])) out.push('', `${artifacts.where} Open ${code('index.html')} with ${code('npx playwright show-report <folder>')}.`);
}

function conclusion(verdict: ReviewVerdict, details: RunDetails | null, input: PrCommentInput): string {
  if (verdict === 'cancelled') return 'The review was cancelled; nothing here is a result.';
  if (!details) return 'The review could not run, so this pull request has not been tested. Resolve the problem above and review it again.';
  const assessment = assess(details);
  if (assessment.execution === 'BLOCKED_BY_TEST_BUG') {
    return 'This PR could not be verified: every selected test was rejected by preflight validation (a defect in the generated test suite, not in the application), so no browser was launched. '
      + 'No product defect or pass conclusion is made. The test-suite findings above say what to fix.';
  }
  if (verdict === 'blocked' && assessment.testSuite === 'TEST BUG' && tally(details).executed > 0) {
    return 'This PR could not be verified: the tests that ran failed because of defects in the test suite, not the application. '
      + 'Application defect: not confirmed. Fix the test-suite findings above and review again.';
  }
  if (verdict === 'blocked' && tally(details).executed === 0) {
    return 'This PR could not be verified. No product defect or pass conclusion is made because the affected tests were not executed. '
      + 'Resolve the blocker above and review it again.';
  }
  if (verdict === 'partial') {
    const t = tally(details);
    if (assessment.testSuite === 'TEST BUG') {
      return `${plural(t.executed, 'test')} ran; the rest of the change is unverified because of test-suite defects (see the findings). `
        + `Application defect: ${assessment.application.toLowerCase()}. This is not a pass.`;
    }
    return `${plural(t.executed, 'test')} ran without a product failure, but the review was incomplete (${cell(blockerReason(details) ?? 'see the Blocker', 200)}). `
      + 'The parts that did not run are unverified; this is not a pass.';
  }
  const t = tally(details);
  const modules = (details.impact?.affectedFeatures ?? []).length;
  const cats = failureCategories(details);
  const count = (c: FailureCategory) => cats.filter((x) => x === c).length;
  const auth = details.authentication?.mode === 'real' ? ' with real, verified sign-in'
    : details.authentication?.mode === 'stubbed' ? ' with a simulated session (no real login)' : '';
  switch (verdict) {
    case 'passed': {
      const ran = t.passed + t.failed;
      const untested = (details.impact?.affectedFeatures ?? []).filter((f) => !details.results.some((r) => moduleOf(details, r.specFile) === f.key && (r.outcome === 'passed' || r.outcome === 'failed')));
      const caveats = [
        untested.length && `${plural(untested.length, 'affected module')} (${untested.slice(0, 5).map((f) => f.name).join(', ')}) had no executed test`,
        details.impact?.fullRegressionAdvised && 'a full regression run was advised for this change',
        t.skipped && `${plural(t.skipped, 'test')} did not run`,
        details.authentication?.mode === 'stubbed' && 'sign-in was simulated',
      ].filter(Boolean);
      return `${plural(ran, 'executed test')} across the affected modules passed${auth}, and nothing attributable to this change failed.`
        + (count('preexisting') ? ` ${plural(count('preexisting'), 'failure')} already happened before this change and should be tracked separately.` : '')
        + (t.flaky ? ` ${plural(t.flaky, 'test')} only passed on a retry; keep an eye on ${t.flaky === 1 ? 'it' : 'them'}.` : '')
        + (caveats.length
          ? ` Coverage is incomplete, though: ${caveats.join('; ')}. Those areas are unverified and worth a manual check before merging.`
          : ' No further investigation is needed for this pull request.');
    }
    case 'failed': {
      const parts = [
        count('product_defect') && `${plural(count('product_defect'), 'failure')} look${count('product_defect') === 1 ? 's' : ''} like a product defect and should be investigated before merging`,
        count('test_maintenance') && `${plural(count('test_maintenance'), 'test')} need${count('test_maintenance') === 1 ? 's' : ''} updating to follow the change`,
        count('unknown') && `${plural(count('unknown'), 'failure')} could not be classified and need${count('unknown') === 1 ? 's' : ''} a human look`,
        count('infrastructure') && `${plural(count('infrastructure'), 'failure')} came from the test environment`,
      ].filter(Boolean);
      return `${t.failed} of ${plural(t.passed + t.failed, 'executed test')} failed${auth}. ${parts.join('; ')}. See the findings above for the evidence.`;
    }
    case 'blocked':
      return `The change could not be verified: ${statusReason(verdict, details)}. Fix the environment or credentials and review again; this is not a verdict on the code.`;
    case 'no_tests':
      return 'No test ran, so this pull request is not verified. Check the regression assessment for modules that need coverage.';
    default:
      return `The review did not complete${input.error ? '' : ` (${details.executionError ?? 'unknown error'})`}, so this pull request is not verified.`;
  }
}

function pushMaybeCollapsed(out: string[], lines: string[], visible: number, what: string): void {
  out.push(...lines.slice(0, visible));
  if (lines.length > visible) {
    out.push('', `<details><summary>${lines.length - visible} more — ${what}</summary>`, '', ...lines.slice(visible), '</details>');
  }
}

function footer(input: PrCommentInput): string {
  const source = input.aiSource && input.aiSource !== 'fallback' ? `AI-assisted (${input.aiSource})` : 'deterministic analysis';
  return `<sub>Generated by QA Intelligence from ${source}. This comment is updated on every push to the pull request.</sub>`;
}

/**
 * Text written by the pull request's author, rendered so it cannot restructure
 * the comment this system signs its name to: no raw HTML (a stray </details>
 * would close a section), and no heading or rule that could forge a verdict.
 */
function quoteAuthorText(text: string): string {
  return text
    .replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^(\s*)(#{1,6}\s|-{3,}\s*$|={3,}\s*$)/, '$1\\$2');
}

/** One line per route and kind; missing test ids are listed rather than repeated. */
function groupDiscrepancies(items: RunDetails['exploration']['discrepancies']): string[] {
  const groups = new Map<string, typeof items>();
  for (const d of items) {
    const key = `${d.route}\u0000${d.kind}`;
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  return [...groups.values()].map((group) => {
    const { route, kind } = group[0]!;
    if (kind === 'missing_element') {
      const ids = group.map((d) => d.staticExpectation.match(/data-testid="([^"]+)"/)?.[1]).filter(Boolean);
      return `- ${code(route)} **not rendered**: ${ids.length ? ids.map((id) => code(id!)).join(', ') : `${group.length} element(s)`} declared in the source`;
    }
    return `- ${code(route)} **${kind.replace(/_/g, ' ')}**: ${group[0]!.runtimeObservation}${group.length > 1 ? ` (+${group.length - 1} more)` : ''}`;
  });
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
