/**
 * State machines, status values, constants, feature flags, entities and
 * error handling (spec section 4).
 *
 * Status enumerations drive the state-transition scenarios the spec asks for,
 * and they are only worth generating when the application really has them.
 */
import type { EntityInfo, StateMachine } from '@qa-agent/shared';
import { ts, parseSource, forEachNode, textOf, literalString } from './ast.js';
import type { ScannedFile } from './scanner.js';

const STATUS_NAME = /(status|state|stage|phase|step|condition)e?s?$/i;

export interface StateExtraction {
  stateMachines: StateMachine[];
  statusValues: { name: string; values: string[]; file: string }[];
  constants: { name: string; value: string; file: string }[];
  featureFlags: { name: string; file: string }[];
  entities: EntityInfo[];
  errorHandling: { file: string; detail: string }[];
}

function readStringArray(node: ts.Node): string[] {
  if (!ts.isArrayLiteralExpression(node)) return [];
  return node.elements.map((e) => literalString(e)).filter((v): v is string => typeof v === 'string');
}

function readUnionLiterals(node: ts.TypeNode): string[] {
  if (!ts.isUnionTypeNode(node)) return [];
  const out: string[] = [];
  for (const t of node.types) {
    if (ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal)) out.push(t.literal.text);
  }
  return out;
}

export function extractState(files: ScannedFile[]): StateExtraction {
  const stateMachines: StateMachine[] = [];
  const statusValues: { name: string; values: string[]; file: string }[] = [];
  const constants: { name: string; value: string; file: string }[] = [];
  const featureFlags: { name: string; file: string }[] = [];
  const entities: EntityInfo[] = [];
  const errorHandling: { file: string; detail: string }[] = [];

  for (const file of files) {
    if (!file.content || file.isTest || !/\.[jt]sx?$/.test(file.path)) continue;
    const sf = parseSource(file.path, file.content);

    forEachNode(sf, (node) => {
      /* -- enums: status values and roles -------------------------------- */
      if (ts.isEnumDeclaration(node)) {
        const values = node.members
          .map((m) => (m.initializer ? literalString(m.initializer) : undefined) ?? m.name.getText(sf))
          .filter((v): v is string => Boolean(v));
        entities.push({
          name: node.name.text, file: file.path, kind: 'enum',
          fields: values.map((v) => ({ name: v, type: 'string', optional: false })),
        });
        if (STATUS_NAME.test(node.name.text) && values.length > 1) {
          statusValues.push({ name: node.name.text, values, file: file.path });
        }
        return;
      }

      /* -- interfaces / type aliases: entities and status unions ---------- */
      if (ts.isInterfaceDeclaration(node)) {
        entities.push({
          name: node.name.text, file: file.path, kind: 'interface',
          fields: node.members.filter(ts.isPropertySignature).map((m) => ({
            name: m.name?.getText(sf) ?? '', type: m.type ? textOf(m.type, sf).slice(0, 80) : 'unknown',
            optional: Boolean(m.questionToken),
          })),
        });
        // A status-ish member typed as a string union is a state enumeration.
        for (const m of node.members) {
          if (!ts.isPropertySignature(m) || !m.name || !m.type) continue;
          const memberName = m.name.getText(sf);
          if (!STATUS_NAME.test(memberName)) continue;
          const values = readUnionLiterals(m.type);
          if (values.length > 1) {
            statusValues.push({ name: `${node.name.text}.${memberName}`, values, file: file.path });
          }
        }
        return;
      }

      if (ts.isTypeAliasDeclaration(node)) {
        const values = readUnionLiterals(node.type);
        if (values.length > 1) {
          entities.push({
            name: node.name.text, file: file.path, kind: 'type',
            fields: values.map((v) => ({ name: v, type: 'literal', optional: false })),
          });
          if (STATUS_NAME.test(node.name.text)) {
            statusValues.push({ name: node.name.text, values, file: file.path });
          }
        } else if (ts.isTypeLiteralNode(node.type)) {
          entities.push({
            name: node.name.text, file: file.path, kind: 'type',
            fields: node.type.members.filter(ts.isPropertySignature).map((m) => ({
              name: m.name?.getText(sf) ?? '', type: m.type ? textOf(m.type, sf).slice(0, 80) : 'unknown',
              optional: Boolean(m.questionToken),
            })),
          });
        }
        return;
      }

      /* -- const declarations: constants, flags, status arrays ------------ */
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const name = node.name.text;
        const init = node.initializer;

        if (/^(FEATURE_FLAGS?|FLAGS?)$/i.test(name) || /featureFlags?$/i.test(name)) {
          if (ts.isObjectLiteralExpression(init)) {
            for (const prop of init.properties) {
              if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
                featureFlags.push({ name: prop.name!.getText(sf).replace(/['"]/g, ''), file: file.path });
              }
            }
          }
          return;
        }

        const arrayValues = readStringArray(init);
        if (arrayValues.length > 1 && STATUS_NAME.test(name)) {
          statusValues.push({ name, values: arrayValues, file: file.path });
          return;
        }

        // UPPER_SNAKE literals are business constants worth remembering.
        if (/^[A-Z][A-Z0-9_]{2,}$/.test(name)) {
          const value = literalString(init) ?? (ts.isNumericLiteral(init) ? init.text : undefined);
          if (value !== undefined) constants.push({ name, value, file: file.path });
          else if (ts.isObjectLiteralExpression(init) || ts.isArrayLiteralExpression(init)) {
            constants.push({ name, value: textOf(init, sf).replace(/\s+/g, ' ').slice(0, 200), file: file.path });
          }
        }
        return;
      }

      /* -- error handling ------------------------------------------------- */
      if (ts.isTryStatement(node)) {
        const catchText = node.catchClause ? textOf(node.catchClause, sf).replace(/\s+/g, ' ').slice(0, 200) : '';
        if (catchText) errorHandling.push({ file: file.path, detail: `try/catch: ${catchText}` });
        return;
      }
      if (ts.isThrowStatement(node)) {
        errorHandling.push({ file: file.path, detail: `throw: ${textOf(node.expression, sf).replace(/\s+/g, ' ').slice(0, 160)}` });
      }
    });

    /* -- transitions: status assignments seen in the same file ------------ */
    const transitionRe = /\b(?:setStatus|updateStatus|changeStatus|transitionTo|setState)\s*\(\s*['"`]([\w-]+)['"`]/g;
    const assigned = [...file.content.matchAll(transitionRe)].map((m) => m[1]!).filter(Boolean);
    if (assigned.length > 0) {
      const related = statusValues.find((s) => s.file === file.path)
        ?? statusValues.find((s) => assigned.every((a) => s.values.includes(a)));
      if (related) {
        const from = related.values.filter((v) => !assigned.includes(v));
        stateMachines.push({
          entity: related.name,
          states: related.values,
          transitions: assigned.flatMap((to) =>
            (from.length ? from : related.values.filter((v) => v !== to)).map((f) => ({ from: f, to, trigger: undefined })),
          ).slice(0, 20),
          file: file.path,
        });
      }
    }
  }

  /* -- a status enumeration with no observed transitions is still a machine */
  for (const status of statusValues) {
    if (stateMachines.some((sm) => sm.entity === status.name)) continue;
    if (status.values.length < 2) continue;
    stateMachines.push({ entity: status.name, states: status.values, transitions: [], file: status.file });
  }

  const dedupe = <T>(items: T[], key: (t: T) => string): T[] => {
    const seen = new Set<string>();
    return items.filter((i) => { const k = key(i); if (seen.has(k)) return false; seen.add(k); return true; });
  };

  return {
    stateMachines: dedupe(stateMachines, (s) => `${s.entity}|${s.file}`),
    statusValues: dedupe(statusValues, (s) => `${s.name}|${s.file}`),
    constants: dedupe(constants, (c) => `${c.name}|${c.file}`).slice(0, 300),
    featureFlags: dedupe(featureFlags, (f) => `${f.name}|${f.file}`),
    entities: dedupe(entities, (e) => `${e.name}|${e.file}`),
    errorHandling: dedupe(errorHandling, (e) => `${e.file}|${e.detail}`).slice(0, 200),
  };
}

/** Environment variable *names* only - values are never read (spec section 27). */
export function extractEnvVarNames(files: ScannedFile[]): string[] {
  const names = new Set<string>();
  for (const file of files) {
    if (!file.content) continue;
    for (const m of file.content.matchAll(/process\.env\.([A-Z0-9_]+)/g)) if (m[1]) names.add(m[1]);
    for (const m of file.content.matchAll(/process\.env\[['"`]([A-Z0-9_]+)['"`]\]/g)) if (m[1]) names.add(m[1]);
    for (const m of file.content.matchAll(/import\.meta\.env\.([A-Z0-9_]+)/g)) if (m[1]) names.add(m[1]);
    if (/\.env\.(example|sample|template)$/.test(file.path)) {
      for (const m of file.content.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)) if (m[1]) names.add(m[1]);
    }
  }
  return [...names].sort();
}
