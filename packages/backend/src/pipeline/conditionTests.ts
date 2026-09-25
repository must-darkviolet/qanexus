/**
 * Tests for a condition the pull request put in the code, written from the
 * traced journeys when the generator could not produce a valid one.
 *
 * A scenario such as "handleOnSaveSuperSave skips the history dialog refresh
 * when user_email or user_id is missing" is about a condition that decides
 * whether requests are sent. The journeys (analysis/interactionRecipes.ts)
 * already say, per journey, whether the code sends each guarded request - the
 * row switch never sets selectedUserForHistory, "View History" does. So the
 * test is mechanical: observe the guarded requests, run the journey whose
 * outcome the scenario describes, and assert what happened after its final step.
 */
import type { RecipeTrigger } from '../analysis/interactionRecipes.js';

/** Words that say the scenario expects the request NOT to be sent. */
const NEGATIVE = /\b(skip|skips|skipped|not|no|never|missing|without|absent|prevent|prevents|avoid|avoids|unrelated|omit|omits|omitted|empty|undefined|null)\b/i;

const aliasOf = (p: string) => `observed_${p.split('/').filter(Boolean).pop()?.replace(/[^\w]/g, '_') ?? 'request'}`;

/** The keys a condition is about: its function and the fields it checks. */
function keysOf(condition: string): string[] {
  const fn = condition.match(/^(\w+)(?::|\s+enabled:)/)?.[1];
  const fields = [...condition.replace(/^[\w.]+(?::|\s+enabled:)\s*/, '').matchAll(/\.(\w{4,})\b/g)].map((m) => m[1]!);
  return [...new Set([fn, ...fields].filter((k): k is string => Boolean(k)))];
}

function mentions(claim: string, key: string): boolean {
  return new RegExp(`\\b${key}\\b`).test(claim) || (key.includes('_') && claim.toLowerCase().includes(key.replace(/_/g, ' ')));
}

export interface ConditionTest { body: string; flow: string; sent: boolean; paths: string[] }

/** Only journeys the spec's flows class has (triggers can list other modules' journeys to the same request). */
function restrict(triggers: RecipeTrigger[], available?: string[]): RecipeTrigger[] {
  if (!available) return triggers;
  const keep = <T>(rec: Record<string, T>) => Object.fromEntries(Object.entries(rec).filter(([f]) => available.includes(f))) as Record<string, T>;
  return triggers.map((tr) => ({ ...tr, flows: tr.flows.filter((f) => available.includes(f)), aliases: keep(tr.aliases), conditions: keep(tr.conditions), expected: keep(tr.expected), proven: tr.proven ? keep(tr.proven) : tr.proven }))
    .filter((tr) => tr.flows.length);
}

export function synthesizeConditionTest(claim: string, allTriggers: RecipeTrigger[], flowsInstance: string, available?: string[]): ConditionTest | null {
  const triggers = restrict(allTriggers, available);
  // What the scenario names: a function with a condition (handleOnSaveSuperSave) is more specific than a field (user_email).
  const all = triggers.flatMap((tr) => Object.values(tr.conditions).flat());
  const fnKeys = [...new Set(all.map((c) => c.match(/^(\w+)(?::|\s+enabled:)/)?.[1]).filter((k): k is string => Boolean(k) && mentions(claim, k!)))];
  const keys = fnKeys.length ? fnKeys : [...new Set(all.flatMap(keysOf).filter((k) => mentions(claim, k)))];
  if (!keys.length) return null;
  // A journey counts for a request only when its path to it goes through that condition.
  const through = (tr: RecipeTrigger, f: string) => (tr.conditions[f] ?? []).some((c) => keysOf(c).some((k) => keys.includes(k)));
  const relevant = triggers.filter((tr) => Object.keys(tr.conditions).some((f) => through(tr, f)));
  if (!relevant.length) return null;
  const sent = !NEGATIVE.test(claim);
  // The journey whose outcome matches for the most guarded requests; proven ones first, then shorter ones.
  const flows = [...new Set(relevant.flatMap((tr) => Object.keys(tr.expected).filter((f) => through(tr, f) && tr.proven?.[f] !== false)))];
  const score = (f: string) => relevant.filter((tr) => through(tr, f) && tr.expected[f]?.sent === sent).length;
  const best = flows.filter((f) => score(f) > 0)
    .sort((a, b) => score(b) - score(a) || Number(Boolean(relevantProven(relevant, b))) - Number(Boolean(relevantProven(relevant, a))) || a.length - b.length)[0];
  if (!best) return null;
  const asserted = relevant.filter((tr) => through(tr, best) && tr.expected[best]?.sent === sent);
  const why = asserted[0]!.expected[best]!.why;
  const lines = [
    '// strategy: UI_AND_NETWORK · evidence: UI_ACTION + NETWORK',
    `// Written from the journeys traced in the source: in ${best}, ${why.replace(/\s+/g, ' ')}`,
    ...asserted.map((tr) => `qa.observe('${aliasOf(tr.paths[0]!)}', '${tr.method}', '${tr.paths[0]}');`),
    `await ${flowsInstance}.${best}();`,
    ...asserted.map((tr) => `await qa.${sent ? 'expectRequestMadeAfterFlow' : 'expectRequestNotMadeAfterFlow'}('${aliasOf(tr.paths[0]!)}');`),
  ];
  return { body: lines.join('\n'), flow: best, sent, paths: asserted.map((tr) => tr.paths[0]!) };
}

function relevantProven(triggers: RecipeTrigger[], flow: string): boolean {
  return triggers.some((tr) => tr.proven?.[flow] === true);
}

/* -------------------------------------------------------------------------- */
/* Error handling on a journey                                                 */
/* -------------------------------------------------------------------------- */

/** About the application showing an error - not merely a condition that "fails" (a role check). */
const ERROR_SCENARIO = /\b(error|errors|offline|toast|notification|alert|toasterror)\b/i;
/** Words every error scenario or journey uses: they barely say which journey is meant. */
const STOP = new Set(['displ', 'shown', 'show', 'shows', 'error', 'toast', 'notif', 'when', 'with', 'from', 'durin', 'after', 'that', 'this', 'state', 'loadi', 'handl', 'trigg', 'netwo', 'offli', 'messa', 'appea', 'failu', 'fails', 'faile', 'click', 'butto', 'confi', 'compl', 'form', 'submi']);
/** Word stems (first five letters): "approving" and "approve" are the same journey. */
const words = (text: string) => new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4).map((w) => w.slice(0, 5)));

/**
 * "Show an error toast when resetting education fails": the journey whose
 * data-changing request the scenario is about (the one sharing the most words
 * with it - reset, approve, super save, education ...) is run with that
 * request answered by a failure, and the test asserts the request was sent by
 * the journey's final step and that an error was shown. Only for scenarios
 * about an error, and only when a journey matches.
 */
export function synthesizeErrorTest(claim: string, allTriggers: RecipeTrigger[], flowsInstance: string, available?: string[]): (ConditionTest & { alias: string }) | null {
  if (!ERROR_SCENARIO.test(claim)) return null;
  const triggers = restrict(allTriggers, available);
  const claimWords = words(claim);
  const candidates = triggers.flatMap((tr) => tr.flows.flatMap((flow) => (tr.aliases[flow] ?? [])
    .filter((alias) => tr.paths[0]!.endsWith(`/${alias}`))
    .map((alias) => ({ flow, alias, path: tr.paths[0]!, proven: tr.proven?.[flow] === true, failedProof: tr.proven?.[flow] === false, text: `${tr.summary} ${tr.paths[0]}` }))));
  const score = (c: (typeof candidates)[number]) => {
    const own = words(c.text.replace(/_/g, ' '));
    const shared = [...claimWords].filter((w) => own.has(w));
    // Specific words (reset, approve, super, save, history) count; words every journey here shares barely do.
    return shared.reduce((n, w) => n + (STOP.has(w) ? 0.25 : 1), 0) + (c.proven ? 0.5 : 0);
  };
  const matching = candidates.map((c) => ({ c, s: score(c) })).filter((x) => x.s >= 1);
  // A journey that failed its live proof would only produce a failing test: never used.
  const usable = matching.filter((x) => !x.c.failedProof);
  const best = usable.sort((a, b) => b.s - a.s || a.c.flow.length - b.c.flow.length)[0]?.c;
  if (!best) return null;
  const offline = /\b(offline|network error|err_network)\b/i.test(claim);
  const failure = offline ? "{ statusCode: 500, body: { message: 'Network Error', code: 'ERR_NETWORK' } }" : "{ statusCode: 500, body: { message: 'Request failed' } }";
  const body = [
    '// strategy: UI_AND_NETWORK · evidence: UI_ACTION + NETWORK + DOM',
    `// Written from the traced journey ${best.flow}: its ${best.path} request fails, and the application must show an error.`,
    `await ${flowsInstance}.${best.flow}({ respond: { ${best.alias}: ${failure} } });`,
    `await qa.expectRequestMadeAfterFlow('${best.alias}');`,
    'await qa.expectErrorShown();',
  ].join('\n');
  return { body, flow: best.flow, sent: true, paths: [best.path], alias: best.alias };
}
