/**
 * A test-oriented model of the application, built from static analysis.
 *
 * Scenario generation and test synthesis both need the same facts: which page
 * a form lives on, the selector for each field and its submit button, the
 * limits a field enforces, which API a page reads and writes, which roles may
 * see it, and realistic data to render it with. They are computed once here so
 * the scenarios and the Playwright code that implements them cannot disagree.
 */
import type { ComponentInfo, EntityInfo, StaticAnalysis } from '@qa-agent/shared';

export interface ModelField {
  name: string;
  label: string;
  inputType: string;
  selector: string;
  required: boolean;
  email: boolean;
  /** Numeric bounds for number inputs, length bounds for text. */
  min: number | null;
  max: number | null;
  options: string[];
}

export interface ModelForm {
  name: string;
  label: string;
  route: string;
  file: string;
  fields: ModelField[];
  submitSelector: string;
  /** The API the form writes to, when one can be identified. */
  submitApi: ModelApi | null;
  /** A selector that appears only after a successful submit, if known. */
  successSelector: string | null;
}

export interface ModelApi {
  method: string;
  path: string;
  /** Regex source (without anchors) matching the request URL path. */
  pattern: string;
  entity: string | null;
}

export interface ModelRowAction {
  label: string;
  /** Attribute-prefix selector matching the action on any row. */
  selector: string;
  api: ModelApi | null;
  /** A status value the action appears to set, e.g. "approved" for "Approve". */
  targetState: string | null;
}

export interface ModelPage {
  route: string;
  file: string;
  component: string;
  requiresAuth: boolean;
  guardedByRoles: string[];
  /** Permission strings checked on this page, e.g. "task:create". */
  permissions: string[];
  /** Selector of an element shown when access is refused, if the code has one. */
  deniedSelector: string | null;
  forms: ModelForm[];
  readApis: ModelApi[];
  writeApis: ModelApi[];
  tableSelector: string | null;
  searchSelector: string | null;
  links: { label: string; selector: string; target: string }[];
  rowActions: ModelRowAction[];
  /** An element proving the page's own content rendered. */
  contentSelector: string | null;
  hasErrorState: boolean;
  hasEmptyState: boolean;
}

export interface AppModel {
  pages: ModelPage[];
  sessionApi: ModelApi | null;
  roles: { name: string; permissions: string[] }[];
  /** Builds the session object the app expects for a role. */
  sessionFor(role: string | null): Record<string, unknown> | null;
  /** Sample records for an entity, one per state when it has a status field. */
  fixturesFor(entity: string | null): Record<string, unknown>[];
  /** A value the field accepts. */
  validValue(field: ModelField): string;
  pageForRoute(route: string): ModelPage | undefined;
  mostPrivilegedRole(): string | null;
  roleWithout(permissionOrRoles: { permission?: string; roles?: string[] }): string | null;
  roleWith(permissionOrRoles: { permission?: string; roles?: string[] }): string | null;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** "/tasks/:id/status" -> "/tasks/[^/]+/status" (regex source). */
export function apiPattern(path: string): string {
  return path
    .split('/')
    .map((seg) => (seg.startsWith(':') || /^\[.+\]$/.test(seg) || /^\$\{.+\}$/.test(seg) ? '[^/]+' : esc(seg)))
    .join('/');
}

function singular(word: string): string {
  if (/ies$/i.test(word)) return word.replace(/ies$/i, 'y');
  if (/(ss|us)$/i.test(word)) return word;
  return word.replace(/s$/i, '');
}

function testIdPrefix(selector: string): string | null {
  const m = selector.match(/^\[data-(testid|test-id|cy|test)="([^"]*?):[a-zA-Z_]\w*"\]$/);
  return m ? `[data-${m[1]}^="${m[2]}"]` : null;
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
}

export function buildAppModel(analysis: StaticAnalysis): AppModel {
  const entitiesByName = new Map(analysis.entities.map((e) => [e.name, e]));
  const componentsByName = new Map(analysis.components.map((c) => [c.name, c]));

  const toApi = (method: string, path: string): ModelApi => {
    const last = path.split('/').filter((s) => s && !s.startsWith(':')).pop() ?? '';
    const candidate = singular(last);
    const entity = [...entitiesByName.keys()].find((n) => n.toLowerCase() === candidate.toLowerCase()) ?? null;
    return { method, path, pattern: apiPattern(path), entity };
  };

  const sessionEndpoint = analysis.apis.find((a) => a.method === 'GET'
    && /(^|\/)(session|me|whoami|current[-_]?user|profile|user\/me)$/i.test(a.path));
  const sessionApi = sessionEndpoint ? toApi('GET', sessionEndpoint.path) : null;

  /* ---- limits per field, preferring the page's own declaration --------- */
  const limitsFor = (field: string, file: string) => {
    const rules = analysis.validations.filter((v) => v.field === field);
    const own = rules.filter((v) => v.file === file);
    const pool = own.length ? [...own, ...rules] : rules;
    const num = (prefixes: string[]) => {
      for (const v of pool) {
        const [key, raw] = v.rule.split(':');
        if (!key || !prefixes.includes(key)) continue;
        const n = Number(String(raw).replace(/[{}]/g, ''));
        if (Number.isFinite(n)) return n;
      }
      return null;
    };
    return {
      min: num(['min', 'minLength']),
      max: num(['max', 'maxLength']),
      email: pool.some((v) => v.rule === 'format:email'),
      required: pool.some((v) => v.rule === 'required'),
      options: (() => {
        const e = pool.find((v) => v.rule.startsWith('enum:'));
        return e ? [...e.rule.matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] ?? m[2] ?? '') : [];
      })(),
    };
  };

  /* ---- pages ------------------------------------------------------------ */
  const pages: ModelPage[] = [];
  for (const route of analysis.routes.filter((r) => r.kind === 'page' || r.kind === 'dynamic')) {
    const own = analysis.components.filter((c) => c.file === route.file);
    if (own.length === 0) continue;
    // Include components the page renders, one level deep.
    const rendered = own.flatMap((c) => c.usesComponents.map((n) => componentsByName.get(n)).filter((x): x is ComponentInfo => Boolean(x)));
    const all = [...own, ...rendered];
    const main = own.find((c) => c.kind === 'page') ?? own[0]!;

    const apis = [...new Set(all.flatMap((c) => c.callsApis))].map((s) => {
      const [method, ...rest] = s.split(' ');
      return toApi(method ?? 'GET', rest.join(' '));
    }).filter((a) => !sessionApi || a.path !== sessionApi.path);
    const readApis = apis.filter((a) => a.method === 'GET');
    const writeApis = apis.filter((a) => a.method !== 'GET');

    const elements = all.flatMap((c) => c.elements);
    const buttons = elements.filter((e) => e.kind === 'button' && e.selector);

    const forms: ModelForm[] = [];
    for (const component of all) {
      for (const form of component.forms) {
        const fields: ModelField[] = form.fields
          .filter((f) => f.selector && !['search', 'hidden', 'submit'].includes(f.inputType ?? ''))
          .map((f) => {
            const limits = limitsFor(f.name, component.file);
            return {
              name: f.name,
              label: f.label ?? f.name,
              inputType: f.inputType ?? 'text',
              selector: f.selector!,
              required: Boolean(f.required) || limits.required,
              email: f.inputType === 'email' || limits.email,
              min: limits.min,
              max: limits.max,
              options: limits.options,
            };
          });
        if (fields.length === 0) continue;

        const formWords = new Set([...words(form.name ?? ''), ...fields.flatMap((f) => words(f.name))]);
        const submit = buttons.find((b) => /submit|save|create|sign-?in|log-?in|continue|send/i.test(b.selector ?? '') && !testIdPrefix(b.selector!))
          ?? buttons.find((b) => /save|create|submit|add|sign in|log in|continue|send/i.test(b.label ?? '') && !testIdPrefix(b.selector!));
        const submitApi = writeApis.find((a) => a.method === 'POST' && a.entity && formWords.has(a.entity.toLowerCase()))
          ?? (writeApis.filter((a) => a.method === 'POST').length === 1 ? writeApis.find((a) => a.method === 'POST')! : null)
          ?? (() => {
            // Forms named after an entity ("new-task-form") write to that entity's POST endpoint.
            const posts = analysis.apis.filter((a) => a.method === 'POST').map((a) => toApi('POST', a.path));
            return posts.find((a) => a.entity && formWords.has(a.entity.toLowerCase())) ?? null;
          })();

        // A lone filter or sort control is not a form anyone submits.
        if (!submit && !fields.some((f) => f.required)) continue;

        const base = (form.name ?? '').replace(/-?form$/, '');
        forms.push({
          name: form.name ?? `${main.name} form`,
          label: (form.name ?? main.name).replace(/-?form$/i, '').replace(/[-_]+/g, ' ').trim() || main.name,
          route: route.path,
          file: component.file,
          fields,
          submitSelector: submit?.selector ?? 'button[type="submit"]',
          submitApi,
          successSelector: base ? `[data-testid="${base}-success"]` : null,
        });
      }
    }

    const permissions = analysis.permissionChecks
      .filter((p) => p.file === route.file)
      .flatMap((p) => [...(p.expression.matchAll(/['"]([a-z_]+:[a-z_]+)['"]/gi))].map((m) => m[1]!));
    const deniedGuard = analysis.permissionChecks
      .filter((p) => p.file === route.file)
      .map((p) => p.guards?.match(/data-testid="([^"]*(forbidden|denied|unauthori[sz]ed)[^"]*)"/i)?.[1])
      .find(Boolean);

    const table = elements.find((e) => e.kind === 'table' && e.selector);
    const search = elements.find((e) => e.kind === 'input' && e.selector && /search|filter|query/i.test(`${e.selector} ${e.label ?? ''}`));
    const routePaths = analysis.routes.map((r) => r.path);
    const links = elements
      .filter((e) => e.kind === 'link' && e.selector && e.label)
      .map((e) => {
        const labelWords = words(e.label!);
        const target = routePaths
          .filter((p) => p !== route.path && !p.includes(':'))
          .map((p) => ({ p, score: words(p).filter((w) => labelWords.some((lw) => singular(lw) === singular(w))).length }))
          .sort((a, b) => b.score - a.score || b.p.length - a.p.length)[0];
        return target && target.score >= Math.min(2, labelWords.length) ? { label: e.label!, selector: e.selector!, target: target.p } : null;
      })
      .filter((l): l is { label: string; selector: string; target: string } => Boolean(l));

    const statusValues = [...new Set(analysis.statusValues.flatMap((s) => s.values))];
    const rowActions: ModelRowAction[] = buttons
      .map((b) => ({ b, prefix: testIdPrefix(b.selector!) }))
      .filter((x): x is { b: typeof buttons[number]; prefix: string } => Boolean(x.prefix))
      .map(({ b, prefix }) => {
        const label = (b.label ?? prefix).replace(/:\w+/g, '').trim();
        const verb = words(label)[0] ?? '';
        const api = /delete|remove/i.test(label)
          ? writeApis.find((a) => a.method === 'DELETE') ?? null
          : writeApis.find((a) => a.method === 'PATCH' || a.method === 'PUT') ?? writeApis.find((a) => a.method !== 'GET') ?? null;
        const stem = verb.slice(0, Math.max(4, verb.length - 2));
        const targetState = statusValues.find((s) => stem.length >= 4 && s.toLowerCase().startsWith(stem)) ?? null;
        return { label, selector: prefix, api, targetState };
      });

    pages.push({
      route: route.path,
      file: route.file,
      component: main.name,
      requiresAuth: Boolean(route.requiresAuth),
      guardedByRoles: route.guardedByRoles,
      permissions: [...new Set(permissions)],
      deniedSelector: deniedGuard ? `[data-testid="${deniedGuard}"]` : null,
      forms,
      readApis,
      writeApis,
      tableSelector: table?.selector ?? null,
      searchSelector: search?.selector ?? null,
      links,
      rowActions,
      contentSelector: forms[0]?.fields[0]?.selector ?? table?.selector ?? links[0]?.selector
        ?? elements.find((e) => e.selector && !testIdPrefix(e.selector))?.selector ?? null,
      hasErrorState: all.some((c) => c.errorStates.length > 0),
      hasEmptyState: all.some((c) => c.emptyStates.length > 0),
    });
  }

  /* ---- roles, sessions and fixtures ------------------------------------- */
  const roles = analysis.roles.map((r) => ({ name: r.name, permissions: r.permissions }));
  const unionValues = (typeName: string): string[] => {
    const inline = [...typeName.matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] ?? m[2] ?? '');
    if (inline.length) return inline;
    const entity = entitiesByName.get(typeName.trim());
    if (entity && entity.fields.every((f) => f.type === 'literal')) return entity.fields.map((f) => f.name);
    const status = analysis.statusValues.find((s) => s.name === typeName.trim());
    return status?.values ?? [];
  };

  const sessionEntity: EntityInfo | undefined = [...entitiesByName.values()].find((e) => /^session$/i.test(e.name))
    ?? [...entitiesByName.values()].find((e) => /session|currentuser|authuser/i.test(e.name));

  const sessionFor = (role: string | null): Record<string, unknown> | null => {
    if (role === null) return null;
    const session: Record<string, unknown> = {};
    const fields = sessionEntity?.fields ?? [{ name: 'id', type: 'string', optional: false }, { name: 'email', type: 'string', optional: false }, { name: 'role', type: 'string', optional: false }];
    for (const f of fields) {
      const n = f.name.toLowerCase();
      if (n === 'role' || n === 'roles') session[f.name] = n === 'roles' ? [role] : role;
      else if (n.includes('email')) session[f.name] = `${role}@qa.example.test`;
      else if (n.endsWith('id')) session[f.name] = `qa-${role}`;
      else if (n.includes('name')) session[f.name] = `QA ${role}`;
      else if (f.type === 'boolean') session[f.name] = true;
      else if (f.type === 'number') session[f.name] = 1;
      else if (/(at|date|expires)$/i.test(f.name)) session[f.name] = '2030-01-01T00:00:00.000Z';
      else if (!f.optional) session[f.name] = `qa-${f.name}`;
    }
    if (!fields.some((f) => /^roles?$/i.test(f.name))) session['role'] = role;
    return session;
  };

  const fieldValue = (entity: string, field: { name: string; type: string; optional: boolean }, index: number, state?: string): unknown => {
    const n = field.name.toLowerCase();
    const t = field.type;
    const nullable = /\bnull\b/.test(t);
    const letter = String.fromCharCode(65 + (index % 26));
    if (n === 'id' || n.endsWith('id') && n.length <= 4) return `qa-${entity.toLowerCase()}-${index + 1}`;
    if (n.endsWith('id')) return nullable ? null : `qa-ref-${index + 1}`;
    if (state !== undefined && /status|state|stage/.test(n)) return state;
    const union = unionValues(t.replace(/\|\s*null/g, '').replace(/\|\s*undefined/g, ''));
    if (union.length) return union[index % union.length];
    if (n.includes('email')) return `qa.${entity.toLowerCase()}${index + 1}@example.test`;
    if (/(title|name|label|subject)$/.test(n)) return `QA ${entity} ${['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'][index % 6]}`;
    if (/(description|body|notes?|comment|summary)$/.test(n)) return `Generated ${entity.toLowerCase()} ${letter} for regression testing.`;
    if (/(at|date|time)$/i.test(field.name)) return nullable ? null : `2026-0${1 + (index % 9)}-15T10:00:00.000Z`;
    if (/\bnumber\b/.test(t)) {
      const limits = limitsFor(field.name, '');
      const lo = limits.min ?? 1;
      const hi = limits.max ?? lo + 10;
      return Math.min(hi, lo + index + 1);
    }
    if (/\bboolean\b/.test(t)) return true;
    if (nullable) return null;
    if (/\bstring\b/.test(t)) return `qa-${field.name}-${index + 1}`;
    return field.optional ? undefined : null;
  };

  const fixturesFor = (entityName: string | null): Record<string, unknown>[] => {
    const entity = entityName ? entitiesByName.get(entityName) : undefined;
    if (!entity) return [{ id: 'qa-1', name: 'QA Record Alpha' }, { id: 'qa-2', name: 'QA Record Bravo' }];
    const statusField = entity.fields.find((f) => /^(status|state|stage)$/i.test(f.name));
    const states = statusField ? unionValues(statusField.type) : [];
    const count = Math.max(2, Math.min(states.length || 2, 6));
    return Array.from({ length: count }, (_, i) => {
      const record: Record<string, unknown> = {};
      for (const f of entity.fields) {
        const v = fieldValue(entity.name, f, i, states[i]);
        if (v !== undefined) record[f.name] = v;
      }
      return record;
    });
  };

  const validValue = (field: ModelField): string => {
    if (field.options.length) return field.options[0]!;
    if (field.inputType === 'select') return '';
    if (field.email) return 'qa.valid@example.test';
    if (field.inputType === 'number') {
      const lo = field.min ?? 1;
      const hi = field.max ?? lo + 10;
      return String(Math.max(lo, Math.min(hi, lo + 1)));
    }
    if (field.inputType === 'password') return 'QaValid#Password123'.slice(0, Math.max(field.min ?? 12, 12));
    const base = 'QA regression value for ' + field.name;
    const len = Math.max(field.min ?? 0, Math.min(base.length, field.max ?? base.length));
    return base.padEnd(len, 'x').slice(0, field.max ?? base.length);
  };

  const byPerms = [...roles].sort((a, b) => b.permissions.length - a.permissions.length);
  const matches = (r: { name: string; permissions: string[] }, q: { permission?: string; roles?: string[] }) =>
    (q.permission ? r.permissions.includes(q.permission) : true) && (q.roles?.length ? q.roles.includes(r.name) : true);

  return {
    pages,
    sessionApi,
    roles,
    sessionFor,
    fixturesFor,
    validValue,
    pageForRoute: (route) => pages.find((p) => p.route === route),
    mostPrivilegedRole: () => byPerms[0]?.name ?? null,
    roleWithout: (q) => [...byPerms].reverse().find((r) => !matches(r, q))?.name ?? null,
    roleWith: (q) => byPerms.find((r) => matches(r, q))?.name ?? null,
  };
}
