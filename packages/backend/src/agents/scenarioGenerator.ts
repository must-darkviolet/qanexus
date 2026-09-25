/**
 * ScenarioGenerator (spec section 10).
 *
 * Generates scenarios per feature across every category the spec names, using
 * the feature's business rules as the spine so each scenario is traceable back
 * to a rule and its evidence.
 */
import {
  ScenarioGeneratorOutput, type ScenarioCategory, type StaticAnalysis, type TestScenario,
} from '@qa-agent/shared';
import { buildAppModel, type ModelPage } from '../playwright/appModel.js';
import { runAgent, SAFETY_PREAMBLE, bulletList, type AgentResult } from './base.js';
import { renderFeatureEvidence, type FeatureSlice } from './context.js';
import { renderMemoryForPrompt, type RetrievedMemory } from '../memory/retrieval.js';
import type { StoredBusinessRule } from '../knowledge/store.js';

const SYSTEM = `${SAFETY_PREAMBLE}

You are the ScenarioGenerator.

Produce test scenarios for one feature, covering these categories where the
evidence supports them:

  functional        happy paths, alternate flows, CRUD, navigation
  negative          invalid input, missing input, unauthorized access,
                    invalid state, API errors, server errors
  boundary          minimum, maximum, empty, null, character limits,
                    numeric limits, date boundaries
  validation        required fields, format validation, cross-field validation
  authorization     one scenario per role that the evidence shows exists,
                    including roles that must be denied
  state_transition  only transitions the application actually supports
  error_handling    only status codes the code demonstrably handles
                    (400/401/403/404/409/422/500, timeout, network failure)
  ui_behavior       loading, disabled, empty, error and success states, modals,
                    pagination, filtering, sorting, search - only where the
                    evidence shows them

Hard requirements:
- Only generate a scenario the evidence supports. An application with no
  pagination gets no pagination scenarios. Fewer real scenarios beat many
  invented ones.
- Steps must be concrete and executable: name the route, the field, the button.
- expectedResult must be observable in the UI or in a network call.
- Link each scenario to the business rule ids it verifies via businessRuleIds.
- sourceEvidence must cite files that appear in the evidence given to you.
- confidence reflects how sure you are the application really behaves this way.
- priority: critical for auth/data-loss paths, high for core flows, medium for
  validation and boundaries, low for cosmetic behaviour.
- Do not duplicate scenarios that already exist in the memory block.
- Read how the code works before writing a scenario. When the change context
  has "HOW A USER REACHES THE CHANGED CODE", a request is sent only after those
  steps: write them into the scenario's steps, in order, naming each control
  by its visible label (open the dialog, fill its required fields, submit,
  confirm). A scenario about a condition in the code (a field being missing, a
  role) must say which user steps and which data make that condition true; if
  no traced flow can reach it, do not write the scenario.

Return JSON matching the requested schema.`;

export interface ScenarioGeneratorInput {
  projectId: string;
  runId: string;
  analysis: StaticAnalysis;
  feature: FeatureSlice;
  rules: StoredBusinessRule[];
  memory: RetrievedMemory;
  /** Describes what changed, when generating regression scenarios. */
  changeContext?: string;
  maxScenarios?: number;
}

export async function runScenarioGenerator(
  input: ScenarioGeneratorInput,
): Promise<AgentResult<ScenarioGeneratorOutput>> {
  const max = input.maxScenarios ?? 25;

  const user = `${renderMemoryForPrompt(input.memory)}

---

BUSINESS RULES FOR THIS FEATURE (each scenario should verify one or more):
${bulletList(input.rules.map((r) =>
  `${r.id} [${r.status}, ${r.confidence.toFixed(2)}] ${r.description}` +
  (r.unknown.length ? `\n      unknown: ${r.unknown[0]}` : ''),
), 50)}

---

EVIDENCE FOR THIS FEATURE:
${renderFeatureEvidence(input.analysis, input.feature)}

${input.changeContext ? `\n---\n\nRECENT CHANGES TO THIS FEATURE (generate regression scenarios around these):\n${input.changeContext}` : ''}

---

Generate at most ${max} scenarios for "${input.feature.name}".
Spread them across categories, weighted by what the evidence actually supports.`;

  return runAgent({
    agent: 'ScenarioGenerator',
    projectId: input.projectId,
    runId: input.runId,
    system: SYSTEM,
    user,
    schema: ScenarioGeneratorOutput,
    temperature: 0.3,
    maxOutputTokens: 8192,
    fallback: () => deterministicScenarios(input),
  });
}

/**
 * Scenarios derived mechanically from validation rules, authorization checks,
 * routes and state machines. Not as rich as the AI output, but real and
 * traceable - the system still produces a usable suite with no AI key.
 */
function deterministicScenarios(input: ScenarioGeneratorInput): ScenarioGeneratorOutput {
  const scenarios: ScenarioGeneratorOutput['scenarios'] = [];
  const fileSet = new Set(input.feature.files);
  const feature = input.feature.key;
  const primaryRoute = input.feature.routes[0] ?? '/';

  const push = (s: {
    category: ScenarioCategory; title: string; description: string; steps: string[];
    expectedResult: string; priority: 'critical' | 'high' | 'medium' | 'low';
    ruleIds?: string[]; file?: string; confidence?: number; role?: string;
  }) => {
    scenarios.push({
      feature,
      category: s.category,
      title: s.title,
      description: s.description,
      preconditions: [],
      steps: s.steps,
      expectedResult: s.expectedResult,
      businessRuleIds: s.ruleIds ?? [],
      sourceEvidence: s.file ? [{ kind: 'source_file', file: s.file }] : [],
      confidence: s.confidence ?? 0.7,
      priority: s.priority,
      role: s.role,
    });
  };

  /* Navigation: every route in the feature should load. */
  for (const route of input.feature.routes.slice(0, 8)) {
    push({
      category: 'functional',
      title: `Navigate to ${route}`,
      description: `The route ${route} renders without an error.`,
      steps: [`Visit ${route}`, 'Wait for the page to finish loading'],
      expectedResult: `The ${input.feature.name} page renders and no uncaught error is shown.`,
      priority: 'high',
      file: input.analysis.routes.find((r) => r.path === route)?.file,
      confidence: 0.85,
    });
  }

  /* Everything below is derived from the application model: the same facts
   * the test synthesizer uses, so each scenario maps onto an executable test. */
  const model = buildAppModel(input.analysis);
  const pages = model.pages.filter((p) => input.feature.routes.includes(p.route)
    || fileSet.has(p.file));
  const roleFor = (p: ModelPage) => (p.permissions.length ? model.roleWith({ permission: p.permissions[0] })
    : p.guardedByRoles.length ? model.roleWith({ roles: p.guardedByRoles }) : model.mostPrivilegedRole());

  for (const page of pages) {
    /* ---- forms: happy path, required, boundaries, formats, server errors */
    for (const form of page.forms) {
      const ruleIdsFor = (field: string) => input.rules.filter((r) => r.description.includes(`"${field}"`)).map((r) => r.id);
      if (form.submitApi) {
        push({
          category: 'functional',
          title: `Valid ${form.label} submission is accepted`,
          description: `Filling every field of the ${form.label} form with valid values submits it to ${form.submitApi.method} ${form.submitApi.path}.`,
          steps: [`Visit ${page.route}`, ...form.fields.map((f) => `Enter a valid value in "${f.name}"`), 'Submit the form'],
          expectedResult: `The request is sent with the entered values and no error is shown.`,
          priority: 'critical', file: form.file, confidence: 0.85,
        });
        push({
          category: 'error_handling',
          title: `Server error (500) while submitting ${form.label} is shown`,
          description: `If ${form.submitApi.method} ${form.submitApi.path} fails, the user must be told.`,
          steps: [`Visit ${page.route}`, 'Fill the form with valid values', `Make ${form.submitApi.method} ${form.submitApi.path} respond with 500`, 'Submit the form'],
          expectedResult: 'An error message is shown and the user is not left with a silently failed submission.',
          priority: 'high', file: form.file, confidence: 0.8,
        });
      }
      for (const field of form.fields) {
        const ruleIds = ruleIdsFor(field.name);
        if (field.required && field.inputType !== 'select') {
          push({
            category: 'validation',
            title: `Submitting with "${field.name}" empty is rejected`,
            description: `"${field.name}" is required.`,
            steps: [`Visit ${page.route}`, `Leave "${field.name}" empty`, 'Fill the remaining fields with valid values', 'Submit the form'],
            expectedResult: `A validation message is shown for "${field.name}" and nothing is submitted.`,
            priority: 'high', ruleIds, file: form.file, confidence: 0.9,
          });
        }
        if (field.min !== null && field.inputType !== 'select') {
          const unit = field.inputType === 'number' ? '' : ' characters';
          push({
            category: 'boundary',
            title: `"${field.name}" below its minimum of ${field.min} is rejected`,
            description: `"${field.name}" must be at least ${field.min}${unit}.`,
            steps: [`Visit ${page.route}`, `Enter ${field.inputType === 'number' ? field.min - 1 : `${field.min - 1} characters`} in "${field.name}"`, 'Submit the form'],
            expectedResult: 'A validation message is shown and nothing is submitted.',
            priority: 'high', ruleIds, file: form.file, confidence: 0.85,
          });
          push({
            category: 'boundary',
            title: `"${field.name}" at its minimum of ${field.min} is accepted`,
            description: `The lower bound itself is valid.`,
            steps: [`Visit ${page.route}`, `Enter exactly ${field.min}${unit} in "${field.name}"`, 'Fill the remaining fields with valid values', 'Submit the form'],
            expectedResult: `"${field.name}" is accepted and the form submits.`,
            priority: 'medium', ruleIds, file: form.file, confidence: 0.8,
          });
        }
        if (field.max !== null && field.inputType !== 'select') {
          const unit = field.inputType === 'number' ? '' : ' characters';
          push({
            category: 'boundary',
            title: `"${field.name}" above its maximum of ${field.max} is rejected`,
            description: `"${field.name}" must be at most ${field.max}${unit}.`,
            steps: [`Visit ${page.route}`, `Enter ${field.inputType === 'number' ? field.max + 1 : `${field.max + 1} characters`} in "${field.name}"`, 'Submit the form'],
            expectedResult: 'The input caps the value, or a validation message is shown and nothing is submitted.',
            priority: 'medium', ruleIds, file: form.file, confidence: 0.85,
          });
          push({
            category: 'boundary',
            title: `"${field.name}" at its maximum of ${field.max} is accepted`,
            description: 'The upper bound itself is valid.',
            steps: [`Visit ${page.route}`, `Enter exactly ${field.max}${unit} in "${field.name}"`, 'Fill the remaining fields with valid values', 'Submit the form'],
            expectedResult: `"${field.name}" is accepted and the form submits.`,
            priority: 'low', ruleIds, file: form.file, confidence: 0.8,
          });
        }
        if (field.email) {
          push({
            category: 'negative',
            title: `"${field.name}" rejects a malformed email address`,
            description: `"${field.name}" must be a valid email address.`,
            steps: [`Visit ${page.route}`, `Enter "not-an-email" in "${field.name}"`, 'Submit the form'],
            expectedResult: 'A format validation message is shown and nothing is submitted.',
            priority: 'high', ruleIds, file: form.file, confidence: 0.9,
          });
        }
      }
    }

    /* ---- access control ------------------------------------------------ */
    if (page.requiresAuth) {
      push({
        category: 'authorization',
        title: `Unauthenticated access to ${page.route} is blocked`,
        description: `${page.file} only renders its content for a signed-in user.`,
        steps: ['Make sure no session exists', `Visit ${page.route}`],
        expectedResult: 'The user is redirected to sign in, or a sign-in / access-denied message is shown instead of the content.',
        priority: 'critical', file: page.file, confidence: 0.85,
      });
    }
    for (const permission of page.permissions.slice(0, 2)) {
      const denied = model.roleWithout({ permission });
      const allowed = model.roleWith({ permission });
      if (denied) {
        push({
          category: 'authorization',
          title: `A "${denied}" user is refused on ${page.route} (requires ${permission})`,
          description: `${page.file} checks "${permission}", which the "${denied}" role does not hold.`,
          steps: [`Sign in as a "${denied}" user`, `Visit ${page.route}`],
          expectedResult: 'A permission message is shown and the protected content is not rendered.',
          priority: 'critical', role: denied, file: page.file, confidence: 0.85,
        });
      }
      if (allowed) {
        push({
          category: 'authorization',
          title: `A "${allowed}" user can use ${page.route}`,
          description: `The "${allowed}" role holds "${permission}".`,
          steps: [`Sign in as a "${allowed}" user`, `Visit ${page.route}`],
          expectedResult: 'The page content is shown with no permission message.',
          priority: 'high', role: allowed, file: page.file, confidence: 0.85,
        });
      }
    }

    /* ---- data states ---------------------------------------------------- */
    const listApi = page.readApis.find((a) => a.entity);
    if (listApi && page.tableSelector) {
      push({
        category: 'functional',
        title: `${page.route} lists the ${listApi.entity} records returned by the API`,
        description: `${page.component} renders the data from ${listApi.method} ${listApi.path}.`,
        steps: [`Sign in as a "${roleFor(page) ?? 'user'}" user`, `Visit ${page.route}`],
        expectedResult: `Every ${listApi.entity} returned by the API is shown.`,
        priority: 'high', file: page.file, confidence: 0.8,
      });
    }
    if (page.readApis.length && page.hasEmptyState) {
      push({
        category: 'ui_behavior',
        title: `${page.component} shows an empty state when there is no data`,
        description: `${page.file} conditionally renders an empty branch.`,
        steps: [`Visit ${page.route}`, 'Make the list API return an empty list'],
        expectedResult: 'An empty-state message is shown instead of an empty table.',
        priority: 'medium', file: page.file, confidence: 0.8,
      });
    }
    if (page.readApis.length && page.hasErrorState) {
      push({
        category: 'error_handling',
        title: `${page.component} shows an error state when its request fails`,
        description: `${page.file} conditionally renders an error branch.`,
        steps: [`Visit ${page.route}`, 'Make the data request respond with 500'],
        expectedResult: 'An error message is shown rather than an empty or broken view.',
        priority: 'high', file: page.file, confidence: 0.8,
      });
    }
    if (page.searchSelector && listApi) {
      push({
        category: 'ui_behavior',
        title: `Searching ${page.route} filters the list`,
        description: `${page.component} filters its ${listApi.entity} list by the search text.`,
        steps: [`Visit ${page.route}`, 'Type the name of one record into the search box', 'Clear the search box'],
        expectedResult: 'Only matching records are shown; clearing the search shows all records again.',
        priority: 'medium', file: page.file, confidence: 0.8,
      });
    }

    /* ---- interactions --------------------------------------------------- */
    for (const link of page.links.slice(0, 4)) {
      push({
        category: 'ui_behavior',
        title: `"${link.label}" link on ${page.route} opens ${link.target}`,
        description: `${page.component} links to ${link.target}.`,
        steps: [`Visit ${page.route}`, `Click "${link.label}"`],
        expectedResult: `The browser navigates to ${link.target}.`,
        priority: 'medium', file: page.file, confidence: 0.8,
      });
    }
    for (const action of page.rowActions.slice(0, 6)) {
      if (!action.api) continue;
      push({
        category: action.targetState ? 'state_transition' : 'functional',
        title: `"${action.label}" on a ${listApi?.entity ?? 'record'} row in ${page.route} sends the request`,
        description: `Clicking "${action.label}" calls ${action.api.method} ${action.api.path}${action.targetState ? ` and moves the record to "${action.targetState}"` : ''}.`,
        steps: [`Visit ${page.route} as a user allowed to act`, `Click "${action.label}" on a row where it is offered`],
        expectedResult: action.targetState
          ? `${action.api.method} ${action.api.path} is called with status "${action.targetState}".`
          : `${action.api.method} ${action.api.path} is called.`,
        priority: 'high', file: page.file, confidence: 0.75,
      });
    }
    const firstAction = page.rowActions.find((a) => a.api);
    if (firstAction) {
      push({
        category: 'error_handling',
        title: `"${firstAction.label}" on ${page.route} failing with 500 is shown`,
        description: `A failed ${firstAction.api!.method} ${firstAction.api!.path} must be reported to the user.`,
        steps: [`Visit ${page.route}`, `Make ${firstAction.api!.method} ${firstAction.api!.path} respond with 500`, `Click "${firstAction.label}"`],
        expectedResult: 'An error message is shown.',
        priority: 'medium', file: page.file, confidence: 0.75,
      });
    }
  }

  /* State transitions that the code actually performs. */
  for (const machine of input.analysis.stateMachines.filter((m) => fileSet.has(m.file)).slice(0, 4)) {
    for (const transition of machine.transitions.slice(0, 5)) {
      push({
        category: 'state_transition',
        title: `${machine.entity}: ${transition.from} -> ${transition.to}`,
        description: `${machine.file} performs this transition.`,
        steps: [
          `Create or locate a ${machine.entity} in state "${transition.from}"`,
          `Trigger the action that moves it to "${transition.to}"`,
        ],
        expectedResult: `The ${machine.entity} is shown in state "${transition.to}".`,
        priority: 'high',
        file: machine.file,
        confidence: 0.75,
      });
    }
  }

  return { scenarios: scenarios.slice(0, Math.max(input.maxScenarios ?? 40, 40)) };
}

/** Prepares agent output for persistence. */
export function toScenarios(
  output: ScenarioGeneratorOutput,
  featureKey: string,
): Omit<TestScenario, 'id'>[] {
  return output.scenarios.map((s) => ({
    feature: s.feature || featureKey,
    category: s.category,
    title: s.title,
    description: s.description,
    preconditions: s.preconditions ?? [],
    steps: s.steps,
    expectedResult: s.expectedResult,
    businessRuleIds: s.businessRuleIds ?? [],
    sourceEvidence: s.sourceEvidence ?? [],
    confidence: s.confidence,
    priority: s.priority,
    role: s.role,
    relatedTestIds: [],
    approvalState: 'ai_generated' as const,
  }));
}
