/**
 * ApplicationMapper: turns features and rules into user flows, role
 * capabilities and state transitions (spec section 6).
 *
 * This is what lets scenarios be written as journeys rather than as isolated
 * assertions, and it is the layer that answers "who can do what?".
 */
import { ApplicationMapperOutput, type StaticAnalysis, type UserFlow } from '@qa-agent/shared';
import { runAgent, SAFETY_PREAMBLE, bulletList, type AgentResult } from './base.js';
import type { FeatureSlice } from './context.js';
import type { StoredBusinessRule } from '../knowledge/store.js';
import { slug } from '../util/ids.js';

const SYSTEM = `${SAFETY_PREAMBLE}

You are the ApplicationMapper.

Given an application's features, routes, roles and business rules, produce:
  - userFlows: the journeys a user actually takes, as ordered steps that refer
    to real routes and real UI elements from the evidence.
  - roles: what each role can and cannot do. "cannotDo" is as important as
    "canDo" - it is what negative authorization tests are built from.
  - stateTransitions: only transitions the application really supports. If the
    code enumerates states but shows no transitions, say so with
    evidenceLevel "unknown" rather than inventing a lifecycle.
  - navigation: how a user moves between routes.

Do not invent a role that does not appear in the evidence. Do not invent a
route. If a flow requires a step you cannot see (for example an email
confirmation), mark the flow's evidence accordingly rather than fabricating it.

Return JSON matching the requested schema.`;

export interface ApplicationMapperInput {
  projectId: string;
  runId: string;
  analysis: StaticAnalysis;
  features: FeatureSlice[];
  rules: StoredBusinessRule[];
}

export async function runApplicationMapper(
  input: ApplicationMapperInput,
): Promise<AgentResult<ApplicationMapperOutput>> {
  const user = `FEATURES:
${bulletList(input.features.map((f) => `${f.key} (${f.name}) routes=[${f.routes.join(', ')}]`), 40)}

ROUTES:
${bulletList(input.analysis.routes.map((r) =>
  `${r.path} [${r.kind}]${r.requiresAuth ? ' auth-required' : ''}${r.guardedByRoles.length ? ` roles=${r.guardedByRoles.join(',')}` : ''}`,
), 60)}

ROLES DISCOVERED IN CODE:
${bulletList(input.analysis.roles.map((r) => `${r.name}${r.permissions.length ? ` -> ${r.permissions.join(', ')}` : ''}`), 25)}

AUTHORIZATION CHECKS (OBSERVED):
${bulletList(input.analysis.permissionChecks.map((p) => `${p.file}:${p.line ?? '?'} ${p.expression}`), 40)}

STATE MACHINES:
${bulletList(input.analysis.stateMachines.map((s) =>
  `${s.entity}: [${s.states.join(', ')}] transitions observed: ${s.transitions.map((t) => `${t.from}->${t.to}`).join(', ') || 'none'}`,
), 20)}

BUSINESS RULES:
${bulletList(input.rules.map((r) => `${r.id} [${r.status}] ${r.description}`), 60)}

INTERACTIVE ELEMENTS BY COMPONENT:
${bulletList(input.analysis.components.flatMap((c) =>
  c.elements.slice(0, 6).map((e) => `${c.name}: ${e.kind}${e.label ? ` "${e.label}"` : ''}`),
), 60)}

Map this application.`;

  return runAgent({
    agent: 'ApplicationMapper',
    projectId: input.projectId,
    runId: input.runId,
    system: SYSTEM,
    user,
    schema: ApplicationMapperOutput,
    temperature: 0.2,
    fallback: () => deterministicMap(input),
  });
}

/** Flows derived from routes and forms; transitions taken straight from code. */
function deterministicMap(input: ApplicationMapperInput): ApplicationMapperOutput {
  const userFlows: ApplicationMapperOutput['userFlows'] = [];

  for (const feature of input.features.slice(0, 30)) {
    const route = feature.routes[0];
    if (!route) continue;
    const component = input.analysis.components.find((c) => feature.files.includes(c.file) && c.forms.length > 0);
    const steps = [`Navigate to ${route}`];
    if (component) {
      for (const form of component.forms.slice(0, 1)) {
        for (const field of form.fields.slice(0, 8)) steps.push(`Fill "${field.label ?? field.name}"`);
      }
      const submit = component.elements.find((e) => e.kind === 'button');
      if (submit) steps.push(`Click "${submit.label ?? 'submit'}"`);
    }
    steps.push('Verify the resulting state');
    userFlows.push({
      key: `${feature.key}-primary`,
      name: `${feature.name} primary flow`,
      feature: feature.key,
      steps,
      evidence: [{ kind: 'route_definition', file: input.analysis.routes.find((r) => r.path === route)?.file, detail: route }],
    });
  }

  const roles = input.analysis.roles.map((r) => ({
    name: r.name,
    canDo: r.permissions,
    cannotDo: [] as string[],
    evidenceLevel: 'observed' as const,
  }));

  const stateTransitions = input.analysis.stateMachines.flatMap((m) =>
    m.transitions.map((t) => ({
      entity: m.entity, from: t.from, to: t.to, trigger: t.trigger,
      evidenceLevel: 'observed' as const,
    })),
  );

  const navigation = input.analysis.routes
    .filter((r) => r.kind !== 'api')
    .slice(0, 40)
    .map((r) => ({ from: '/', to: r.path, via: undefined }));

  return { userFlows, roles, stateTransitions, navigation };
}

export function toUserFlows(output: ApplicationMapperOutput): UserFlow[] {
  return output.userFlows.map((f, i) => ({
    key: f.key ?? slug(`${f.feature}-${f.name}-${i}`),
    name: f.name,
    feature: f.feature,
    role: f.role,
    steps: f.steps,
    evidence: f.evidence ?? [],
  }));
}
