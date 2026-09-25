/**
 * Deterministic test synthesis.
 *
 * Turns a scenario into an executable Playwright test body using the application
 * model: real selectors, real limits, real endpoints and fixture data derived
 * from the application's own types. It needs no AI, and it never produces an
 * assertion-free test: a scenario it cannot implement faithfully comes back
 * with a reason, and the caller emits it as pending.
 *
 * Test shape (per spec requirements):
 *   - no waitForTimeout(<ms>), no { force: true }
 *   - bodies run inside `async ({ page, qa }) => { ... }`, with `expect` in scope
 *   - the API is stubbed only when TEST_MOCK_API is on; data-dependent tests
 *     skip themselves against a real backend rather than asserting on data
 *     they did not create
 */
import type { AppModel, ModelApi, ModelField, ModelForm, ModelPage, ModelRowAction } from './appModel.js';

export interface ScenarioLike {
  id: string;
  title: string;
  category: string;
  steps: string[];
  expectedResult: string;
  role?: string;
}

export type Synthesized =
  | { ok: true; body: string; tags: string[] }
  | { ok: false; reason: string };

const q = (value: unknown) => JSON.stringify(value);

const MOCK_ONLY = [
  "// Depends on stubbed API data; skipped when running against a real backend (TEST_MOCK_API=0).",
  "test.skip(!qa.mockApi, 'Depends on stubbed API data (TEST_MOCK_API=0).');",
];

const visible = (selector: string) => `await expect(page.locator(${q(selector)}).first()).toBeVisible();`;
const absent = (selector: string) => `await expect(page.locator(${q(selector)})).toHaveCount(0);`;
const click = (selector: string) => `await page.locator(${q(selector)}).first().click();`;
const contains = (selector: string, text: string) => `await expect(page.locator(${q(selector)}).first()).toContainText(${q(text)});`;

/* -------------------------------------------------------------------------- */
/* Building blocks                                                             */
/* -------------------------------------------------------------------------- */

function roleFor(model: AppModel, page: ModelPage): string | null {
  if (page.permissions.length) return model.roleWith({ permission: page.permissions[0] }) ?? model.mostPrivilegedRole();
  if (page.guardedByRoles.length) return model.roleWith({ roles: page.guardedByRoles }) ?? model.mostPrivilegedRole();
  return model.mostPrivilegedRole();
}

function concreteRoute(model: AppModel, page: ModelPage): string {
  if (!page.route.includes(':')) return page.route;
  const entity = page.readApis.find((a) => a.entity)?.entity ?? null;
  const id = String(model.fixturesFor(entity)[0]?.['id'] ?? 'qa-1');
  return page.route.replace(/:[A-Za-z_]\w*\*?/g, id);
}

interface SetupOptions {
  role: string | null | 'anonymous';
  /** Override the response for the page's read APIs. */
  reads?: { statusCode?: number; body?: unknown } | 'fixtures';
  extra?: string[];
}

function setup(model: AppModel, page: ModelPage, opts: SetupOptions): string[] {
  const lines: string[] = [];
  const role = opts.role === 'anonymous' ? null : opts.role;
  if (model.sessionApi || page.requiresAuth) {
    lines.push(`await qa.session(${q(model.sessionApi?.path ?? null)}, ${q(model.sessionFor(role))}, ${q(role ?? '')});`);
  }
  page.readApis.forEach((api, i) => {
    const response = opts.reads && opts.reads !== 'fixtures'
      ? opts.reads
      : { statusCode: 200, body: model.fixturesFor(api.entity) };
    lines.push(`await qa.stub('GET', ${q(api.pattern)}, ${q(response)}, 'qaRead${i}');`);
  });
  lines.push(...(opts.extra ?? []));
  lines.push(`await page.goto(${q(concreteRoute(model, page))});`);
  return lines;
}

function fillForm(model: AppModel, form: ModelForm, overrides: Record<string, string>): string[] {
  return form.fields.map((f) => {
    const value = f.name in overrides ? overrides[f.name]! : model.validValue(f);
    return `await qa.fill(${q(f.selector)}, ${q(value)});`;
  });
}

function submitStub(form: ModelForm, model: AppModel, response?: { statusCode: number; body: unknown }): string[] {
  if (!form.submitApi) return [];
  const body = response ?? { statusCode: 201, body: model.fixturesFor(form.submitApi.entity)[0] ?? {} };
  return [`await qa.stub(${q(form.submitApi.method)}, ${q(form.submitApi.pattern)}, ${q(body)}, 'qaSubmit');`];
}

/** Finds the form (and its page) that owns a field, preferring the feature's pages. */
function findField(model: AppModel, fieldName: string, routes: string[]) {
  const candidates = model.pages
    .flatMap((page) => page.forms.map((form) => ({ page, form, field: form.fields.find((f) => f.name === fieldName) })))
    .filter((c): c is { page: ModelPage; form: ModelForm; field: ModelField } => Boolean(c.field));
  return candidates.find((c) => routes.includes(c.page.route)) ?? candidates[0];
}

function findFormByLabel(model: AppModel, label: string, routes: string[]) {
  const all = model.pages.flatMap((page) => page.forms.map((form) => ({ page, form })));
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return all.find((c) => norm(c.form.label) === norm(label) && routes.includes(c.page.route))
    ?? all.find((c) => norm(c.form.label) === norm(label))
    ?? all.find((c) => routes.includes(c.page.route));
}

function displayValue(record: Record<string, unknown>): string | null {
  for (const key of ['title', 'name', 'fullName', 'label', 'subject', 'email']) {
    if (typeof record[key] === 'string') return record[key] as string;
  }
  const first = Object.entries(record).find(([k, v]) => typeof v === 'string' && !/id$/i.test(k));
  return first ? String(first[1]) : null;
}

const test = (lines: string[], tags: string[]): Synthesized => ({ ok: true, body: lines.join('\n'), tags });

/* -------------------------------------------------------------------------- */
/* Templates                                                                   */
/* -------------------------------------------------------------------------- */

function navigation(model: AppModel, page: ModelPage): Synthesized {
  const role = page.requiresAuth ? roleFor(model, page) : 'anonymous';
  return test([
    ...(page.readApis.length ? MOCK_ONLY : []),
    ...setup(model, page, { role: role ?? 'anonymous' }),
    `await qa.expectPath(${q(concreteRoute(model, page))});`,
    page.contentSelector
      ? visible(page.contentSelector)
      : `await expect(page.locator('body')).not.toBeEmpty();`,
  ], ['navigation']);
}

function formTest(
  model: AppModel, page: ModelPage, form: ModelForm, field: ModelField,
  value: string, expect: 'rejected' | 'accepted' | 'max',
): Synthesized {
  const lines = [
    ...(expect === 'accepted' && form.submitApi ? MOCK_ONLY : []),
    ...setup(model, page, { role: roleFor(model, page) ?? 'anonymous', extra: submitStub(form, model) }),
    ...fillForm(model, form, { [field.name]: value }),
  ];
  if (expect === 'max') {
    lines.push(`await qa.expectMaxEnforced(${q(field.selector)}, ${field.max}, ${q(form.submitSelector)});`);
    if (form.submitApi) lines.push(`await qa.expectNotCalled('qaSubmit');`);
    return test(lines, ['boundary']);
  }
  lines.push(click(form.submitSelector));
  if (expect === 'rejected') {
    lines.push(`await qa.expectRejected(${q(field.selector)});`);
    if (form.submitApi) lines.push(`await qa.expectNotCalled('qaSubmit');`);
  } else if (form.submitApi) {
    // The request going out is the proof the form accepted the value; after a
    // successful submit the page may navigate away or replace the form.
    lines.push(`expect((await qa.waitFor('qaSubmit')).method).toBe(${q(form.submitApi.method)});`);
  } else {
    lines.push(`await qa.expectAccepted(${q(field.selector)});`);
  }
  return test(lines, [expect === 'rejected' ? 'negative' : 'positive']);
}

function validSubmission(model: AppModel, page: ModelPage, form: ModelForm): Synthesized {
  if (!form.submitApi) return { ok: false, reason: `No API could be identified for the "${form.label}" form, so a successful submission cannot be observed.` };
  const probe = form.fields.find((f) => !['select', 'number', 'password'].includes(f.inputType));
  return test([
    ...MOCK_ONLY,
    ...setup(model, page, { role: roleFor(model, page) ?? 'anonymous', extra: submitStub(form, model) }),
    ...fillForm(model, form, {}),
    click(form.submitSelector),
    probe
      ? `const submitted = await qa.waitFor('qaSubmit');\nexpect(JSON.stringify(submitted.body), 'the submitted payload carries the entered values').toContain(${q(model.validValue(probe))});`
      : `expect((await qa.waitFor('qaSubmit')).method).toBe(${q(form.submitApi.method)});`,
    `await qa.expectNoAlert();`,
  ], ['functional', 'happy-path']);
}

function submitFailure(model: AppModel, page: ModelPage, form: ModelForm, statusCode: number): Synthesized {
  if (!form.submitApi) return { ok: false, reason: `No API could be identified for the "${form.label}" form.` };
  return test([
    ...MOCK_ONLY,
    ...setup(model, page, {
      role: roleFor(model, page) ?? 'anonymous',
      extra: submitStub(form, model, { statusCode, body: { message: `Simulated ${statusCode} from the QA suite` } }),
    }),
    ...fillForm(model, form, {}),
    click(form.submitSelector),
    `await qa.waitFor('qaSubmit');`,
    `await qa.expectErrorShown();`,
  ], ['error_handling']);
}

function unauthenticated(model: AppModel, page: ModelPage): Synthesized {
  return test([
    ...setup(model, page, { role: 'anonymous' }),
    `await qa.expectAccessDenied(${q(concreteRoute(model, page))}${page.contentSelector ? `, ${q(page.contentSelector)}` : ''});`,
  ], ['authorization']);
}

function roleDenied(model: AppModel, page: ModelPage, role: string): Synthesized {
  const lines = [...setup(model, page, { role })];
  if (page.deniedSelector) lines.push(visible(page.deniedSelector));
  lines.push(`await qa.expectAccessDenied(${q(concreteRoute(model, page))}${page.contentSelector ? `, ${q(page.contentSelector)}` : ''});`);
  return test(lines, ['authorization', 'negative']);
}

function roleAllowed(model: AppModel, page: ModelPage, role: string): Synthesized {
  return test([
    ...(page.readApis.length ? MOCK_ONLY : []),
    ...setup(model, page, { role }),
    ...(page.deniedSelector ? [absent(page.deniedSelector)] : []),
    page.contentSelector
      ? visible(page.contentSelector)
      : `await qa.expectPath(${q(concreteRoute(model, page))});`,
  ], ['authorization', 'positive']);
}

function readFailure(model: AppModel, page: ModelPage, statusCode: number): Synthesized {
  if (page.readApis.length === 0) return { ok: false, reason: `${page.route} loads no data from an API, so there is no request to fail.` };
  return test([
    ...MOCK_ONLY,
    ...setup(model, page, { role: roleFor(model, page) ?? 'anonymous', reads: { statusCode, body: { message: `Simulated ${statusCode}` } } }),
    `await qa.waitFor('qaRead0');`,
    `await qa.expectErrorShown();`,
  ], ['error_handling']);
}

function emptyState(model: AppModel, page: ModelPage): Synthesized {
  if (page.readApis.length === 0) return { ok: false, reason: `${page.route} loads no list from an API.` };
  return test([
    ...MOCK_ONLY,
    ...setup(model, page, { role: roleFor(model, page) ?? 'anonymous', reads: { statusCode: 200, body: [] } }),
    `await qa.waitFor('qaRead0');`,
    `await qa.expectEmptyState();`,
    ...(page.tableSelector ? [absent(page.tableSelector)] : []),
  ], ['ui_behavior']);
}

function listDisplay(model: AppModel, page: ModelPage): Synthesized {
  // The alias is the index of *this* endpoint: a page may read several, and
  // waiting on the wrong one would synchronise on an unrelated request.
  const index = page.readApis.findIndex((a) => a.entity);
  const api = page.readApis[index];
  if (!api) return { ok: false, reason: `No typed list endpoint was found for ${page.route}.` };
  if (!page.tableSelector) return { ok: false, reason: `${page.route} reads ${api.entity} data but renders no list or table of it, so there is no row to check.` };
  const values = model.fixturesFor(api.entity).map(displayValue).filter((v): v is string => Boolean(v)).slice(0, 3);
  if (!values.length) return { ok: false, reason: 'The entity has no displayable text field.' };
  const container = page.tableSelector ?? 'body';
  return test([
    ...MOCK_ONLY,
    ...setup(model, page, { role: roleFor(model, page) ?? 'anonymous' }),
    `await qa.waitFor('qaRead${index}');`,
    ...values.map((v) => contains(container, v)),
  ], ['functional']);
}

function search(model: AppModel, page: ModelPage): Synthesized {
  const index = page.readApis.findIndex((a) => a.entity);
  const api = page.readApis[index];
  if (!page.searchSelector || !api) return { ok: false, reason: 'No search input with a typed list was found.' };
  const values = model.fixturesFor(api.entity).map(displayValue).filter((v): v is string => Boolean(v));
  if (values.length < 2) return { ok: false, reason: 'At least two records are needed to show filtering.' };
  const container = page.tableSelector ?? 'body';
  return test([
    ...MOCK_ONLY,
    ...setup(model, page, { role: roleFor(model, page) ?? 'anonymous' }),
    `await qa.waitFor('qaRead${index}');`,
    `await qa.fill(${q(page.searchSelector)}, ${q(values[0])});`,
    contains(container, values[0]!),
    `await expect(page.locator(${q(container)}).first()).not.toContainText(${q(values[1])});`,
    `await qa.fill(${q(page.searchSelector)}, '');`,
    contains(container, values[1]!),
  ], ['ui_behavior']);
}

function linkNavigation(model: AppModel, page: ModelPage, link: { label: string; selector: string; target: string }): Synthesized {
  const targetPage = model.pageForRoute(link.target);
  const extra = targetPage?.readApis.map((a, i) => `await qa.stub('GET', ${q(a.pattern)}, ${q({ statusCode: 200, body: model.fixturesFor(a.entity) })}, 'qaTarget${i}');`) ?? [];
  return test([
    ...MOCK_ONLY,
    ...setup(model, page, { role: roleFor(model, page) ?? 'anonymous', extra }),
    click(link.selector),
    `await qa.expectPath(${q(link.target)});`,
  ], ['ui_behavior', 'navigation']);
}

function rowAction(model: AppModel, page: ModelPage, action: ModelRowAction): Synthesized {
  if (!action.api) return { ok: false, reason: `No API could be linked to the "${action.label}" action.` };
  const entity = page.readApis.find((a) => a.entity)?.entity ?? action.api.entity;
  const record = model.fixturesFor(entity)[0] ?? {};
  const response = { statusCode: 200, body: action.targetState ? { ...record, status: action.targetState } : record };
  const lines = [
    ...MOCK_ONLY,
    ...setup(model, page, {
      role: model.mostPrivilegedRole() ?? 'anonymous',
      extra: [`await qa.stub(${q(action.api.method)}, ${q(action.api.pattern)}, ${q(response)}, 'qaAction');`],
    }),
    // Only wait for the list request when the page actually makes one; a
    // server-rendered list has row actions but no read API to wait for.
    ...(page.readApis.length ? [`await qa.waitFor('qaRead0');`] : []),
    click(action.selector),
  ];
  if (action.targetState) {
    lines.push(`const sent = await qa.waitFor('qaAction');\nexpect(JSON.stringify(sent.body ?? {}), ${q(`the request moves the record to "${action.targetState}"`)}).toContain(${q(action.targetState)});`);
  } else {
    lines.push(`expect((await qa.waitFor('qaAction')).method).toBe(${q(action.api.method)});`);
  }
  return test(lines, ['state_transition']);
}

function actionFailure(model: AppModel, page: ModelPage, action: ModelRowAction, statusCode: number): Synthesized {
  if (!action.api) return { ok: false, reason: `No API could be linked to the "${action.label}" action.` };
  return test([
    ...MOCK_ONLY,
    ...setup(model, page, {
      role: model.mostPrivilegedRole() ?? 'anonymous',
      extra: [`await qa.stub(${q(action.api.method)}, ${q(action.api.pattern)}, ${q({ statusCode, body: { message: `Simulated ${statusCode}` } })}, 'qaAction');`],
    }),
    ...(page.readApis.length ? [`await qa.waitFor('qaRead0');`] : []),
    click(action.selector),
    `await qa.waitFor('qaAction');`,
    `await qa.expectErrorShown();`,
  ], ['error_handling']);
}

/* -------------------------------------------------------------------------- */
/* Dispatch                                                                    */
/* -------------------------------------------------------------------------- */

export function synthesizeTest(model: AppModel, scenario: ScenarioLike, featureRoutes: string[]): Synthesized {
  const t = scenario.title.trim();
  const featurePages = model.pages.filter((p) => featureRoutes.includes(p.route));
  const pageByRoute = (route: string) => model.pageForRoute(route) ?? model.pages.find((p) => p.route === route.replace(/\/$/, ''));
  let m: RegExpMatchArray | null;

  if ((m = t.match(/^navigate to (\S+)/i))) {
    const page = pageByRoute(m[1]!);
    return page ? navigation(model, page) : { ok: false, reason: `Route ${m[1]} has no page component.` };
  }

  if ((m = t.match(/submitting with "(.+?)" empty is rejected/i))) {
    const hit = findField(model, m[1]!, featureRoutes);
    return hit ? formTest(model, hit.page, hit.form, hit.field, '', 'rejected') : { ok: false, reason: `No form field "${m[1]}" was found.` };
  }
  if ((m = t.match(/"(.+?)" (below|at|above) its (minimum|maximum) of (-?\d+)(?: is (rejected|accepted))?/i))) {
    const hit = findField(model, m[1]!, featureRoutes);
    if (!hit) return { ok: false, reason: `No form field "${m[1]}" was found.` };
    const limit = Number(m[4]);
    const declared = /minimum/i.test(m[3]!) ? hit.field.min : hit.field.max;
    if (declared !== null && declared !== limit) {
      return { ok: false, reason: `Outdated scenario: the code now declares a ${m[3]!.toLowerCase()} of ${declared} for "${m[1]}", not ${limit}. The current limit is covered by a newer scenario.` };
    }
    const numeric = hit.field.inputType === 'number';
    const make = (n: number) => (numeric ? String(n) : 'Q'.repeat(Math.max(0, n)));
    const where = m[2]!.toLowerCase();
    if (where === 'below') return formTest(model, hit.page, hit.form, hit.field, make(limit - 1), 'rejected');
    if (where === 'above') {
      return numeric
        ? formTest(model, hit.page, hit.form, hit.field, make(limit + 1), 'rejected')
        : formTest(model, hit.page, hit.form, { ...hit.field, max: limit }, make(limit + 1), 'max');
    }
    return formTest(model, hit.page, hit.form, hit.field, make(limit), 'accepted');
  }
  if ((m = t.match(/"(.+?)" rejects a malformed email/i))) {
    const hit = findField(model, m[1]!, featureRoutes);
    return hit ? formTest(model, hit.page, hit.form, hit.field, 'not-an-email', 'rejected') : { ok: false, reason: `No form field "${m[1]}" was found.` };
  }
  if ((m = t.match(/^valid (.+?) submission is accepted/i))) {
    const hit = findFormByLabel(model, m[1]!, featureRoutes);
    return hit ? validSubmission(model, hit.page, hit.form) : { ok: false, reason: `No "${m[1]}" form was found.` };
  }
  if ((m = t.match(/^server error \((\d{3})\) while submitting (.+?) is shown/i))) {
    const hit = findFormByLabel(model, m[2]!, featureRoutes);
    return hit ? submitFailure(model, hit.page, hit.form, Number(m[1])) : { ok: false, reason: `No "${m[2]}" form was found.` };
  }
  if ((m = t.match(/unauthenticated access to (\S+) is blocked/i))) {
    const page = pageByRoute(m[1]!);
    return page ? unauthenticated(model, page) : { ok: false, reason: `Route ${m[1]} has no page component.` };
  }
  if ((m = t.match(/a "(.+?)" user is refused on (\S+)/i))) {
    const page = pageByRoute(m[2]!);
    return page ? roleDenied(model, page, m[1]!) : { ok: false, reason: `Route ${m[2]} has no page component.` };
  }
  if ((m = t.match(/a "(.+?)" user can use (\S+)/i))) {
    const page = pageByRoute(m[2]!);
    return page ? roleAllowed(model, page, m[1]!) : { ok: false, reason: `Route ${m[2]} has no page component.` };
  }
  if ((m = t.match(/without the "(.+?)" (role|permission) cannot (?:access|use) (\S+)/i))) {
    const page = pageByRoute(m[3]!);
    if (!page) return { ok: false, reason: `Route ${m[3]} has no page component.` };
    if (m[2] === 'role' && !page.deniedSelector && page.permissions.length === 0) {
      return { ok: false, reason: `The "${m[1]}" check found on ${page.route} guards an element, not the page, so page-level denial cannot be asserted from the code. Verify manually which content a non-"${m[1]}" user should see.` };
    }
    const role = m[2] === 'permission' ? model.roleWithout({ permission: m[1] }) : model.roleWithout({ roles: [m[1]!] });
    return role ? roleDenied(model, page, role) : { ok: false, reason: `Every known role holds "${m[1]}", so no role can demonstrate the refusal.` };
  }
  if ((m = t.match(/^(\w+) shows an error state when its request fails/i))) {
    const page = model.pages.find((p) => p.component === m![1]) ?? featurePages.find((p) => p.readApis.length);
    return page ? readFailure(model, page, 500) : { ok: false, reason: `Component ${m[1]} is not a routed page.` };
  }
  if ((m = t.match(/^(\w+) shows an empty state/i))) {
    const page = model.pages.find((p) => p.component === m![1]) ?? featurePages.find((p) => p.readApis.length);
    return page ? emptyState(model, page) : { ok: false, reason: `Component ${m[1]} is not a routed page.` };
  }
  if ((m = t.match(/^(\S+) lists the (\w+) records returned by the api/i))) {
    const page = pageByRoute(m[1]!);
    return page ? listDisplay(model, page) : { ok: false, reason: `Route ${m[1]} has no page component.` };
  }
  if ((m = t.match(/^searching (\S+) filters the list/i))) {
    const page = pageByRoute(m[1]!);
    return page ? search(model, page) : { ok: false, reason: `Route ${m[1]} has no page component.` };
  }
  if ((m = t.match(/^"(.+?)" link on (\S+) opens (\S+)/i))) {
    const page = pageByRoute(m[2]!);
    const link = page?.links.find((l) => l.label === m![1] && l.target === m![3]);
    return page && link ? linkNavigation(model, page, link) : { ok: false, reason: `Link "${m[1]}" was not found.` };
  }
  if ((m = t.match(/^"(.+?)" on a (\w+) row (?:in|on) (\S+) sends the request/i))) {
    const page = pageByRoute(m[3]!);
    const action = page?.rowActions.find((a) => a.label === m![1]);
    return page && action ? rowAction(model, page, action) : { ok: false, reason: `Action "${m[1]}" was not found.` };
  }
  if ((m = t.match(/^"(.+?)" on (\S+) failing with (\d{3}) is shown/i))) {
    const page = pageByRoute(m[2]!);
    const action = page?.rowActions.find((a) => a.label === m![1]);
    return page && action ? actionFailure(model, page, action, Number(m[3])) : { ok: false, reason: `Action "${m[1]}" was not found.` };
  }
  if ((m = t.match(/^(GET|POST|PUT|PATCH|DELETE) (\S+) returning (\d{3}) is handled/i))) {
    const [, method, path, code] = m;
    const page = [...featurePages, ...model.pages].find((p) => p.readApis.some((a) => a.method === method && a.path === path));
    if (page) return readFailure(model, page, Number(code));
    const form = model.pages.flatMap((p) => p.forms.map((f) => ({ p, f }))).find((x) => x.f.submitApi?.path === path && x.f.submitApi?.method === method);
    if (form) return submitFailure(model, form.p, form.f, Number(code));
    const action = model.pages.flatMap((p) => p.rowActions.map((a) => ({ p, a }))).find((x) => x.a.api?.path === path && x.a.api?.method === method);
    if (action) return actionFailure(model, action.p, action.a, Number(code));
    return { ok: false, reason: `No page was found that calls ${method} ${path}.` };
  }
  if ((m = t.match(/^(\w+): (\w+) -> (\w+)$/))) {
    const target = m[3]!;
    const hit = model.pages.flatMap((p) => p.rowActions.map((a) => ({ p, a }))).find((x) => x.a.targetState === target);
    return hit ? rowAction(model, hit.p, hit.a) : { ok: false, reason: `No UI action that moves ${m[1]} to "${target}" was found.` };
  }

  // Loosely phrased validation scenarios (typically AI-authored): a quoted
  // field that exists in a form is still testable as a rejection.
  if (/validation|negative|boundary/i.test(scenario.category)) {
    const quoted = t.match(/"([^"]+)"/)?.[1];
    const hit = quoted ? findField(model, quoted, featureRoutes) : undefined;
    if (hit && /empty|blank|missing|required/i.test(`${t} ${scenario.steps.join(' ')}`)) {
      return formTest(model, hit.page, hit.form, hit.field, '', 'rejected');
    }
    if (hit && hit.field.email && /email|format|malformed|invalid/i.test(t)) {
      return formTest(model, hit.page, hit.form, hit.field, 'not-an-email', 'rejected');
    }
  }

  return { ok: false, reason: 'No deterministic template matches this scenario; it needs AI-assisted generation or a manual implementation.' };
}

export type { ModelApi };
