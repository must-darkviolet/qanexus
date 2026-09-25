/**
 * Browser exploration layer (spec section 15).
 *
 * Optional by design: Playwright is used to *validate* what static analysis
 * concluded, and any disagreement is recorded as a behaviour discrepancy
 * rather than silently overwriting either source.
 *
 * The generated tests run on Playwright Test (playwright/runner.ts); this
 * module drives the browser directly, to explore pages and - for a pull
 * request - to walk through the affected routes on camera.
 */
import fs from 'node:fs';
import type { StaticAnalysis } from '@qa-agent/shared';
import { env } from '../config/env.js';
import type { Page } from 'playwright';
import { dismissOnboarding } from '../auth/session.js';
import { createLogger } from '../util/logger.js';
import { saveEvidence } from '../knowledge/evidence.js';
import { remember } from '../memory/store.js';
import { loadPlaywright, type PlaywrightLike } from './playwrightLoader.js';
import type { LiveCheckPlan, LocatorSpec } from '../analysis/interactionRecipes.js';

const log = createLogger('explore');

export interface ObservedPage {
  route: string;
  url: string;
  title: string;
  statusCode: number | null;
  loaded: boolean;
  redirectedTo: string | null;
  testIds: string[];
  buttons: { text: string; testId: string | null; disabled: boolean; ariaLabel?: string | null }[];
  /** Visible headings, for grounding assertions about what the page shows. */
  headings?: string[];
  /** Read-only actions tried on the page and the requests each one caused (parameter names only). */
  probes?: { action: string; requests: string[]; opened: string | null }[];
  inputs: { name: string; type: string; required: boolean; testId: string | null }[];
  /** Locator candidates from the interaction recipes, by id: how many elements each matched. */
  locatorResults?: Record<string, { count: number; visible: boolean }>;
  links: { text: string; href: string }[];
  dialogs: number;
  consoleErrors: string[];
  networkRequests: { method: string; url: string; status: number }[];
  visibleErrorText: string[];
  loadTimeMs: number;
  /** Recording of this visit, when the walkthrough was recorded. */
  videoPath: string | null;
  screenshotPath: string | null;
}

export interface Discrepancy {
  route: string;
  kind: 'route_unreachable' | 'missing_element' | 'unexpected_redirect' | 'console_error' | 'auth_mismatch';
  staticExpectation: string;
  runtimeObservation: string;
}

export interface ExplorationResult {
  enabled: boolean;
  reason?: string;
  pages: ObservedPage[];
  discrepancies: Discrepancy[];
}

const DISABLED = (reason: string): ExplorationResult => ({ enabled: false, reason, pages: [], discrepancies: [] });

/**
 * Structural stand-ins for the browser types. The $$eval callbacks are
 * serialized and executed inside Chromium, so the backend does not need
 * lib.dom just to describe them.
 */
interface ElementLike {
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  textContent: string | null;
  tagName: string;
}
interface ConsoleMessageLike { type(): string; text(): string }
interface ResponseLike { request(): { method(): string }; url(): string; status(): number }

export async function exploreApplication(opts: {
  projectId: string;
  runId: string;
  baseUrl: string;
  analysis: StaticAnalysis;
  maxPages?: number;
  commitSha: string;
  /** Visit only these routes (a PR review walks the routes its change affects). */
  routes?: string[];
  /** Run even when BROWSER_EXPLORATION_ENABLED is off - an explicit request. */
  force?: boolean;
  /** Record a video of each visit into this directory. */
  recordVideoDir?: string;
  /** A verified signed-in session (see auth/session.ts): protected pages are visited as that user. */
  storageState?: string;
  /** Words from the changed components (e.g. "history"): a read-only action named with one is tried. */
  probeTerms?: string[];
  /** Locator candidates to count on each route, and dialogs a safe click opens (analysis/interactionRecipes.ts). */
  liveChecks?: LiveCheckPlan[];
}): Promise<ExplorationResult> {
  if (!env.BROWSER_EXPLORATION_ENABLED && !opts.force) {
    return DISABLED('BROWSER_EXPLORATION_ENABLED is not set.');
  }

  let chromium: PlaywrightLike['chromium'];
  try {
    ({ chromium } = await loadPlaywright());
  } catch (e) {
    return DISABLED((e as Error).message);
  }

  const wanted = opts.routes ? new Set(opts.routes) : null;
  const routes = opts.analysis.routes
    .filter((r) => r.kind !== 'api' && !r.path.includes(':') && !r.path.includes('*'))
    .filter((r) => !wanted || wanted.has(r.path))
    .slice(0, opts.maxPages ?? 12);

  if (routes.length === 0) {
    return DISABLED(wanted ? 'None of the affected routes is a static page that can be visited.' : 'No static routes were discovered to explore.');
  }
  const screenshotDir = opts.recordVideoDir ?? `${env.artifactRoot}/${opts.projectId}/screenshots`;
  if (opts.recordVideoDir) fs.mkdirSync(opts.recordVideoDir, { recursive: true });

  const pages: ObservedPage[] = [];
  const discrepancies: Discrepancy[] = [];

  const browser = await chromium.launch({ headless: true });
  try {
    const viewport = { width: 1280, height: 800 };
    const context = await browser.newContext({
      viewport,
      ...(opts.storageState ? { storageState: opts.storageState } : {}),
      ...(opts.recordVideoDir ? { recordVideo: { dir: opts.recordVideoDir, size: viewport } } : {}),
    });

    for (const route of routes) {
      const page = await context.newPage();
      const consoleErrors: string[] = [];
      const networkRequests: { method: string; url: string; status: number }[] = [];

      page.on('console', (msg: ConsoleMessageLike) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300));
      });
      page.on('response', (res: ResponseLike) => {
        networkRequests.push({ method: res.request().method(), url: res.url().slice(0, 300), status: res.status() });
      });

      const target = new URL(route.path, opts.baseUrl).toString();
      const started = Date.now();
      let statusCode: number | null = null;
      let loaded = true;

      try {
        const response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        statusCode = response?.status() ?? null;
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => { /* fine */ });
      } catch (e) {
        loaded = false;
        log.warn(`Could not load ${target}: ${(e as Error).message}`);
      }

      const observed: ObservedPage = {
        route: route.path,
        url: page.url(),
        title: loaded ? await page.title().catch(() => '') : '',
        statusCode,
        loaded,
        redirectedTo: null,
        testIds: [],
        buttons: [],
        inputs: [],
        links: [],
        dialogs: 0,
        consoleErrors,
        networkRequests: networkRequests.slice(0, 50),
        visibleErrorText: [],
        loadTimeMs: Date.now() - started,
        videoPath: null,
        screenshotPath: null,
      };

      if (loaded) {
        // The page as a user sees it once a first-run welcome dialog is closed.
        const dismissed = await dismissOnboarding(page as unknown as Page).catch(() => null);
        if (dismissed) log.info(`Closed the first-run dialog "${dismissed.slice(0, 40)}" on ${route.path}.`);
        const finalPath = new URL(page.url()).pathname;
        if (finalPath !== route.path && finalPath !== `${route.path}/`) observed.redirectedTo = finalPath;

        observed.testIds = await page.$$eval(
          '[data-testid], [data-test-id], [data-cy]',
          (els: ElementLike[]) => els.map((e: ElementLike) => e.getAttribute('data-testid') ?? e.getAttribute('data-test-id') ?? e.getAttribute('data-cy') ?? '').filter(Boolean).slice(0, 200),
        ).catch(() => []);

        observed.buttons = await page.$$eval(
          'button, [role="button"], input[type="submit"]',
          (els: ElementLike[]) => els.slice(0, 60).map((e: ElementLike) => ({
            text: (e.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
            testId: e.getAttribute('data-testid'),
            disabled: Boolean((e as { disabled?: boolean }).disabled),
            ariaLabel: e.getAttribute('aria-label'),
          })),
        ).catch(() => []);

        observed.inputs = await page.$$eval(
          'input, textarea, select',
          (els: ElementLike[]) => els.slice(0, 60).map((e: ElementLike) => ({
            name: e.getAttribute('name') ?? e.getAttribute('id') ?? '',
            type: e.getAttribute('type') ?? e.tagName.toLowerCase(),
            required: e.hasAttribute('required'),
            testId: e.getAttribute('data-testid'),
          })),
        ).catch(() => []);

        observed.links = await page.$$eval(
          'a[href]',
          (els: ElementLike[]) => els.slice(0, 60).map((e: ElementLike) => ({
            text: (e.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
            href: e.getAttribute('href') ?? '',
          })),
        ).catch(() => []);

        observed.headings = await page.$$eval(
          'h1, h2, h3, h4, [role="heading"]',
          (els: ElementLike[]) => els.slice(0, 20).map((e: ElementLike) => (e.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 100)).filter(Boolean),
        ).catch(() => []);

        observed.dialogs = await page.$$eval('[role="dialog"], dialog, .modal', (els: ElementLike[]) => els.length).catch(() => 0);

        observed.visibleErrorText = await page.$$eval(
          '[role="alert"], .error, [data-testid*="error"]',
          (els: ElementLike[]) => els.slice(0, 20).map((e: ElementLike) => (e.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)).filter(Boolean),
        ).catch(() => []);

        const plan = opts.liveChecks?.find((c) => c.route === route.path);
        if (plan) observed.locatorResults = await checkLocators(page as unknown as Page, plan);

        if (opts.probeTerms?.length) observed.probes = await probeActions(page as unknown as Page, opts.probeTerms);

        const shotPath = `${opts.projectId}-explore-${route.path.replace(/[^\w]/g, '_') || 'root'}.png`;
        const fullPath = `${screenshotDir}/${shotPath}`;
        await page.screenshot({ path: fullPath, fullPage: false }).catch(() => { /* non-fatal */ });
        observed.screenshotPath = fullPath;
        await saveEvidence({
          projectId: opts.projectId, runId: opts.runId,
          subjectType: 'exploration', subjectId: route.path,
          kind: 'screenshot', filePath: fullPath,
          metadata: { route: route.path, url: page.url() },
        });
      }

      pages.push(observed);
      const video = page.video();
      await page.close();
      if (video) {
        observed.videoPath = await video.path().catch(() => null);
        if (observed.videoPath) {
          await saveEvidence({
            projectId: opts.projectId, runId: opts.runId,
            subjectType: 'exploration', subjectId: route.path,
            kind: 'video', filePath: observed.videoPath,
            metadata: { route: route.path },
          });
        }
      }

      /* -- compare static expectations with runtime behaviour ------------ */
      if (!loaded) {
        discrepancies.push({
          route: route.path,
          kind: 'route_unreachable',
          staticExpectation: `Static analysis found a route at ${route.path} (${route.file}).`,
          runtimeObservation: `The page did not load at ${target}.`,
        });
        continue;
      }
      if (observed.redirectedTo && !route.requiresAuth) {
        discrepancies.push({
          route: route.path,
          kind: 'unexpected_redirect',
          staticExpectation: `${route.path} has no auth guard in source.`,
          runtimeObservation: `Loading it redirected to ${observed.redirectedTo}.`,
        });
      }
      if (route.requiresAuth && !observed.redirectedTo && observed.visibleErrorText.length === 0) {
        discrepancies.push({
          route: route.path,
          kind: 'auth_mismatch',
          staticExpectation: `${route.file} shows ${route.path} behind an authentication guard.`,
          runtimeObservation: 'The page rendered for an unauthenticated visitor without redirecting.',
        });
      }
      if (observed.consoleErrors.length) {
        discrepancies.push({
          route: route.path,
          kind: 'console_error',
          staticExpectation: 'No console errors expected on a healthy page.',
          runtimeObservation: `${observed.consoleErrors.length} console error(s): ${observed.consoleErrors[0]}`,
        });
      }

      // Selectors the generator would have chosen but which do not exist.
      const staticTestIds = new Set(
        opts.analysis.components
          .filter((c) => c.file === route.file)
          .flatMap((c) => c.elements.map((e) => e.selector ?? ''))
          .map((s) => s.match(/data-testid="([^"]+)"/)?.[1] ?? '')
          .filter(Boolean),
      );
      const runtimeTestIds = new Set(observed.testIds);
      for (const expected of staticTestIds) {
        if (runtimeTestIds.has(expected)) continue;
        discrepancies.push({
          route: route.path,
          kind: 'missing_element',
          staticExpectation: `Source declares data-testid="${expected}" on ${route.path}.`,
          runtimeObservation: 'That test id was not present in the rendered DOM (it may be behind a conditional branch).',
        });
      }
    }
    await context.close();
  } finally {
    await browser.close();
  }

  // Exploration findings are stored as evidence and remembered, so the next
  // run starts knowing what the application really did.
  for (const discrepancy of discrepancies) {
    await remember(opts.projectId, {
      scope: 'application',
      subject: discrepancy.route,
      kind: 'discrepancy',
      summary: `${discrepancy.kind}: ${discrepancy.runtimeObservation}`,
      detail: discrepancy as unknown as Record<string, unknown>,
      keywords: [discrepancy.route, discrepancy.kind],
      confidence: 0.8,
      commitSha: opts.commitSha,
    });
  }

  log.info(`Explored ${pages.length} page(s); found ${discrepancies.length} discrepancy(ies).`);
  return { enabled: true, pages, discrepancies };
}

/** Renders exploration findings for a prompt. */
export function renderExploration(result: ExplorationResult): string {
  if (!result.enabled) return `BROWSER EXPLORATION: not performed (${result.reason}).`;
  const lines: string[] = [`BROWSER EXPLORATION: ${result.pages.length} page(s) visited.`];
  for (const page of result.pages) {
    lines.push(
      `  ${page.route} -> ${page.loaded ? `loaded in ${page.loadTimeMs}ms` : 'FAILED TO LOAD'}` +
      `${page.redirectedTo ? ` (redirected to ${page.redirectedTo})` : ''}` +
      ` testIds=[${page.testIds.slice(0, 10).join(', ')}]` +
      ` buttons=[${page.buttons.slice(0, 6).map((b) => b.text).filter(Boolean).join(', ')}]`,
    );
  }
  if (result.discrepancies.length) {
    lines.push('', 'DISCREPANCIES BETWEEN STATIC ANALYSIS AND RUNTIME BEHAVIOUR:');
    for (const d of result.discrepancies.slice(0, 25)) {
      lines.push(`  [${d.kind}] ${d.route}\n      static: ${d.staticExpectation}\n      runtime: ${d.runtimeObservation}`);
    }
  }
  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/* Action probing                                                              */
/* -------------------------------------------------------------------------- */

/** Only actions that read: never one that changes data. */
const READ_ONLY = /\b(view|history|details?|open|show|expand|preview|info)\b/i;
const CHANGES_DATA = /\b(reset|delete|remove|approve|reject|save|submit|update|confirm|send|download|upload|create|add|edit|toggle|apply|clear)\b/i;

/**
 * Tries one read-only action related to the change ("View History" for a
 * change to EducationHistoryDialog) and records which requests it causes, so
 * a network test can observe the real request signature. Query values are
 * dropped - only parameter names are kept (they can hold personal data).
 */
/** The Playwright locator a candidate describes. */
function locate(page: Page, l: LocatorSpec) {
  const base = l.inDialog ? page.getByRole('dialog').last() : page;
  if (l.role) return base.getByRole(l.role as Parameters<Page['getByRole']>[0], l.name ? { name: l.name, exact: true } : {});
  if (l.label) return base.getByLabel(l.label, { exact: true });
  if (l.text) return base.getByText(l.text, { exact: true });
  return base.locator(l.css ?? '');
}

async function countOf(page: Page, l: LocatorSpec): Promise<{ count: number; visible: boolean }> {
  try {
    const loc = locate(page, l);
    const count = await loc.count();
    return { count, visible: count > 0 && await loc.first().isVisible() };
  } catch {
    return { count: 0, visible: false };
  }
}

/**
 * Counts each recipe candidate on the page. For a dialog whose opener does
 * nothing but open it, clicks the opener (the first candidate that matches
 * exactly one visible element), counts the dialog's candidates, and closes it
 * with Escape - nothing is submitted.
 */
async function checkLocators(page: Page, plan: LiveCheckPlan): Promise<Record<string, { count: number; visible: boolean }>> {
  const out: Record<string, { count: number; visible: boolean }> = {};
  for (const c of plan.page) out[c.id] = await countOf(page, c);
  for (const d of plan.dialogs) {
    const opener = d.openWith.find((c) => out[c.id]?.count === 1 && out[c.id]?.visible);
    if (!opener) continue;
    try {
      await locate(page, opener).click({ timeout: 5000 });
      await page.getByRole('dialog').last().waitFor({ state: 'visible', timeout: 5000 });
      for (const c of d.inDialog) out[c.id] = await countOf(page, c);
    } catch (e) {
      log.warn(`Could not open the dialog with ${opener.code}: ${(e as Error).message.split('\n')[0]}`);
    } finally {
      await page.keyboard.press('Escape').catch(() => { /* already closed */ });
      await page.getByRole('dialog').last().waitFor({ state: 'hidden', timeout: 3000 }).catch(() => { /* a dialog Escape does not close */ });
    }
  }
  const checked = Object.values(out);
  log.info(`Checked ${checked.length} recipe locator(s) on ${plan.route}: ${checked.filter((r) => r.count === 1 && r.visible).length} match exactly one visible element.`);
  return out;
}

async function probeActions(page: Page, terms: string[]): Promise<{ action: string; requests: string[]; opened: string | null }[]> {
  const wanted = terms.map((t) => t.toLowerCase()).filter((t) => t.length >= 4);
  if (!wanted.length) return [];
  // Rows (and their row actions) often render only once a slow list request returns.
  await dismissOnboarding(page, 2000).catch(() => null);
  const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const candidate = page.getByRole('button', { name: new RegExp(wanted.map(escape).join('|'), 'i') })
    .filter({ hasText: READ_ONLY }).first();
  await candidate.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
  if (!(await candidate.isVisible().catch(() => false))) return [];
  const name = ((await candidate.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
  if (!name || CHANGES_DATA.test(name)) return [];
  const target = { name, locator: candidate };

  const requests: string[] = [];
  const onRequest = (req: { url(): string; method(): string; resourceType(): string }) => {
    if (!['xhr', 'fetch'].includes(req.resourceType())) return;
    try {
      const u = new URL(req.url());
      const params = [...u.searchParams.keys()];
      requests.push(`${req.method()} ${u.host}${u.pathname}${params.length ? ` ?${params.join('&')}` : ''}`);
    } catch { /* not a URL */ }
  };
  page.on('request', onRequest);
  let opened: string | null = null;
  try {
    await target.locator.click({ timeout: 5000 });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    opened = await page.locator('[role="dialog"] h1, [role="dialog"] h2, [role="dialog"] h3, [role="dialog"] h4, [role="dialog"] h5, [role="dialog"] h6').first()
      .textContent({ timeout: 1000 }).catch(() => null);
    // Leave the page as it was: close what the action opened.
    await page.keyboard.press('Escape').catch(() => {});
    const close = page.locator('[role="dialog"] button:has(svg[data-testid*="Close"]), [role="dialog"] button[aria-label*="close" i]').first();
    if (await close.isVisible().catch(() => false)) await close.click({ timeout: 3000 }).catch(() => {});
  } catch (e) {
    log.debug(`Probe of "${target.name}" failed: ${(e as Error).message}`);
  } finally {
    page.off('request', onRequest);
  }
  log.info(`Probed "${target.name}": ${requests.length} request(s)${opened ? `, opened "${opened.trim().slice(0, 40)}"` : ''}.`);
  return [{ action: `click button "${target.name}" (first match)`, requests: [...new Set(requests)].slice(0, 20), opened: opened?.trim().slice(0, 80) ?? null }];
}
