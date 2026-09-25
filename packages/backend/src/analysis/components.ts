/**
 * Component, form and UI-element extraction (spec section 4).
 *
 * Also picks the *best available* locator for each interactive element and
 * records why - the spec requires the system to explain locator choices
 * (section 13) and to prefer stable selectors over fragile CSS/XPath.
 */
import type { ComponentInfo, FormField, UiElement } from '@qa-agent/shared';
import {
  ts, parseSource, forEachNode, lineOf, textOf, getJsxAttributes,
  jsxTextContent, exportedNames, isReactComponentName, importSpecifiers, literalString,
} from './ast.js';
import type { ScannedFile } from './scanner.js';

const INPUT_TAGS = new Set(['input', 'textarea', 'select', 'Input', 'TextField', 'Textarea', 'Select', 'Checkbox', 'Radio']);
const BUTTON_TAGS = new Set(['button', 'Button', 'IconButton', 'SubmitButton', 'LoadingButton']);
const TABLE_TAGS = new Set(['table', 'Table', 'DataGrid', 'DataTable']);
const MODAL_TAGS = new Set(['Modal', 'Dialog', 'Drawer', 'Sheet', 'AlertDialog', 'Popover']);
const LINK_TAGS = new Set(['a', 'Link', 'NavLink']);

/** Ranked selector strategies - earlier is more stable. */
export function pickSelector(attrs: Record<string, string>, tag: string, text: string): Pick<UiElement, 'selector' | 'selectorStrategy' | 'selectorRationale'> {
  const testId = attrs['data-testid'] ?? attrs['data-test-id'] ?? attrs['data-cy'] ?? attrs['data-test'];
  if (testId && !testId.startsWith('{')) {
    const attrName = attrs['data-testid'] ? 'data-testid'
      : attrs['data-test-id'] ? 'data-test-id'
      : attrs['data-cy'] ? 'data-cy' : 'data-test';
    return {
      selector: `[${attrName}="${testId}"]`,
      selectorStrategy: 'data-testid',
      selectorRationale: `Element declares ${attrName}="${testId}" in source, which is the most stable locator available and is not affected by styling or copy changes.`,
    };
  }
  const aria = attrs['aria-label'];
  if (aria && !aria.startsWith('{')) {
    return {
      selector: `[aria-label="${aria}"]`,
      selectorStrategy: 'aria-label',
      selectorRationale: `No test id present; element exposes aria-label="${aria}", which is stable and also asserts accessibility.`,
    };
  }
  const role = attrs['role'];
  if (role && !role.startsWith('{') && text) {
    return {
      selector: `[role="${role}"]`,
      selectorStrategy: 'role',
      selectorRationale: `No test id or aria-label; falling back to the explicit role="${role}" combined with visible text "${text}".`,
    };
  }
  const name = attrs['name'];
  if (name && !name.startsWith('{')) {
    return {
      selector: `[name="${name}"]`,
      selectorStrategy: 'name',
      selectorRationale: `Form control has name="${name}"; the name attribute is tied to submission semantics and rarely changes with styling.`,
    };
  }
  const id = attrs['id'];
  if (id && !id.startsWith('{')) {
    return {
      selector: `#${id}`,
      selectorStrategy: 'id',
      selectorRationale: `Element has a literal id="${id}" in source. Stable unless the id is regenerated.`,
    };
  }
  if (text && text.length <= 50) {
    return {
      selector: text,
      selectorStrategy: 'text',
      selectorRationale: `No structural hook found; matching on visible text "${text}". This is readable but will break if the copy changes - adding a data-testid is recommended.`,
    };
  }
  const type = attrs['type'];
  if (INPUT_TAGS.has(tag) && type) {
    return {
      selector: `${tag.toLowerCase()}[type="${type}"]`,
      selectorStrategy: 'css',
      selectorRationale: `Last resort: no test id, aria-label, name, id, or stable text was found, so the locator falls back to a CSS type selector. This is fragile.`,
    };
  }
  return {
    selector: tag.toLowerCase(),
    selectorStrategy: 'css',
    selectorRationale: 'Last resort: the element exposes no stable attribute, so only a tag-level CSS selector is possible. Flagged as fragile.',
  };
}

function elementKind(tag: string): UiElement['kind'] {
  if (BUTTON_TAGS.has(tag)) return 'button';
  if (tag === 'textarea' || tag === 'Textarea') return 'textarea';
  if (tag === 'select' || tag === 'Select') return 'select';
  if (TABLE_TAGS.has(tag)) return 'table';
  if (MODAL_TAGS.has(tag)) return 'modal';
  if (LINK_TAGS.has(tag)) return 'link';
  if (INPUT_TAGS.has(tag)) return 'input';
  return 'other';
}

function inferComponentKind(rel: string, content: string): ComponentInfo['kind'] {
  const p = rel.toLowerCase();
  if (/\.(cy|spec|test)\.[jt]sx?$/.test(p) || /(^|\/)(cypress|e2e|__tests__)\//.test(p)) return 'test';
  if (/(^|\/)(pages|app)\//.test(p) && /(page|index)\.[jt]sx?$/.test(p)) return 'page';
  if (/layout\.[jt]sx?$/.test(p)) return 'layout';
  if (/(^|\/)hooks?\//.test(p) || /(^|\/)use[A-Z]/.test(rel)) return 'hook';
  if (/(^|\/)(services?|api)\//.test(p)) return /(^|\/)api\//.test(p) ? 'api_client' : 'service';
  if (/(^|\/)(store|stores|state|redux|slices?)\//.test(p)) return 'store';
  if (/(^|\/)(utils?|helpers?|lib)\//.test(p)) return 'util';
  if (/(^|\/)components?\//.test(p)) return 'component';
  if (/<[A-Za-z]/.test(content)) return 'component';
  return 'unknown';
}

/** Recognises `{loading && <Spinner/>}`-style conditional UI. */
function classifyCondition(expr: string): 'loading' | 'error' | 'empty' | 'other' {
  const e = expr.toLowerCase();
  if (/\b(isloading|loading|ispending|pending|isfetching|issubmitting)\b/.test(e)) return 'loading';
  if (/\b(error|iserror|haserror|failed)\b/.test(e)) return 'error';
  if (/(length\s*===\s*0|!\w+\.length|isempty|\.length\s*<\s*1|nodata)/.test(e)) return 'empty';
  return 'other';
}

export function extractComponents(files: ScannedFile[]): ComponentInfo[] {
  const components: ComponentInfo[] = [];

  for (const file of files) {
    if (!file.content || file.isTest) continue;
    if (!/\.[jt]sx?$/.test(file.path)) continue;

    const sf = parseSource(file.path, file.content);
    const exported = exportedNames(sf);
    const kind = inferComponentKind(file.path, file.content);

    const elements: UiElement[] = [];
    const forms: ComponentInfo['forms'] = [];
    const usesComponents = new Set<string>();
    const conditionalRendering: string[] = [];
    const loadingStates: string[] = [];
    const errorStates: string[] = [];
    const emptyStates: string[] = [];

    // Track the JSX <form> currently being walked so fields land in the right form.
    const formStack: { name?: string; fields: FormField[] }[] = [];

    const visitJsxOpen = (node: ts.JsxOpeningLikeElement, parent: ts.Node) => {
      const tag = node.tagName.getText();
      const attrs = getJsxAttributes(node, sf);
      if (isReactComponentName(tag)) usesComponents.add(tag);

      if (tag === 'form' || tag === 'Form') {
        formStack.push({ name: attrs['name'] ?? attrs['id'] ?? attrs['data-testid'], fields: [] });
        return;
      }

      const text = ts.isJsxElement(parent) ? jsxTextContent(parent, sf) : (attrs['children'] ?? '');
      const label = attrs['aria-label'] ?? attrs['placeholder'] ?? attrs['label'] ?? (text || undefined);
      const kindOfEl = elementKind(tag);

      if (kindOfEl !== 'other' || attrs['onClick'] || attrs['onChange'] || attrs['onSubmit']) {
        const sel = pickSelector(attrs, tag, text);
        elements.push({
          kind: kindOfEl,
          label,
          ...sel,
          action: attrs['onClick'] ? 'click' : attrs['onChange'] ? 'change' : attrs['onSubmit'] ? 'submit' : undefined,
          file: file.path,
          line: lineOf(sf, node),
        });
      }

      if (INPUT_TAGS.has(tag)) {
        const sel = pickSelector(attrs, tag, text);
        const validation: string[] = [];
        if (attrs['required'] !== undefined) validation.push('required');
        if (attrs['minLength']) validation.push(`minLength:${attrs['minLength']}`);
        if (attrs['maxLength']) validation.push(`maxLength:${attrs['maxLength']}`);
        if (attrs['min']) validation.push(`min:${attrs['min']}`);
        if (attrs['max']) validation.push(`max:${attrs['max']}`);
        if (attrs['pattern']) validation.push(`pattern:${attrs['pattern']}`);
        if (attrs['type'] === 'email') validation.push('format:email');
        const field: FormField = {
          name: attrs['name'] ?? attrs['id'] ?? attrs['data-testid'] ?? label ?? tag.toLowerCase(),
          label,
          inputType: attrs['type'] ?? (tag === 'textarea' ? 'textarea' : tag === 'select' ? 'select' : 'text'),
          required: attrs['required'] !== undefined,
          validation,
          selector: sel.selector,
        };
        const current = formStack[formStack.length - 1];
        if (current) current.fields.push(field);
        else forms.push({ name: undefined, fields: [field] });
      }
    };

    const walk = (node: ts.Node) => {
      if (ts.isJsxElement(node)) {
        visitJsxOpen(node.openingElement, node);
        node.children.forEach(walk);
        if (node.openingElement.tagName.getText() === 'form' || node.openingElement.tagName.getText() === 'Form') {
          const done = formStack.pop();
          if (done && done.fields.length > 0) forms.push(done);
        }
        return;
      }
      if (ts.isJsxSelfClosingElement(node)) { visitJsxOpen(node, node); }

      // `{cond && <X/>}` and `{cond ? <A/> : <B/>}`
      if (ts.isJsxExpression(node) && node.expression) {
        const e = node.expression;
        let condText: string | null = null;
        if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
          condText = textOf(e.left, sf);
        } else if (ts.isConditionalExpression(e)) {
          condText = textOf(e.condition, sf);
        }
        if (condText) {
          const trimmed = condText.slice(0, 120);
          conditionalRendering.push(trimmed);
          switch (classifyCondition(trimmed)) {
            case 'loading': loadingStates.push(trimmed); break;
            case 'error': errorStates.push(trimmed); break;
            case 'empty': emptyStates.push(trimmed); break;
          }
        }
      }
      node.forEachChild(walk);
    };
    walk(sf);
    while (formStack.length) {
      const done = formStack.pop();
      if (done && done.fields.length > 0) forms.push(done);
    }

    const imports = importSpecifiers(sf);
    const localComponents = imports
      .filter((i) => i.module.startsWith('.') || i.module.startsWith('@/'))
      .flatMap((i) => i.names.filter(isReactComponentName));
    for (const c of localComponents) usesComponents.add(c);

    const primaryName = exported.find(isReactComponentName)
      ?? exported[0]
      ?? file.path.split('/').pop()!.replace(/\.[jt]sx?$/, '');

    if (
      elements.length === 0 && forms.length === 0 && exported.length === 0 &&
      kind === 'unknown'
    ) continue;

    components.push({
      name: primaryName,
      file: file.path,
      kind,
      exported: exported.length > 0,
      props: [],
      forms,
      elements,
      usesComponents: [...usesComponents],
      callsApis: [],
      conditionalRendering: [...new Set(conditionalRendering)].slice(0, 40),
      loadingStates: [...new Set(loadingStates)].slice(0, 20),
      errorStates: [...new Set(errorStates)].slice(0, 20),
      emptyStates: [...new Set(emptyStates)].slice(0, 20),
    });
  }

  return components;
}

/** Collects every literal test id in the repo - used by self-healing. */
export function collectTestIds(files: ScannedFile[]): { testId: string; file: string; line: number }[] {
  const out: { testId: string; file: string; line: number }[] = [];
  for (const file of files) {
    if (!file.content || !/\.[jt]sx?$/.test(file.path)) continue;
    const sf = parseSource(file.path, file.content);
    forEachNode(sf, (node) => {
      if (!ts.isJsxAttribute(node) || !node.name) return;
      const name = node.name.getText(sf);
      if (!/^data-(testid|test-id|cy|test)$/.test(name)) return;
      const init = node.initializer;
      const value = init && ts.isStringLiteral(init) ? init.text
        : init && ts.isJsxExpression(init) && init.expression ? literalString(init.expression) : undefined;
      if (value) out.push({ testId: value, file: file.path, line: lineOf(sf, node) });
    });
  }
  return out;
}
