/**
 * Validation rule extraction (spec section 4).
 *
 * Understands zod, yup, react-hook-form register options, and HTML5
 * attributes. These are the strongest evidence we have for *confirmed*
 * business rules, because they are literal executable constraints rather
 * than an inference.
 */
import type { ValidationRule } from '@qa-agent/shared';
import { ts, parseSource, forEachNode, lineOf, textOf, literalString } from './ast.js';
import type { ScannedFile } from './scanner.js';

/**
 * Constraints are frequently written against a named constant
 * (`z.string().min(TASK_TITLE_MIN)`). Recording "minLength:TASK_TITLE_MIN"
 * would be useless to a test generator, so module-level numeric constants are
 * resolved to their values first.
 */
function numericConstants(sf: ts.SourceFile, shared?: Map<string, string>): Map<string, string> {
  const constants = new Map<string, string>(shared ?? []);
  forEachNode(sf, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) return;
    const init = node.initializer;
    if (ts.isNumericLiteral(init)) constants.set(node.name.text, init.text);
    else if (ts.isPrefixUnaryExpression(init) && ts.isNumericLiteral(init.operand)
      && init.operator === ts.SyntaxKind.MinusToken) {
      constants.set(node.name.text, `-${init.operand.text}`);
    }
  });
  return constants;
}

/** Replaces a constant identifier with its literal value where known. */
function resolveArg(arg: string | undefined, constants: Map<string, string>): string | undefined {
  if (arg === undefined) return undefined;
  const resolved = constants.get(arg.trim());
  return resolved ?? arg;
}

interface ChainStep { name: string; args: string[] }

/** Flattens `z.string().min(3).email()` into an ordered list of calls. */
function readChain(node: ts.CallExpression, sf: ts.SourceFile): { root: string; steps: ChainStep[] } {
  const steps: ChainStep[] = [];
  let current: ts.Expression = node;
  while (ts.isCallExpression(current)) {
    const callee = current.expression;
    if (ts.isPropertyAccessExpression(callee)) {
      steps.unshift({
        name: callee.name.text,
        args: current.arguments.map((a) => literalString(a) ?? textOf(a, sf).slice(0, 80)),
      });
      current = callee.expression;
    } else break;
  }
  return { root: textOf(current, sf), steps };
}

function describeZodStep(step: ChainStep, constants: Map<string, string>): string | null {
  const arg = resolveArg(step.args[0], constants);
  switch (step.name) {
    case 'min': return `min:${arg ?? '?'}`;
    case 'max': return `max:${arg ?? '?'}`;
    case 'length': return `length:${arg ?? '?'}`;
    case 'email': return 'format:email';
    case 'url': return 'format:url';
    case 'uuid': return 'format:uuid';
    case 'regex': return `pattern:${arg ?? '?'}`;
    case 'int': return 'type:integer';
    case 'positive': return 'value:positive';
    case 'nonnegative': return 'value:>=0';
    case 'negative': return 'value:negative';
    case 'gt': return `gt:${arg ?? '?'}`;
    case 'gte': return `gte:${arg ?? '?'}`;
    case 'lt': return `lt:${arg ?? '?'}`;
    case 'lte': return `lte:${arg ?? '?'}`;
    case 'optional': return 'optional';
    case 'nullable': return 'nullable';
    case 'nonempty': return 'required:nonempty';
    case 'required': return 'required';
    case 'refine':
    case 'superRefine': return 'custom:refine';
    case 'default': return `default:${arg ?? '?'}`;
    case 'string': return 'type:string';
    case 'number': return 'type:number';
    case 'boolean': return 'type:boolean';
    case 'enum': return `enum:${step.args.join('|').slice(0, 120)}`;
    default: return null;
  }
}

/** Grabs `{ message: '...' }` / a trailing string argument as the user-facing message. */
function messageFrom(steps: ChainStep[]): string | undefined {
  for (const step of steps) {
    for (const arg of step.args) {
      if (/message\s*:/.test(arg)) {
        const m = arg.match(/message\s*:\s*['"`]([^'"`]+)['"`]/);
        if (m?.[1]) return m[1];
      }
      if (/^[A-Z].{4,}/.test(arg) && !arg.includes('(')) return arg;
    }
  }
  return undefined;
}

function extractZodOrYup(file: ScannedFile, sf: ts.SourceFile, library: 'zod' | 'yup', shared: Map<string, string>): ValidationRule[] {
  const rules: ValidationRule[] = [];
  const rootPrefix = library === 'zod' ? /^z\b/ : /^(yup|Yup)\b/;
  const constants = numericConstants(sf, shared);

  forEachNode(sf, (node) => {
    if (!ts.isObjectLiteralExpression(node)) return;
    // Look for schema-shaped objects: { field: z.string().min(1), ... }
    for (const prop of node.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const field = prop.name.getText(sf).replace(/['"]/g, '');
      const init = prop.initializer;
      if (!ts.isCallExpression(init)) continue;
      const { root, steps } = readChain(init, sf);
      if (!rootPrefix.test(root)) continue;

      const descriptors = steps.map((step) => describeZodStep(step, constants)).filter((d): d is string => d !== null);
      if (descriptors.length === 0) continue;
      const isOptional = descriptors.includes('optional') || descriptors.includes('nullable');
      if (!isOptional) descriptors.unshift('required');

      const entity = findEnclosingSchemaName(prop, sf);
      for (const rule of descriptors) {
        rules.push({
          entity,
          field,
          rule,
          message: messageFrom(steps),
          library,
          file: file.path,
          line: lineOf(sf, prop),
        });
      }
    }
  });
  return rules;
}

/** Walks up to the `const CreateUserSchema = z.object({...})` name. */
function findEnclosingSchemaName(node: ts.Node, sf: ts.SourceFile): string | undefined {
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
      return current.name.text.replace(/(Schema|Validator|Validation)$/i, '') || current.name.text;
    }
    current = current.parent;
  }
  return undefined;
}

/** react-hook-form: register('email', { required: true, minLength: 3 }) */
function extractReactHookForm(file: ScannedFile, sf: ts.SourceFile): ValidationRule[] {
  const rules: ValidationRule[] = [];
  forEachNode(sf, (node) => {
    if (!ts.isCallExpression(node)) return;
    const calleeText = textOf(node.expression, sf);
    if (!/\bregister$/.test(calleeText)) return;
    const field = node.arguments[0] ? literalString(node.arguments[0]) : undefined;
    const opts = node.arguments[1];
    if (!field || !opts || !ts.isObjectLiteralExpression(opts)) return;
    for (const prop of opts.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const key = prop.name.getText(sf).replace(/['"]/g, '');
      const value = textOf(prop.initializer, sf).slice(0, 120);
      const message = value.match(/message\s*:\s*['"`]([^'"`]+)['"`]/)?.[1];
      const valueSummary = value.match(/value\s*:\s*([^,}]+)/)?.[1]?.trim() ?? value;
      rules.push({
        field,
        rule: `${key}:${valueSummary}`,
        message,
        library: 'react_hook_form',
        file: file.path,
        line: lineOf(sf, prop),
      });
    }
  });
  return rules;
}

/** HTML5 constraints declared directly on inputs. */
function extractHtml5(file: ScannedFile, sf: ts.SourceFile, shared: Map<string, string>): ValidationRule[] {
  const rules: ValidationRule[] = [];
  const constants = numericConstants(sf, shared);
  const CONSTRAINTS = new Set(['required', 'minLength', 'maxLength', 'min', 'max', 'pattern']);
  forEachNode(sf, (node) => {
    if (!ts.isJsxSelfClosingElement(node) && !ts.isJsxOpeningElement(node)) return;
    const tag = node.tagName.getText();
    if (!/^(input|textarea|select|Input|TextField|Textarea|Select)$/.test(tag)) return;
    let field = '';
    const found: { key: string; value: string }[] = [];
    for (const prop of node.attributes.properties) {
      if (!ts.isJsxAttribute(prop) || !prop.name) continue;
      const key = prop.name.getText(sf);
      const init = prop.initializer;
      const value = init && ts.isStringLiteral(init) ? init.text
        : init && ts.isJsxExpression(init) && init.expression ? (literalString(init.expression) ?? textOf(init.expression, sf).slice(0, 40))
        : 'true';
      if (key === 'name' || key === 'id') field ||= value;
      if (key === 'type' && value === 'email') found.push({ key: 'format', value: 'email' });
      if (CONSTRAINTS.has(key)) found.push({ key, value: resolveArg(value, constants) ?? value });
    }
    if (!field || found.length === 0) return;
    for (const { key, value } of found) {
      rules.push({
        field,
        rule: key === 'required' ? 'required' : `${key}:${value}`,
        library: 'html5',
        file: file.path,
        line: lineOf(sf, node),
      });
    }
  });
  return rules;
}

export function extractValidations(files: ScannedFile[]): ValidationRule[] {
  const rules: ValidationRule[] = [];

  // Constraints are usually written against a shared constant that is imported
  // from another module, so the constant table is built across the whole
  // repository before any rule is described.
  const sharedConstants = new Map<string, string>();
  for (const file of files) {
    if (!file.content || file.isTest || !/\.[jt]sx?$/.test(file.path)) continue;
    if (!/\b(const|let|var)\s+[A-Z][A-Z0-9_]*\s*=\s*-?\d/.test(file.content)) continue;
    const sf = parseSource(file.path, file.content);
    for (const [name, value] of numericConstants(sf)) {
      // Only UPPER_SNAKE names: a lowercase local is not a shared constraint.
      if (/^[A-Z][A-Z0-9_]*$/.test(name)) sharedConstants.set(name, value);
    }
  }

  for (const file of files) {
    if (!file.content || file.isTest || !/\.[jt]sx?$/.test(file.path)) continue;
    const sf = parseSource(file.path, file.content);
    if (/\bfrom ['"]zod['"]|\bz\.object\(/.test(file.content)) rules.push(...extractZodOrYup(file, sf, 'zod', sharedConstants));
    if (/\bfrom ['"]yup['"]|yup\.object\(/.test(file.content)) rules.push(...extractZodOrYup(file, sf, 'yup', sharedConstants));
    if (/react-hook-form|\bregister\(/.test(file.content)) rules.push(...extractReactHookForm(file, sf));
    if (/<(input|textarea|select|Input|TextField)/.test(file.content)) rules.push(...extractHtml5(file, sf, sharedConstants));
  }
  // Deduplicate identical (field, rule, file) triples.
  const seen = new Set<string>();
  return rules.filter((r) => {
    const key = `${r.entity ?? ''}|${r.field}|${r.rule}|${r.file}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
