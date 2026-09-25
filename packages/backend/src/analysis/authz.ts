/**
 * Authentication, authorization, roles and permissions (spec section 4).
 *
 * These are the highest-value signals for business rules: a literal
 * `if (user.role !== 'admin') return null` is *observed* behaviour, and the
 * rule "only administrators can do X" is the inference drawn from it. The two
 * are kept apart downstream (spec section 28).
 */
import type { PermissionCheck, RoleInfo } from '@qa-agent/shared';
import { ts, parseSource, forEachNode, lineOf, textOf, literalString } from './ast.js';
import type { ScannedFile } from './scanner.js';

const ROLE_HINT = /\b(role|roles|userRole|permission|permissions|scope|scopes|can|ability|acl|policy)\b/i;
const AUTH_HINT = /\b(useSession|getServerSession|useAuth|isAuthenticated|requireAuth|withAuth|ProtectedRoute|RequireAuth|currentUser|useUser|getToken|jwt|signIn|signOut|login|logout|authGuard)\b/;
const AUTH_HINT_GLOBAL = new RegExp(AUTH_HINT.source, 'g');

export interface AuthzExtraction {
  roles: RoleInfo[];
  permissionChecks: PermissionCheck[];
  authSignals: { file: string; detail: string }[];
}

/** Role names appearing as literals next to a role-ish identifier. */
function rolesInExpression(text: string): string[] {
  const roles = new Set<string>();
  const patterns = [
    /\b(?:role|roles|userRole)\b\s*(?:===|==|!==|!=)\s*['"`]([\w-]+)['"`]/g,
    /['"`]([\w-]+)['"`]\s*(?:===|==|!==|!=)\s*\b(?:role|roles|userRole)\b/g,
    /\b(?:roles|allowedRoles|permittedRoles)\b\s*\.\s*(?:includes|has|some)\s*\(\s*['"`]([\w-]+)['"`]/g,
    /\[\s*((?:['"`][\w-]+['"`]\s*,?\s*)+)\]\s*\.\s*includes\s*\(\s*\w*\.?role/g,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const captured = m[1];
      if (!captured) continue;
      if (captured.includes(',') || captured.includes("'") || captured.includes('"')) {
        for (const lit of captured.matchAll(/['"`]([\w-]+)['"`]/g)) if (lit[1]) roles.add(lit[1]);
      } else {
        roles.add(captured);
      }
    }
  }
  return [...roles];
}

/** Enum/const declarations that clearly enumerate roles. */
function rolesFromDeclarations(file: ScannedFile, sf: ts.SourceFile): RoleInfo[] {
  const out: RoleInfo[] = [];
  forEachNode(sf, (node) => {
    if (ts.isEnumDeclaration(node)) {
      if (!/role/i.test(node.name.text)) return;
      const values = node.members
        .map((m) => (m.initializer ? literalString(m.initializer) : undefined) ?? m.name.getText(sf))
        .filter(Boolean);
      for (const v of values) out.push({ name: String(v), source: `${file.path}:${node.name.text}`, permissions: [] });
      return;
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const name = node.name.text;
      if (!/roles?$/i.test(name) && !/^ROLES?/i.test(name)) return;
      const init = node.initializer;
      if (ts.isArrayLiteralExpression(init)) {
        for (const el of init.elements) {
          const v = literalString(el);
          if (v) out.push({ name: v, source: `${file.path}:${name}`, permissions: [] });
        }
      } else if (ts.isObjectLiteralExpression(init)) {
        for (const prop of init.properties) {
          if (!ts.isPropertyAssignment(prop)) continue;
          const v = literalString(prop.initializer) ?? prop.name.getText(sf).replace(/['"]/g, '');
          const permissions: string[] = [];
          if (ts.isArrayLiteralExpression(prop.initializer)) {
            for (const el of prop.initializer.elements) {
              const p = literalString(el);
              if (p) permissions.push(p);
            }
          }
          out.push({
            name: permissions.length ? prop.name.getText(sf).replace(/['"]/g, '') : v,
            source: `${file.path}:${name}`,
            permissions,
          });
        }
      }
    }
  });
  return out;
}

export function extractAuthz(files: ScannedFile[]): AuthzExtraction {
  const roleMap = new Map<string, RoleInfo>();
  const permissionChecks: PermissionCheck[] = [];
  const authSignals: { file: string; detail: string }[] = [];

  const addRole = (r: RoleInfo) => {
    const key = r.name.toLowerCase();
    const existing = roleMap.get(key);
    if (existing) {
      existing.permissions = [...new Set([...existing.permissions, ...r.permissions])];
      return;
    }
    roleMap.set(key, { ...r });
  };

  for (const file of files) {
    if (!file.content || file.isTest || !/\.[jt]sx?$/.test(file.path)) continue;
    const content = file.content;
    const sf = parseSource(file.path, content);

    if (AUTH_HINT.test(content)) {
      // matchAll requires a global regexp, so a global twin is used for scanning.
      const hits = [...new Set([...content.matchAll(AUTH_HINT_GLOBAL)].map((m) => m[0]))].slice(0, 8);
      authSignals.push({ file: file.path, detail: `Authentication signals: ${hits.join(', ')}` });
    }

    for (const r of rolesFromDeclarations(file, sf)) addRole(r);

    // Conditional expressions that gate behaviour on a role or permission.
    forEachNode(sf, (node) => {
      let condition: ts.Node | undefined;
      let guards: string | undefined;

      if (ts.isIfStatement(node)) {
        condition = node.expression;
        guards = textOf(node.thenStatement, sf).slice(0, 160);
      } else if (ts.isConditionalExpression(node)) {
        condition = node.condition;
        guards = textOf(node.whenTrue, sf).slice(0, 160);
      } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        condition = node.left;
        guards = textOf(node.right, sf).slice(0, 160);
      } else return;

      const expr = textOf(condition, sf);
      if (!expr || expr.length > 300) return;
      if (!ROLE_HINT.test(expr) && !/\bis(Admin|Owner|Manager|Authorized|Allowed)\b/.test(expr)) return;

      const roles = rolesInExpression(expr);
      for (const name of roles) addRole({ name, source: `${file.path}`, permissions: [] });

      const permission = expr.match(/\b(?:can|hasPermission|checkPermission|ability\.can)\s*\(\s*['"`]([\w:.-]+)['"`]/)?.[1];
      permissionChecks.push({
        expression: expr.replace(/\s+/g, ' ').slice(0, 240),
        roles,
        permission,
        guards: guards?.replace(/\s+/g, ' '),
        file: file.path,
        line: lineOf(sf, node),
      });
    });
  }

  // Deduplicate identical checks.
  const seen = new Set<string>();
  const checks = permissionChecks.filter((c) => {
    const key = `${c.file}|${c.expression}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { roles: [...roleMap.values()], permissionChecks: checks, authSignals };
}
