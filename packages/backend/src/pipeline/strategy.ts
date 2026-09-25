/**
 * How a scenario is proven, decided before any test is written.
 *
 * A scenario is not "find a selector, else give up". It is: what behaviour is
 * claimed, what is its observable effect, and which evidence proves it -
 *
 *   UI               the effect is visible (a control shown or hidden)
 *   NETWORK          the effect is a request made, not made, or its parameters
 *   UI_AND_NETWORK   a user action causes (or must not cause) a request
 *   DOM_STATE        a loading / error / empty state
 *   API_MOCK         needs a deterministic backend answer (a failure, a user
 *                    without a field) and then a visible or network effect
 *   PAGE_OBJECT      an existing page-object method already performs it
 *   UNIT_OR_COMPONENT  internal logic no user can reach through the UI
 *   SOURCE_LEVEL     only the source can show it
 *
 * The preference order when several apply is the brief's: existing helper,
 * page object, network observation, accessibility locator, test id, DOM
 * state, implementation selector, source level.
 */
import type { TestStrategy } from '@qa-agent/shared';

export type { TestStrategy };

export type EvidenceSource = 'DOM' | 'NETWORK' | 'API_RESPONSE' | 'PAGE_OBJECT' | 'FIXTURE' | 'UI_ACTION' | 'SOURCE_IMPLEMENTATION';

export interface StrategyChoice {
  strategy: TestStrategy;
  evidence: EvidenceSource[];
  /** Why this strategy fits the claim. */
  rationale: string;
}

/** Strategies a generated Playwright suite can execute. */
export const EXECUTABLE_STRATEGIES: TestStrategy[] = ['UI', 'NETWORK', 'UI_AND_NETWORK', 'DOM_STATE', 'API_MOCK', 'PAGE_OBJECT'];

const has = (text: string, re: RegExp) => re.test(text);

export function classifyScenario(scenario: { title: string; expectedResult?: string; category?: string; steps?: string[] }, ctx: {
  /** API requests are known for this feature (from source or the running app). */
  networkEvidence: boolean;
} = { networkEvidence: false }): StrategyChoice {
  const text = [scenario.title, scenario.expectedResult ?? '', ...(scenario.steps ?? [])].join(' ').toLowerCase();

  const network = has(text, /\b(refetch|re-?fetch|fetch(es|ing|ed)?|api( calls?)?|request(s|ed)?|promise\.all|endpoint|network)\b/);
  const failure = has(text, /\b(offline|network error|err_network|fail(s|ure|ed)?|error|reject(s|ed|ion)?|500|4\d\d|timeout)\b/);
  const userAction = has(text, /\b(click|toggle|change|changing|save|submit|open(s|ing)?|select|press|switch|type|enter|trigger(s|ed)?|reset)\b/);
  const visible = has(text, /\b(render(s|ed)?|display(s|ed)?|show(s|n)?|visible|hidden|appear(s)?|toast|notification|button|enabled|disabled)\b/);
  const loading = has(text, /\b(loading|spinner|pending state|empty state)\b/);
  const role = has(text, /\b(role|permission|authori[sz]|admin|userrole|settings)\b/);
  const internal = has(text, /\b(is called with|set[a-z]+\((true|false)\)|hook|useref|usecallback|internal state|ref\.current)\b/) && !network && !visible;
  const navigation = has(text, /\bnavigate|navigation|visit\b/) && !network;

  if (navigation) return { strategy: 'UI', evidence: ['DOM'], rationale: 'Navigation: the page URL and its content are the effect.' };
  if (internal) {
    return { strategy: 'UNIT_OR_COMPONENT', evidence: ['SOURCE_IMPLEMENTATION'], rationale: 'Internal logic with no network or visible effect a user can observe.' };
  }
  if (failure && (network || visible)) {
    return { strategy: 'API_MOCK', evidence: visible ? ['API_RESPONSE', 'DOM'] : ['API_RESPONSE', 'NETWORK'],
      rationale: 'A failure needs a deterministic backend answer; the effect is then asserted on the page or the network.' };
  }
  if (network && role) {
    return { strategy: 'API_MOCK', evidence: ['API_RESPONSE', 'NETWORK'], rationale: 'The condition comes from data the backend returns; control it, then observe the requests.' };
  }
  if (network) {
    const conditional = has(text, /\b(when|only|missing|absent|present|without|conditional|guard(ed)?|checks?)\b/);
    if (userAction) {
      return { strategy: conditional ? 'API_MOCK' : 'UI_AND_NETWORK', evidence: conditional ? ['API_RESPONSE', 'UI_ACTION', 'NETWORK'] : ['UI_ACTION', 'NETWORK'],
        rationale: 'A user action causes (or must not cause) requests; observe them after the action.' };
    }
    return { strategy: conditional ? 'API_MOCK' : 'NETWORK', evidence: conditional ? ['API_RESPONSE', 'NETWORK'] : ['NETWORK'],
      rationale: conditional ? 'The requests depend on data fields; control the data, then observe which requests are made.' : 'The effect is request activity; observe it.' };
  }
  if (loading) return { strategy: 'DOM_STATE', evidence: ['DOM', 'API_RESPONSE'], rationale: 'A loading or empty state is the effect.' };
  if (role && visible) return { strategy: 'API_MOCK', evidence: ['API_RESPONSE', 'DOM'], rationale: 'Role-dependent rendering: control the role data, assert the control for each condition.' };
  if (visible) return { strategy: 'UI', evidence: ['DOM'], rationale: 'The effect is visible on the page.' };
  if (!ctx.networkEvidence) return { strategy: 'UI', evidence: ['DOM'], rationale: 'No other effect is described; verify what the page shows.' };
  return { strategy: 'UI_AND_NETWORK', evidence: ['UI_ACTION', 'NETWORK'], rationale: 'Verify the action and the requests it causes.' };
}
