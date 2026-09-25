/**
 * FailureAnalyzer (spec section 17) - "This is a core feature."
 *
 * A failing test is never reported as just "test failed". The agent receives
 * the test source, the scenario, the business rule, the error, the stack, the
 * console and network logs, the DOM, the current commit, the changed files and
 * the failure history, and returns a classified diagnosis with evidence.
 */
import { FailureAnalyzerOutput, type FailureClassification, type TestResult } from '@qa-agent/shared';
import { runAgent, SAFETY_PREAMBLE, bulletList, truncate, type AgentResult } from './base.js';
import type { StoredBusinessRule, StoredScenario } from '../knowledge/store.js';
import type { PastFailure } from '../memory/retrieval.js';
import { sanitizeForAi } from '../analysis/secrets.js';
import { packContext, Priority, userBudget } from '../ai/contextBudget.js';
import { env } from '../config/env.js';
import { compactPatch } from './context.js';

const SYSTEM = `${SAFETY_PREAMBLE}

You are the FailureAnalyzer.

A Playwright test failed. Determine WHY, and classify it as exactly one of:

  APPLICATION_BUG        the application behaved incorrectly; the test is right
  TEST_BUG               the test is wrong: bad assertion, bad data, bad logic
  LOCATOR_CHANGED        the element exists but the selector no longer matches
  UI_CHANGED             the UI was intentionally restructured; the flow moved
  API_FAILURE            a backend call returned an unexpected error
  AUTHENTICATION_FAILURE login/session/token problem
  ENVIRONMENT_FAILURE    app not running, wrong base URL, missing config, build broken
  NETWORK_FAILURE        connection refused, DNS, timeout at the network layer
  TIMING_OR_STATE_ISSUE  race condition, missing wait, leaked state between tests
  TEST_DATA_ISSUE        seed/fixture data the test relies on is missing or invalid
                         (record not found, empty list where data was seeded,
                         missing fixture file, 404 fetching a specific id in setup)
  DEPENDENCY_FAILURE     a third-party or backing service the app depends on is
                         down or erroring (5xx / refused connection from a host
                         that is NOT the app under test); distinct from the app's
                         own API (API_FAILURE)
  PREEXISTING_FAILURE    the same failure already happened before this change,
                         so this change did not cause it
  UNKNOWN                the evidence does not support a confident classification

How to tell them apart:
- Element not found + the selector's attribute appears in the changed files
  => LOCATOR_CHANGED, not APPLICATION_BUG.
- Element not found + no related code change + the page rendered
  => could be TIMING_OR_STATE_ISSUE; check console and network logs.
- Assertion failed on a value + a business rule covers that value + the
  relevant source changed => likely APPLICATION_BUG.
- 401/403 in the network log => AUTHENTICATION_FAILURE.
- ECONNREFUSED / page never loaded on the BASE URL => ENVIRONMENT_FAILURE,
  not a product bug. The same errors from a different host (payment provider,
  auth provider, CDN, database, mail service) => DEPENDENCY_FAILURE.
- 5xx from the app's own endpoints => API_FAILURE; 5xx only from third-party
  hosts => DEPENDENCY_FAILURE.
- "not found" / "no rows" / an empty list for data the test itself seeds or
  expects from fixtures, with no related code change => TEST_DATA_ISSUE.
- FAILURE HISTORY shows the same signature failing on a DIFFERENT commit
  (before this change) and the failure was not marked fixed => prefer
  PREEXISTING_FAILURE, and name the earlier commit in "observed". A history
  entry marked resolution=fixed means it had been fixed, so a recurrence is a
  regression, not pre-existing.
- Never classify APPLICATION_BUG unless you can tie the failure to a specific
  change in the diff (list it in likelyCulpritFiles and quote it in
  "observed"). Without that link use UNKNOWN or the matching non-product class.
- This test failed before with the same signature and was marked flaky, and
  nothing related changed => set isLikelyFlaky true.

Fill observed / inferred / unknown separately, as always. "observed" must quote
the actual error, log line or diff you relied on.

affectedArea: the feature or area of the application the failure lands in
(e.g. "Tasks - create form"), taken from the scenario, spec and changed files.

recommendedInvestigation: 2-5 ordered, concrete steps a QA engineer should take
to confirm or refute your hypothesis, each naming the artifact to look at
(screenshot, console line, network call, diff hunk, component file). This is
an investigation plan, not a verdict.

requiresHumanReview must be true whenever you classify APPLICATION_BUG, or when
confidence is below 0.8. Never claim a test is fixed. Never assert a product
bug without pointing at the evidence for it.

Return JSON matching the requested schema.`;

export interface FailureAnalyzerInput {
  projectId: string;
  runId: string;
  result: TestResult;
  testSource: string | null;
  scenario: StoredScenario | null;
  rules: StoredBusinessRule[];
  commitSha: string;
  changedFiles: string[];
  relevantDiffs: { path: string; patch?: string }[];
  pastFailures: PastFailure[];
  baseUrl: string;
  /**
   * Optional: every commit SHA that belongs to the change under test (e.g. all
   * commits of the PR). Past failures on these commits are NOT treated as
   * pre-existing. Without it, only the current commitSha is excluded, so a
   * failure seen on an earlier push of the same PR would count as pre-existing.
   */
  changeCommitShas?: string[];
}

export async function runFailureAnalyzer(
  input: FailureAnalyzerInput,
): Promise<AgentResult<FailureAnalyzerOutput>> {
  const { result } = input;

  const scenarioBlock = input.scenario
    ? `SCENARIO UNDER TEST:
  id: ${input.scenario.id}
  category: ${input.scenario.category}
  title: ${input.scenario.title}
  steps:
${input.scenario.steps.map((s, i) => `    ${i + 1}. ${s}`).join('\n')}
  expected: ${input.scenario.expectedResult}`
    : 'SCENARIO UNDER TEST: not linked to a recorded scenario.';

  const rulesBlock = input.rules.length
    ? `BUSINESS RULES THIS TEST VERIFIES:\n${bulletList(input.rules.map((r) => `${r.id} [${r.status}] ${r.description}`), 15)}`
    : 'BUSINESS RULES THIS TEST VERIFIES: none recorded.';

  const historyBlock = input.pastFailures.length
    ? `FAILURE HISTORY FOR THIS TEST:\n${bulletList(input.pastFailures.map((f) =>
        `${f.occurredAt} commit=${f.commitSha?.slice(0, 8) ?? '?'} class=${f.classification ?? '?'} resolution=${f.resolution} seen=${f.occurrenceCount}x${f.isFlaky ? ' [marked flaky]' : ''}`,
      ), 10)}`
    : 'FAILURE HISTORY FOR THIS TEST: this is the first recorded failure.';

  // Evidence of this failure first, then the code that changed, then history.
  // Screenshots and video are referenced by path only; images are never sent.
  const user = packContext([
    {
      title: '',
      body: `TEST: ${result.fullTitle}
SPEC FILE: ${result.specFile}
OUTCOME: ${result.outcome} after ${result.durationMs}ms, attempt ${result.attempts}
BASE URL UNDER TEST: ${input.baseUrl}
COMMIT: ${input.commitSha}`,
      priority: Priority.task,
      required: true,
    },
    { title: 'ERROR MESSAGE:', body: truncate(sanitizeForAi(result.errorMessage ?? '(none captured)'), 2000, 'error'), priority: Priority.task, required: true },
    { title: 'STACK TRACE:', body: truncate(sanitizeForAi(result.errorStack ?? '(none captured)'), 2500, 'stack'), priority: Priority.change },
    { title: 'TEST SOURCE:', body: truncate(sanitizeForAi(input.testSource ?? '(source unavailable)'), 4000, 'test source'), priority: Priority.change },
    { title: '', body: `${scenarioBlock}\n\n${rulesBlock}`, priority: Priority.relatedTests },
    {
      title: 'RELEVANT DIFFS (compacted):',
      body: input.relevantDiffs.slice(0, Math.min(5, env.AI_MAX_FILES_PER_REQUEST))
        .map((d) => `--- ${d.path} ---\n${truncate(sanitizeForAi(compactPatch(d.patch ?? '')), 2000, 'patch')}`).join('\n\n') || '(no relevant diffs)',
      priority: Priority.relatedTests,
    },
    { title: 'NETWORK ACTIVITY:', body: bulletList(result.networkLogs.map((l) => sanitizeForAi(l).slice(0, 300)), 40), priority: Priority.pageObjects },
    { title: 'BROWSER CONSOLE LOGS:', body: bulletList(result.consoleLogs.map((l) => sanitizeForAi(l).slice(0, 300)), 40), priority: Priority.pageObjects },
    { title: 'DOM SNAPSHOT AT FAILURE:', body: truncate(sanitizeForAi(result.domSnapshot ?? '(not captured)'), 4000, 'DOM'), priority: Priority.utilities },
    {
      title: '',
      body: `SCREENSHOTS CAPTURED: ${result.screenshotPaths.length ? result.screenshotPaths.join(', ') : 'none'}\nVIDEO CAPTURED: ${result.videoPath ?? 'none'}`,
      priority: Priority.fixtures,
    },
    { title: 'FILES CHANGED IN THIS COMMIT:', body: bulletList(input.changedFiles, 60), priority: Priority.fixtures },
    { title: '', body: historyBlock, priority: Priority.history },
    { title: '', body: 'Diagnose this failure.', priority: Priority.task, required: true },
  ], userBudget(SYSTEM), 'FailureAnalyzer').text;

  return runAgent({
    agent: 'FailureAnalyzer',
    projectId: input.projectId,
    runId: input.runId,
    system: SYSTEM,
    user,
    schema: FailureAnalyzerOutput,
    temperature: 0.1,
    fallback: () => heuristicDiagnosis(input),
  }).then((res) => ({ ...res, data: enrichDiagnosis(input, guardDiagnosis(input, res.data)) }));
}

/**
 * A product bug must be tied to the change. When the AI says APPLICATION_BUG
 * but names no changed file, it is kept but downgraded in confidence and
 * flagged for a human.
 */
export function guardDiagnosis<T extends CoreDiagnosis>(input: FailureAnalyzerInput, d: T): T {
  if (d.classification !== 'APPLICATION_BUG') return d;
  const changed = new Set([...input.changedFiles, ...input.relevantDiffs.map((r) => r.path)]);
  if (d.likelyCulpritFiles.some((f) => changed.has(f))) return d;
  return {
    ...d,
    confidence: Math.min(d.confidence, 0.5),
    requiresHumanReview: true,
    unknown: [...d.unknown, 'No changed file in this commit was tied to this failure, so it may not be caused by this change.'],
  };
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

function normHost(h: string): string {
  const host = h.toLowerCase().replace(/^\[|\]$/g, '');
  return LOOPBACK.has(host) ? 'localhost' : host;
}

function hostOf(url: string): string | null {
  try { return normHost(new URL(url).hostname); } catch { return null; }
}

/** Same machine name as the app under test (any port) counts as the app. */
function isAppHost(host: string, baseUrl: string): boolean {
  const base = hostOf(baseUrl);
  return !base || normHost(host) === base;
}

function sameSha(a: string, b: string): boolean {
  const x = a.toLowerCase(); const y = b.toLowerCase();
  return x.length >= 7 && y.length >= 7 ? x.startsWith(y) || y.startsWith(x) : x === y;
}

/** Past failures of the same signature on a commit that is not part of this change. */
export function preexistingOccurrences(input: FailureAnalyzerInput): PastFailure[] {
  const own = [input.commitSha, ...(input.changeCommitShas ?? [])].filter(Boolean);
  return input.pastFailures.filter((f) =>
    f.commitSha &&
    f.resolution !== 'fixed' &&
    !own.some((sha) => sameSha(sha, f.commitSha!)));
}

interface DependencySignal { host: string; line: string }

/** A refused connection or 5xx from a host other than the app under test. */
function dependencySignal(input: FailureAnalyzerInput): DependencySignal | null {
  for (const line of input.result.networkLogs) {
    const m = line.match(/^\S+\s+(\S+)\s+->\s+(\d{3}|FAILED)(.*)$/);
    if (!m) continue;
    const host = hostOf(m[1]!);
    if (!host || isAppHost(host, input.baseUrl)) continue;
    const status = m[2]!;
    if (/^5\d\d$/.test(status) || (status === 'FAILED' && /CONNECTION_REFUSED|ECONNREFUSED|CONNECTION_RESET|ERR_EMPTY_RESPONSE/i.test(m[3] ?? ''))) {
      return { host, line };
    }
  }
  const text = `${input.result.errorMessage ?? ''}\n${input.result.consoleLogs.join('\n')}`;
  // Node: "connect ECONNREFUSED 10.0.0.5:5432"; fetch: "ECONNREFUSED api.stripe.com:443".
  for (const m of text.matchAll(/ECONNREFUSED\s+\[?([\w.\-:]+?)\]?:(\d+)/g)) {
    const host = m[1]!;
    if (!isAppHost(host, input.baseUrl)) return { host, line: m[0] };
  }
  for (const m of text.matchAll(/https?:\/\/[^\s'")]+[^\n]{0,40}?\b(502|503|504)\b/g)) {
    const host = hostOf(m[0].split(/\s/)[0]!);
    if (host && !isAppHost(host, input.baseUrl)) return { host, line: m[0] };
  }
  return null;
}

/** Missing / invalid seed or fixture data, only when reasonably clear. */
function testDataSignal(input: FailureAnalyzerInput): string | null {
  const message = input.result.errorMessage ?? '';
  const stack = input.result.errorStack ?? '';
  const text = `${message}\n${input.result.consoleLogs.join('\n')}`;
  const explicit = text.match(
    /\b(?:fixture|seed(?:ed)?(?: data)?|test data|test user|test account)\b[^\n]{0,80}?\b(?:missing|not found|does not exist|not exist|undefined|empty|no such)\b|\b(?:no rows (?:returned|found)|0 rows returned|record not found|no records? found|no such (?:user|record|row))\b|ENOENT[^\n]*\b(?:fixtures?|seeds?|test-?data)\b/i,
  );
  if (explicit) return explicit[0];

  // A GET of a specific id returning 404 while the test was still setting up.
  const inSetup = /\b(beforeEach|beforeAll|setup|fixture|seed)\b/i.test(`${message}\n${stack}`);
  if (inSetup) {
    const idGet = input.result.networkLogs.find((l) =>
      /^GET\s+\S*\/(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{24})(?:[?#]\S*)?\s+->\s+404\b/i.test(l));
    if (idGet) return idGet;
  }

  // An empty list where the test expected seeded data.
  const emptyWhereExpected = /Expected[^\n]*:\s*(?:[1-9]\d*|>\s*0)[\s\S]{0,80}Received[^\n]*:\s*(?:0|\[\])\s*$/m.test(message);
  if (emptyWhereExpected && /\b(seed|fixture|test data)\b/i.test(input.testSource ?? '')) {
    return 'Expected seeded items but the list was empty.';
  }
  return null;
}

type CoreDiagnosis = Omit<FailureAnalyzerOutput, 'affectedArea' | 'recommendedInvestigation'>
  & Partial<Pick<FailureAnalyzerOutput, 'affectedArea' | 'recommendedInvestigation'>>;

/**
 * Guarantees every diagnosis names the area it affects and carries an
 * investigation plan, whichever path (AI or heuristic) produced it.
 */
export function enrichDiagnosis(input: FailureAnalyzerInput, d: CoreDiagnosis): FailureAnalyzerOutput {
  const affectedArea = d.affectedArea?.trim()
    || (input.scenario ? `${input.scenario.feature} - ${input.scenario.title}` : '')
    || input.result.specFile.replace(/^.*\//, '').replace(/\.cy\.[jt]sx?$/, '');

  const steps = (d.recommendedInvestigation ?? []).filter(Boolean);
  if (steps.length === 0) {
    if (input.result.screenshotPaths.length) steps.push('Open the screenshot captured at the moment of failure and compare it with the expected state.');
    if (input.result.networkLogs.some((l) => /-> [45]\d\d/.test(l))) steps.push('Inspect the failing network calls (4xx/5xx) recorded in the network log.');
    if (input.result.consoleLogs.some((l) => /\[(error|uncaught)\]/.test(l))) steps.push('Read the browser console errors captured during the test.');
    if (d.likelyCulpritFiles.length) steps.push(`Review the changes in ${d.likelyCulpritFiles.slice(0, 3).join(', ')}.`);
    else if (input.relevantDiffs.length) steps.push(`Review the related diff in ${input.relevantDiffs.slice(0, 2).map((r) => r.path).join(', ')}.`);
    if (d.recommendedAction) steps.push(d.recommendedAction);
    if (input.pastFailures.length) steps.push(`Compare with ${input.pastFailures.length} earlier failure(s) of this test before concluding.`);
  }

  return { ...d, affectedArea, recommendedInvestigation: [...new Set(steps)].slice(0, 6) };
}

/**
 * Heuristic classification from the error text alone.
 *
 * Deliberately conservative: it flags the cases that are unambiguous from the
 * error string and returns UNKNOWN with requiresHumanReview otherwise, rather
 * than guessing at a product bug.
 */
export function heuristicDiagnosis(input: FailureAnalyzerInput): FailureAnalyzerOutput {
  return enrichDiagnosis(input, heuristicCore(input));
}

function heuristicCore(input: FailureAnalyzerInput): CoreDiagnosis {
  const message = input.result.errorMessage ?? '';
  const logs = [...input.result.consoleLogs, ...input.result.networkLogs].join('\n');
  const combined = `${message}\n${logs}`;
  const observed: string[] = [];
  if (message) observed.push(`Playwright reported: ${message.split('\n')[0]}`);

  const repeat = input.pastFailures.find((f) => f.isFlaky);
  if (repeat && !input.changedFiles.length) {
    return {
      classification: 'TIMING_OR_STATE_ISSUE',
      confidence: 0.6,
      rootCause: 'This test has previously been marked flaky and nothing related changed in this commit.',
      evidence: [`Previously recorded ${repeat.occurrenceCount} time(s) and marked flaky.`],
      recommendedAction: 'Re-run the test in isolation before investigating further.',
      requiresHumanReview: true,
      observed, inferred: ['The failure may not be reproducible.'],
      unknown: ['Whether the underlying race condition has been fixed.'],
      likelyCulpritFiles: [], relatedPastFailureIds: [repeat.id], isLikelyFlaky: true,
    };
  }

  const prior = preexistingOccurrences(input);
  if (prior.length) {
    const first = prior[0]!;
    return {
      classification: 'PREEXISTING_FAILURE',
      confidence: 0.8,
      rootCause: `The same failure was already recorded on commit ${first.commitSha!.slice(0, 8)} (${first.occurredAt || 'earlier'}), before this change. This change did not introduce it.`,
      evidence: [
        ...observed,
        ...prior.slice(0, 3).map((f) => `Same failure signature on commit ${f.commitSha!.slice(0, 8)}${f.occurredAt ? ` at ${f.occurredAt}` : ''}, classified ${f.classification ?? 'unclassified'}, resolution ${f.resolution}, seen ${f.occurrenceCount}x.`),
      ],
      recommendedAction: 'Treat as a pre-existing failure: track it against the earlier occurrence rather than blocking this change.',
      requiresHumanReview: false,
      observed,
      inferred: ['The failure predates this change.'],
      unknown: ['Whether this change made the pre-existing failure worse.'],
      likelyCulpritFiles: [],
      relatedPastFailureIds: prior.map((f) => f.id),
      isLikelyFlaky: false,
    };
  }

  const dependency = dependencySignal(input);
  if (dependency) {
    return {
      classification: 'DEPENDENCY_FAILURE',
      confidence: 0.8,
      rootCause: `A service the application depends on (${dependency.host}) was unavailable or returned an error. It is not the application under test at ${input.baseUrl}.`,
      evidence: [...observed, `Dependency error: ${dependency.line.slice(0, 300)}`],
      recommendedAction: `Check the status of ${dependency.host} (or its sandbox/mock) and re-run. This is not a product bug in this change.`,
      requiresHumanReview: false,
      observed: [...observed, dependency.line.slice(0, 300)],
      inferred: [`${dependency.host} is a third-party or backing service.`],
      unknown: ['Whether the application should degrade gracefully when this dependency fails.'],
      likelyCulpritFiles: [],
      relatedPastFailureIds: input.pastFailures.map((f) => f.id),
      isLikelyFlaky: false,
    };
  }

  const data = testDataSignal(input);
  if (data) {
    return {
      classification: 'TEST_DATA_ISSUE',
      confidence: 0.65,
      rootCause: 'The data the test depends on (seed or fixture) was missing or not in the expected state.',
      evidence: [...observed, `Test data signal: ${data.slice(0, 300)}`],
      recommendedAction: 'Verify the seed/fixture data for this test exists in the target environment, then re-run.',
      requiresHumanReview: true,
      observed,
      inferred: ['The failure comes from test data, not from the application logic.'],
      unknown: ['Whether this change altered how the data is created or queried.'],
      likelyCulpritFiles: [],
      relatedPastFailureIds: input.pastFailures.map((f) => f.id),
      isLikelyFlaky: false,
    };
  }

  const rules: { test: RegExp; classification: FailureClassification; cause: string; action: string; confidence: number }[] = [
    {
      // No response at all: the server is not there. This is the only case
      // that is genuinely an environment problem.
      test: /ECONNREFUSED|net::ERR_CONNECTION_REFUSED|ERR_CONNECTION_CLOSED|NS_ERROR_CONNECTION_REFUSED|Could not connect to (the )?server/i,
      classification: 'ENVIRONMENT_FAILURE',
      cause: `The application under test was not reachable at ${input.baseUrl}. No response was received.`,
      action: `Start the application at ${input.baseUrl} (or correct TEST_BASE_URL) and re-run. This is not a product bug.`,
      confidence: 0.95,
    },
    {
      // The server answered with 404: the page the test expects is gone. That
      // is a routing change or a broken link, not a dead environment.
      test: /(?:response we received from your web server was:?[\s\S]{0,40})?\b404\b[^\d]{0,20}(Not Found)?/i,
      classification: 'UI_CHANGED',
      cause: 'The page responded with 404. The route the test navigates to no longer exists, or it moved.',
      action: 'Check whether the route was renamed or removed in this commit, then update the affected scenarios and page objects.',
      confidence: 0.8,
    },
    {
      test: /ERR_NAME_NOT_RESOLVED|ETIMEDOUT|ERR_NETWORK|ERR_INTERNET_DISCONNECTED|ERR_EMPTY_RESPONSE/i,
      classification: 'NETWORK_FAILURE',
      cause: 'A network-level error prevented the request from completing.',
      action: 'Check network access from the runner, then re-run.',
      confidence: 0.85,
    },
    {
      test: /\b(401|403)\b|Unauthorized|Forbidden|session (has )?expired|not authenticated/i,
      classification: 'AUTHENTICATION_FAILURE',
      cause: 'The request was rejected as unauthenticated or unauthorized.',
      action: 'Verify the configured test credentials and the login flow used by the test.',
      confidence: 0.75,
    },
    {
      test: /\b(500|502|503|504)\b|Internal Server Error|Bad Gateway|Service Unavailable/i,
      classification: 'API_FAILURE',
      cause: 'A backend call returned a server error.',
      action: 'Check the server logs for the failing endpoint.',
      confidence: 0.8,
    },
    {
      // Playwright: "Received: <element(s) not found>" from a web-first
      // assertion, or an action that timed out still "waiting for locator(...)".
      test: /element\(s\) not found|Timeout \d+ms exceeded[\s\S]*?waiting for (?:locator|getBy)|strict mode violation/i,
      classification: 'LOCATOR_CHANGED',
      cause: 'The expected element was never found. The selector no longer matches the rendered DOM.',
      action: 'Compare the selector against the current component source; a self-healing proposal may be available.',
      confidence: 0.6,
    },
    {
      test: /Timed out \d+ms waiting for expect|Timeout \d+ms exceeded|Test timeout of \d+ms exceeded/i,
      classification: 'TIMING_OR_STATE_ISSUE',
      cause: 'A Playwright wait or assertion timed out, which usually means the expected state never arrived.',
      action: 'Check whether the test waits on the right request or element.',
      confidence: 0.5,
    },
    {
      test: /expect\([\s\S]*?\)\.(?:not\.)?to\w+\(|Expected:[\s\S]*Received:/i,
      classification: 'UNKNOWN',
      cause: 'An assertion compared two values and they differed. Whether the application or the expectation is wrong cannot be determined from the error text alone.',
      action: 'Review the screenshot and the expected value against the business rule this test verifies.',
      confidence: 0.4,
    },
  ];

  const matched = rules.find((r) => r.test.test(combined));

  // A changed file that the failing selector mentions is strong evidence.
  const culprits = input.changedFiles.filter((f) => message.includes(f) || (input.testSource ?? '').includes(f));

  // When a 404 coincides with a route the scenario visits, and files under
  // that route changed in this commit, the diagnosis is no longer a guess.
  const visitedPath = input.scenario?.steps.join(' ').match(/\/[\w\-/]+/)?.[0];
  const routeRemoved = Boolean(
    visitedPath &&
    input.changedFiles.some((f) => f.includes(visitedPath.replace(/^\//, ''))),
  );

  if (!matched) {
    return {
      classification: 'UNKNOWN',
      confidence: 0.3,
      rootCause: 'The failure could not be classified from the error text, and AI analysis was unavailable.',
      evidence: observed,
      recommendedAction: 'Review the screenshot, console logs and DOM snapshot attached to this failure.',
      requiresHumanReview: true,
      observed, inferred: [], unknown: ['The cause of this failure.'],
      likelyCulpritFiles: culprits, relatedPastFailureIds: input.pastFailures.map((f) => f.id), isLikelyFlaky: false,
    };
  }

  if (matched.classification === 'UI_CHANGED' && routeRemoved && visitedPath) {
    return {
      classification: 'UI_CHANGED',
      confidence: 0.92,
      rootCause: `The page at ${visitedPath} responded with 404, and files under that path changed in this commit. The route was moved or removed.`,
      evidence: [
        ...observed,
        `Files matching "${visitedPath}" changed in this commit: ${culprits.join(', ') || input.changedFiles.filter((f) => f.includes(visitedPath.replace(/^\//, ''))).join(', ')}`,
      ],
      recommendedAction: `Update the scenarios and page objects that navigate to ${visitedPath}, or restore the route if its removal was unintended.`,
      requiresHumanReview: true,
      observed,
      inferred: [`${visitedPath} no longer exists at this commit.`],
      unknown: ['Whether the route was renamed deliberately or removed by mistake.'],
      likelyCulpritFiles: culprits,
      relatedPastFailureIds: input.pastFailures.map((f) => f.id),
      isLikelyFlaky: false,
    };
  }

  return {
    classification: matched.classification,
    confidence: matched.confidence,
    rootCause: matched.cause,
    evidence: observed,
    recommendedAction: matched.action,
    requiresHumanReview: matched.confidence < 0.8 || matched.classification === 'APPLICATION_BUG',
    observed,
    inferred: [matched.cause],
    unknown: ['Confirmation requires reviewing the captured screenshot and DOM.'],
    likelyCulpritFiles: culprits,
    relatedPastFailureIds: input.pastFailures.map((f) => f.id),
    isLikelyFlaky: false,
  };
}
