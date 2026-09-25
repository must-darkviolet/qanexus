/**
 * BusinessRuleAnalyzer: the part of the system the spec calls "one of the most
 * important" (section 5).
 *
 * It infers business rules from evidence rather than asking the user to write
 * them, and it is held to the section 28 discipline: observed facts, inferred
 * conclusions and open unknowns are recorded in separate fields.
 */
import { BusinessRuleAnalyzerOutput, type BusinessRule, type StaticAnalysis } from '@qa-agent/shared';
import { runAgent, SAFETY_PREAMBLE, type AgentResult } from './base.js';
import { renderFeatureEvidence, type FeatureSlice } from './context.js';
import { renderMemoryForPrompt, type RetrievedMemory } from '../memory/retrieval.js';

const SYSTEM = `${SAFETY_PREAMBLE}

You are the BusinessRuleAnalyzer.

You infer the rules that govern an application's behaviour from evidence in its
source code. The user will NOT hand you a requirements document - inferring the
requirements is the job.

For each rule you must fill three separate fields, and they must not blur:
  observed  - literal facts from the evidence. e.g. "UserForm.tsx:42 declares
              email: z.string().email()"
  inferred  - what you conclude from those facts. e.g. "A user cannot be created
              with a malformed email address."
  unknown   - what the evidence cannot tell you. e.g. "Whether the backend
              enforces the same rule, or only the client does."

status must be:
  confirmed         - the rule is literally encoded (a validation schema, an
                      explicit role check, an enum constraint). Confidence >= 0.9.
  strongly_inferred - multiple independent signals agree. Confidence 0.7-0.9.
  weakly_inferred   - one weak signal, e.g. only a variable name. Confidence 0.4-0.7.
  unknown           - you are speculating. Confidence < 0.4. Prefer to record
                      this in "unknowns" instead of emitting a rule.

Every rule needs at least one evidence entry citing a real file from the
evidence given to you. A rule with no citable evidence must not be emitted.

Write rules as behaviour, not as implementation:
  good: "Only administrators can delete a user account."
  bad:  "The component checks user.role === 'admin'."

Return JSON matching the requested schema.`;

export interface BusinessRuleAnalyzerInput {
  projectId: string;
  runId: string;
  analysis: StaticAnalysis;
  feature: FeatureSlice;
  memory: RetrievedMemory;
}

export async function runBusinessRuleAnalyzer(
  input: BusinessRuleAnalyzerInput,
): Promise<AgentResult<BusinessRuleAnalyzerOutput>> {
  const user = `${renderMemoryForPrompt(input.memory)}

---

EVIDENCE FOR THIS FEATURE:
${renderFeatureEvidence(input.analysis, input.feature)}

---

Infer the business rules that govern "${input.feature.name}".
Do not restate rules already listed above as previously discovered unless the
evidence has changed; focus on rules not yet captured.`;

  return runAgent({
    agent: 'BusinessRuleAnalyzer',
    projectId: input.projectId,
    runId: input.runId,
    system: SYSTEM,
    user,
    schema: BusinessRuleAnalyzerOutput,
    temperature: 0.15,
    maxOutputTokens: 8192,
    fallback: () => deterministicRules(input),
  });
}

/**
 * Deterministic rules derived from validation schemas and authorization
 * checks. These are the cases where the code states the rule literally, so
 * they can be produced with no model at all - and they are marked "confirmed"
 * precisely because they are not inferences.
 */
function deterministicRules(input: BusinessRuleAnalyzerInput): BusinessRuleAnalyzerOutput {
  const fileSet = new Set(input.feature.files);
  const rules: BusinessRuleAnalyzerOutput['rules'] = [];

  const byField = new Map<string, typeof input.analysis.validations>();
  for (const v of input.analysis.validations) {
    if (!fileSet.has(v.file)) continue;
    const key = `${v.entity ?? ''}.${v.field}`;
    const list = byField.get(key) ?? [];
    list.push(v);
    byField.set(key, list);
  }

  for (const [key, validations] of byField) {
    const first = validations[0];
    if (!first) continue;
    const constraints = validations.map((v) => v.rule).join(', ');
    const message = validations.find((v) => v.message)?.message;
    rules.push({
      feature: input.feature.key,
      description: `The field "${first.field}" must satisfy: ${constraints}.${message ? ` The application reports "${message}" when it does not.` : ''}`,
      category: 'validation',
      status: 'confirmed',
      confidence: 0.95,
      evidence: validations.slice(0, 5).map((v) => ({
        kind: 'validation_schema' as const,
        file: v.file,
        line: v.line,
        detail: `${v.field}: ${v.rule} [${v.library}]`,
      })),
      observed: validations.map((v) => `${v.file}:${v.line ?? '?'} declares ${v.field} ${v.rule} using ${v.library}`),
      inferred: [`Input for "${first.field}" is rejected unless it satisfies ${constraints}.`],
      unknown: ['Whether the server enforces the same constraint, or only the client does.'],
      relatedRoutes: [],
      relatedApis: [],
      relatedFiles: [...new Set(validations.map((v) => v.file))],
    });
    void key;
  }

  for (const check of input.analysis.permissionChecks) {
    if (!fileSet.has(check.file)) continue;
    if (check.roles.length === 0 && !check.permission) continue;
    const subject = check.roles.length ? `role(s) ${check.roles.join(', ')}` : `permission "${check.permission}"`;
    rules.push({
      feature: input.feature.key,
      description: `Access to this behaviour is gated on ${subject}.`,
      category: 'authorization',
      status: 'confirmed',
      confidence: 0.9,
      evidence: [{ kind: 'source_file', file: check.file, line: check.line, excerpt: check.expression }],
      observed: [`${check.file}:${check.line ?? '?'} guards behaviour with: ${check.expression}`],
      inferred: [`Users without ${subject} are not intended to perform this action.`],
      unknown: ['Whether other roles should also be permitted; the code only shows what is currently checked.'],
      relatedRoutes: [],
      relatedApis: [],
      relatedFiles: [check.file],
    });
  }

  for (const machine of input.analysis.stateMachines) {
    if (!fileSet.has(machine.file)) continue;
    rules.push({
      feature: input.feature.key,
      description: `"${machine.entity}" can be in one of: ${machine.states.join(', ')}.`,
      category: 'state_transition',
      status: 'confirmed',
      confidence: 0.9,
      evidence: [{ kind: 'constant', file: machine.file, detail: machine.states.join(' | ') }],
      observed: [`${machine.file} enumerates states: ${machine.states.join(', ')}`],
      inferred: machine.transitions.length
        ? [`Observed transitions: ${machine.transitions.map((t) => `${t.from} -> ${t.to}`).join(', ')}`]
        : ['The set of states is fixed.'],
      unknown: machine.transitions.length
        ? ['Whether transitions not observed in code are forbidden or simply unimplemented.']
        : ['Which transitions between these states are permitted.'],
      relatedRoutes: [],
      relatedApis: [],
      relatedFiles: [machine.file],
    });
  }

  return {
    rules,
    unknowns: rules.length === 0
      ? [{ subject: input.feature.name, question: 'No validation schemas or authorization checks were found for this feature, and AI inference was unavailable, so no business rules could be derived.' }]
      : [{ subject: input.feature.name, question: 'Rules were derived deterministically from code constraints only; behavioural rules that are not literally encoded were not inferred because AI analysis was unavailable.' }],
  };
}

/** Fills in ids and defaults so the output can be persisted. */
export function toBusinessRules(output: BusinessRuleAnalyzerOutput, featureKey: string): Omit<BusinessRule, 'id'>[] {
  return output.rules.map((r) => ({
    feature: r.feature || featureKey,
    description: r.description,
    evidence: r.evidence ?? [],
    confidence: r.confidence,
    status: r.status,
    observed: r.observed ?? [],
    inferred: r.inferred ?? [],
    unknown: r.unknown ?? [],
    relatedRoutes: r.relatedRoutes ?? [],
    relatedApis: r.relatedApis ?? [],
    relatedFiles: r.relatedFiles ?? [],
    category: r.category ?? 'other',
  }));
}
