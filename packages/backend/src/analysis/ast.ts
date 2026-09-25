/**
 * TypeScript compiler API helpers.
 *
 * The TS compiler parses .ts/.tsx/.js/.jsx, which covers everything the spec
 * asks us to support, so the whole static layer uses one parser.
 */
import ts from 'typescript';
import path from 'node:path';

export function parseSource(filePath: string, content: string): ts.SourceFile {
  const ext = path.extname(filePath).toLowerCase();
  const scriptKind =
    ext === '.tsx' ? ts.ScriptKind.TSX :
    ext === '.jsx' ? ts.ScriptKind.JSX :
    ext === '.js' || ext === '.mjs' || ext === '.cjs' ? ts.ScriptKind.JSX : // JSX-tolerant
    ts.ScriptKind.TS;
  return ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, scriptKind);
}

export function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

export function forEachNode(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => forEachNode(child, visit));
}

export function textOf(node: ts.Node | undefined, sf: ts.SourceFile): string {
  if (!node) return '';
  try { return node.getText(sf); } catch { return ''; }
}

/** Reads a string literal or template with no substitutions. */
export function literalString(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

/**
 * Reads a template literal into a route-ish pattern: `/api/users/${id}`
 * becomes `/api/users/:id`, which is what we want for API matching.
 */
export function templateToPattern(node: ts.Node): string | undefined {
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (!ts.isTemplateExpression(node)) return undefined;
  let out = node.head.text;
  for (const span of node.templateSpans) {
    const expr = span.expression;
    const name = ts.isIdentifier(expr) ? expr.text
      : ts.isPropertyAccessExpression(expr) ? expr.name.text
      : 'param';
    out += `:${name}${span.literal.text}`;
  }
  return out;
}

/** String value of a string literal, template, or identifier-ish expression. */
export function stringish(node: ts.Node | undefined, sf: ts.SourceFile): string | undefined {
  if (!node) return undefined;
  const lit = literalString(node);
  if (lit !== undefined) return lit;
  const tpl = templateToPattern(node);
  if (tpl !== undefined) return tpl;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = stringish(node.left, sf);
    const right = stringish(node.right, sf);
    if (left !== undefined || right !== undefined) return `${left ?? ':param'}${right ?? ':param'}`;
  }
  return undefined;
}

export function getJsxTagName(node: ts.JsxOpeningLikeElement): string {
  return node.tagName.getText();
}

export function getJsxAttributes(node: ts.JsxOpeningLikeElement, sf: ts.SourceFile): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const prop of node.attributes.properties) {
    if (!ts.isJsxAttribute(prop) || !prop.name) continue;
    const name = prop.name.getText(sf);
    const init = prop.initializer;
    if (!init) { attrs[name] = 'true'; continue; }
    if (ts.isStringLiteral(init)) { attrs[name] = init.text; continue; }
    if (ts.isJsxExpression(init) && init.expression) {
      const s = stringish(init.expression, sf);
      attrs[name] = s !== undefined ? s : `{${textOf(init.expression, sf).slice(0, 120)}}`;
    }
  }
  return attrs;
}

/** Collects the plain text children of a JSX element, for button labels. */
export function jsxTextContent(node: ts.Node, sf: ts.SourceFile): string {
  let out = '';
  node.forEachChild((child) => {
    if (ts.isJsxText(child)) out += child.text;
    else if (ts.isJsxExpression(child) && child.expression) {
      const s = literalString(child.expression);
      if (s) out += s;
    } else if (ts.isJsxElement(child) || ts.isJsxFragment(child)) {
      out += jsxTextContent(child, sf);
    }
  });
  return out.replace(/\s+/g, ' ').trim();
}

/** Top-level exported declaration names, used to detect components. */
export function exportedNames(sf: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const stmt of sf.statements) {
    const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) ?? [] : [];
    const isExported = mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    if (ts.isFunctionDeclaration(stmt) && stmt.name && (isExported || isDefault)) names.push(stmt.name.text);
    else if (ts.isClassDeclaration(stmt) && stmt.name && (isExported || isDefault)) names.push(stmt.name.text);
    else if (ts.isVariableStatement(stmt) && isExported) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) names.push(d.name.text);
      }
    } else if (ts.isExportAssignment(stmt)) {
      const e = stmt.expression;
      if (ts.isIdentifier(e)) names.push(e.text);
    }
  }
  return names;
}

/** Every top-level function-ish declaration, for change detection. */
export function topLevelFunctions(sf: ts.SourceFile): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  const push = (name: string, node: ts.Node) => out.push({ name, text: textOf(node, sf) });
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) push(stmt.name.text, stmt);
    else if (ts.isClassDeclaration(stmt) && stmt.name) {
      push(stmt.name.text, stmt);
      for (const member of stmt.members) {
        if ((ts.isMethodDeclaration(member) || ts.isPropertyDeclaration(member)) && member.name) {
          push(`${stmt.name.text}.${member.name.getText(sf)}`, member);
        }
      }
    } else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        if (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) push(d.name.text, d);
      }
    }
  }
  return out;
}

export function isReactComponentName(name: string): boolean {
  return /^[A-Z]/.test(name);
}

export function importSpecifiers(sf: ts.SourceFile): { module: string; names: string[] }[] {
  const out: { module: string; names: string[] }[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const mod = literalString(stmt.moduleSpecifier);
    if (!mod) continue;
    const names: string[] = [];
    const clause = stmt.importClause;
    if (clause?.name) names.push(clause.name.text);
    if (clause?.namedBindings) {
      if (ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) names.push(el.name.text);
      } else if (ts.isNamespaceImport(clause.namedBindings)) {
        names.push(clause.namedBindings.name.text);
      }
    }
    out.push({ module: mod, names });
  }
  return out;
}

export { ts };
