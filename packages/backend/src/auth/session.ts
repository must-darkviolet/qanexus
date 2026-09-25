/**
 * Authentication: the one place a review establishes (or fails to establish)
 * a signed-in session, and the single source of truth for everything that
 * later opens the application - the walkthrough and the generated tests both
 * run on the Playwright storage state saved here.
 *
 *   1. Are the affected routes protected? Open them signed out: landing on a
 *      login page (or a page asking for a password) means yes.
 *   2. Reuse a saved session when there is one and it still opens the route.
 *   3. Otherwise sign in through the application's own login form with the
 *      configured test account.
 *   4. Verify: the login must actually leave the login page, and the protected
 *      route must then open without being sent back to it.
 *
 * Every step has its own timeout, and an outcome says which step failed:
 *
 *   NOT_REQUIRED                 the affected routes open signed out
 *   VERIFIED                     signed in and the protected route opened
 *   AUTHENTICATION_REQUIRED      protected, but no credentials or saved session
 *   AUTHENTICATION_FAILED        the login was rejected, blocked (CAPTCHA) or timed out
 *   AUTHENTICATED_ACCESS_FAILED  signed in, yet the route still sends us to the login
 *
 * A CAPTCHA is reported, never bypassed. A person can sign in once with
 * `qa auth <project>`, and the saved session is reused until it expires.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { env } from '../config/env.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('AUTH');

export type AuthState =
  | 'NOT_REQUIRED' | 'VERIFIED'
  | 'AUTHENTICATION_REQUIRED' | 'AUTHENTICATION_FAILED' | 'AUTHENTICATED_ACCESS_FAILED';

export interface AuthCheck {
  state: AuthState;
  /** Affected routes that sent a signed-out visitor to the login page. */
  protectedRoutes: string[];
  /** Affected routes that opened signed out. */
  publicRoutes: string[];
  /** Where the application asks visitors to sign in, as observed. */
  loginPath: string | null;
  loginAttempted: boolean;
  /** How the session was obtained, when it was. */
  source: 'saved-session' | 'login-form' | null;
  role: string;
  /** Human-readable account of what happened; never contains a credential. */
  reason: string;
  /** Playwright storage state of the verified session, for the walkthrough and the tests. */
  storageStatePath: string | null;
  /** What the browser showed when authentication failed. */
  evidence: { screenshot: string | null; url: string | null };
  durationMs: number;
}

export interface AuthOptions {
  baseUrl: string;
  /** Affected routes to check, e.g. ["/education-management"]. Dynamic segments are skipped. */
  routes: string[];
  credentials: { email?: string; password?: string };
  role?: string;
  /** Login path when the application does not redirect to one on its own. */
  loginPath?: string;
  /** Where a verified session is saved and looked for. */
  statePath: string;
  /** Where failure screenshots go. */
  evidenceDir: string;
  timeouts?: Partial<AuthTimeouts>;
  signal?: AbortSignal;
  /** Test seam: the browser to use instead of launching Chromium. */
  browser?: Browser;
  /** How the project is named in the command a person can run to unblock it. */
  projectRef?: string;
}

export interface AuthTimeouts {
  /** One navigation, including client-side redirects settling. */
  navigationMs: number;
  /** From submitting the login form to leaving the login page (or showing why not). */
  loginMs: number;
}

const DEFAULT_TIMEOUTS: AuthTimeouts = { navigationMs: 30_000, loginMs: 30_000 };

const firstLine = (e: unknown): string => String((e as Error)?.message ?? e).split('\n')[0] ?? '';

const LOGIN_PATH = /(^|\/)(login|log-in|signin|sign-in|auth|sso)(\/|$)/i;

/** The per-project place a session is kept: outside the artifact root, which is served over HTTP. */
export function sessionStatePath(projectId: string, role = 'user'): string {
  return path.join(env.workspaceRoot, projectId, 'auth', `${role.replace(/[^a-z0-9_-]/gi, '_')}.json`);
}

/** Routes worth probing: concrete pages, not API or dynamic segments. */
export function probeableRoutes(routes: string[]): string[] {
  return [...new Set(routes)]
    .filter((r) => r.startsWith('/') && !/[:[*]/.test(r) && !r.startsWith('/api/'))
    .slice(0, 5);
}

/** Resolves a route against a base URL that may itself carry a path. */
function urlFor(baseUrl: string, route: string): string {
  return new URL(route.replace(/^\//, ''), baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

/**
 * Waits for a navigation, and for any client-side redirect after it, to
 * settle: the URL must stay the same for a moment. Single-page apps decide
 * about the login redirect after the document has loaded.
 */
async function openAndSettle(page: Page, url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  let last = page.url();
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    await page.waitForTimeout(250);
    const now = page.url();
    if (now !== last) { last = now; stableSince = Date.now(); continue; }
    if (Date.now() - stableSince >= 1500) return;
  }
}

async function isLoginPage(page: Page): Promise<boolean> {
  if (LOGIN_PATH.test(new URL(page.url()).pathname)) return true;
  return page.locator('input[type="password"]').first().isVisible().catch(() => false);
}

/**
 * A signed-out visit to a protected route ends on a login page: redirected to
 * one, or shown a sign-in wall in place of the page. The login page itself (a
 * route that is a login) is public - it is where signed-out visitors belong.
 */
async function sentToLogin(page: Page, route: string): Promise<boolean> {
  if (LOGIN_PATH.test(route)) return false;
  return isLoginPage(page);
}

/** A CAPTCHA challenge on screen: automated sign-in cannot, and must not, continue. */
async function captchaShown(page: Page): Promise<string | null> {
  const challenges: [string, string][] = [
    ['iframe[src*="recaptcha"][src*="bframe"]', 'reCAPTCHA'],
    ['iframe[src*="hcaptcha"][src*="challenge"]', 'hCaptcha'],
    ['iframe[src*="challenges.cloudflare.com"]', 'Cloudflare Turnstile'],
  ];
  for (const [selector, name] of challenges) {
    const frames = page.locator(selector);
    const count = await frames.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const box = await frames.nth(i).boundingBox().catch(() => null);
      if (box && box.height > 100) return name;
    }
  }
  return null;
}

const SUCCESS_TEXT = /\b(success(ful(ly)?)?|welcome|signed in|logged in)\b/i;

async function visibleError(page: Page): Promise<string | null> {
  const texts = await page.locator('[role="alert"], .Mui-error, .error, .invalid-feedback, [data-testid*="error"], [class*="toast"][class*="error"]')
    .allTextContents().catch(() => [] as string[]);
  // A success toast ("Login successful") is shown in the same places as an
  // error; it means the redirect is on its way, not that the login failed.
  const text = texts.map((t) => t.trim()).filter((t) => t && !t.startsWith('/') && !SUCCESS_TEXT.test(t)).join(' · ');
  return text ? text.slice(0, 200) : null;
}

/**
 * Fills and submits the login form. Field detection follows what login forms
 * actually look like: an email or username input (by type, name, id,
 * autocomplete or label), the password input, and the form's submit button.
 */
async function submitLogin(page: Page, email: string, password: string, timeoutMs: number): Promise<void> {
  const passwordField = page.locator('input[type="password"]').first();
  await passwordField.waitFor({ state: 'visible', timeout: timeoutMs });
  const userField = page.locator([
    'input[type="email"]', 'input[autocomplete="username"]', 'input[autocomplete="email"]',
    'input[name*="email" i]', 'input[id*="email" i]', 'input[name*="user" i]', 'input[id*="user" i]',
    'input[name*="login" i]', 'input[id*="login" i]:not([type="password"])',
  ].join(', ')).first();
  const byLabel = page.getByRole('textbox', { name: /e-?mail|user ?name|login/i }).first();
  const field = await userField.isVisible().catch(() => false) ? userField : byLabel;
  await field.fill(email, { timeout: timeoutMs });
  await passwordField.fill(password, { timeout: timeoutMs });
  const submit = page.locator('form button[type="submit"], button[type="submit"]').first();
  const byText = page.getByRole('button', { name: /sign ?in|log ?in|continue|submit/i }).first();
  await (await submit.isVisible().catch(() => false) ? submit : byText).click({ timeout: timeoutMs });
}

type LoginOutcome = { ok: true } | { ok: false; state: AuthState; reason: string };

async function waitForLoginOutcome(page: Page, timeoutMs: number, signal?: AbortSignal, projectRef = '<project>'): Promise<LoginOutcome> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return { ok: false, state: 'AUTHENTICATION_FAILED', reason: 'Stopped.' };
    const captcha = await captchaShown(page);
    if (captcha) {
      return {
        ok: false, state: 'AUTHENTICATION_FAILED',
        reason: `The login form showed a ${captcha} challenge. Automated tests cannot and must not solve it. `
          + `Sign in once by hand with "npm run qa -- auth ${projectRef}" to save a session the review can reuse, `
          + 'or use CAPTCHA test keys in this environment.',
      };
    }
    if (!(await isLoginPage(page))) return { ok: true };
    const error = await visibleError(page);
    if (error) return { ok: false, state: 'AUTHENTICATION_FAILED', reason: `The login was rejected: "${error}". Check the test account's credentials.` };
    await page.waitForTimeout(300);
  }
  return {
    ok: false, state: 'AUTHENTICATION_FAILED',
    reason: `Authentication timeout: still on the login page ${Math.round(timeoutMs / 1000)}s after submitting, with no error shown.`,
  };
}

async function screenshot(page: Page, dir: string, name: string): Promise<string | null> {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.png`);
    await page.screenshot({ path: file, timeout: 5000 });
    return file;
  } catch { return null; }
}

/**
 * A first-run welcome or product-tour dialog covers the page for a new
 * browser, and a modal hides everything behind it from role queries - every
 * test would fail on it. It is closed once, the way a person would, and the
 * session saved afterwards carries that. Only a dialog that is plainly an
 * onboarding tour is touched; any other dialog is left for the tests.
 */
export async function dismissOnboarding(page: Page, waitMs = 3000): Promise<string | null> {
  const dialog = page.locator('[role="dialog"], [aria-modal="true"], .MuiDialog-root, .modal.show').filter({
    hasText: /welcome|take a tour|product tour|let'?s get started|get started|what'?s new|onboarding/i,
  }).first();
  // Such dialogs tend to open a moment after the page has loaded.
  await dialog.waitFor({ state: 'visible', timeout: waitMs }).catch(() => {});
  if (!(await dialog.isVisible().catch(() => false))) return null;
  const heading = ((await dialog.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const close = dialog.locator('button[aria-label*="close" i], button[aria-label*="dismiss" i], button:has(svg[data-testid*="Close"]), button:has-text("Skip"), button:has-text("Close"), button:has-text("Got it"), button:has-text("×")').first();
  if (await close.isVisible().catch(() => false)) await close.click({ timeout: 5000 }).catch(() => {});
  else await page.keyboard.press('Escape').catch(() => {});
  await dialog.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  return heading;
}

/** Opens the first protected route with a context; true when it stays on the page. */
async function routeOpens(context: BrowserContext, baseUrl: string, route: string, timeoutMs: number): Promise<{ ok: boolean; page: Page }> {
  const page = await context.newPage();
  await openAndSettle(page, urlFor(baseUrl, route), timeoutMs);
  return { ok: !(await isLoginPage(page)), page };
}

export async function establishAuthentication(opts: AuthOptions): Promise<AuthCheck> {
  const started = Date.now();
  const t = { ...DEFAULT_TIMEOUTS, ...opts.timeouts };
  const role = opts.role ?? 'user';
  const routes = probeableRoutes(opts.routes.length ? opts.routes : ['/']);
  const result: AuthCheck = {
    // Reported without its query: a configured login URL may carry a bypass token.
    state: 'NOT_REQUIRED', protectedRoutes: [], publicRoutes: [], loginPath: opts.loginPath ? opts.loginPath.split('?')[0]! : null,
    loginAttempted: false, source: null, role, reason: '', storageStatePath: null,
    evidence: { screenshot: null, url: null }, durationMs: 0,
  };
  const done = (patch: Partial<AuthCheck>): AuthCheck => {
    Object.assign(result, patch, { durationMs: Date.now() - started });
    const line = `${result.state}: ${result.reason}`;
    if (result.state === 'VERIFIED' || result.state === 'NOT_REQUIRED') log.info(line); else log.warn(line);
    return result;
  };

  let browser = opts.browser;
  const owned = !browser;
  try {
    if (!browser) {
      const { chromium } = await import('playwright');
      browser = await chromium.launch({ headless: true, timeout: t.navigationMs });
    }

    /* -- 1. Which affected routes are protected? --------------------------- */
    const anonymous = await browser.newContext();
    try {
      for (const route of routes) {
        if (opts.signal?.aborted) break;
        const page = await anonymous.newPage();
        try {
          await openAndSettle(page, urlFor(opts.baseUrl, route), t.navigationMs);
        } catch (e) {
          return done({ state: 'AUTHENTICATION_FAILED', reason: `Route navigation timeout: ${route} did not load within ${t.navigationMs / 1000}s (${firstLine(e)}).` });
        }
        if (await sentToLogin(page, route)) {
          result.protectedRoutes.push(route);
          result.loginPath ??= new URL(page.url()).pathname;
        } else {
          result.publicRoutes.push(route);
        }
        await page.close();
      }
    } finally {
      await anonymous.close();
    }
    if (result.protectedRoutes.length === 0) {
      return done({ state: 'NOT_REQUIRED', reason: `The affected route(s) ${routes.join(', ')} open without signing in.` });
    }
    log.info(`Protected route(s) detected: ${result.protectedRoutes.join(', ')} (signed-out visitors are sent to ${result.loginPath}).`);
    const probe = result.protectedRoutes[0]!;

    /* -- 2. A saved session that still works ------------------------------- */
    if (fs.existsSync(opts.statePath)) {
      const context = await browser.newContext({ storageState: opts.statePath });
      try {
        const { ok, page: opened } = await routeOpens(context, opts.baseUrl, probe, t.navigationMs);
        if (ok) {
          // A saved session from before the welcome dialog was dismissed: dismiss it and save again.
          const dismissed = await dismissOnboarding(opened);
          if (dismissed) {
            log.info(`Dismissed the first-run dialog "${dismissed}"; saving the session again.`);
            await context.storageState({ path: opts.statePath });
          }
          return done({ state: 'VERIFIED', source: 'saved-session', storageStatePath: opts.statePath, reason: `Saved session verified: ${probe} opened signed in.` });
        }
        log.info('The saved session has expired; signing in again.');
      } finally {
        await context.close();
      }
    }

    /* -- 3. Sign in with the test account ----------------------------------- */
    const { email, password } = opts.credentials;
    if (!email || !password) {
      return done({
        state: 'AUTHENTICATION_REQUIRED',
        reason: `${probe} requires signing in, but no ${role} credentials are configured (TEST_${role.toUpperCase()}_EMAIL / TEST_${role.toUpperCase()}_PASSWORD, `
          + 'or project credentials), and there is no saved session.',
      });
    }
    log.info('Login credentials loaded. Attempting login...');
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const loginUrl = urlFor(opts.baseUrl, opts.loginPath ?? result.loginPath ?? '/login');
      try {
        await openAndSettle(page, loginUrl, t.navigationMs);
        result.loginAttempted = true;
        await submitLogin(page, email, password, t.navigationMs);
      } catch (e) {
        const shot = await screenshot(page, opts.evidenceDir, 'auth-login-form');
        return done({
          state: 'AUTHENTICATION_FAILED', loginAttempted: true,
          evidence: { screenshot: shot, url: page.url() },
          reason: `The login form at ${result.loginPath ?? '/login'} could not be filled in: ${firstLine(e).replaceAll(password, '***')}`,
        });
      }
      const outcome = await waitForLoginOutcome(page, t.loginMs, opts.signal, opts.projectRef);
      if (!outcome.ok) {
        const shot = await screenshot(page, opts.evidenceDir, 'auth-login-failed');
        return done({ state: outcome.state, loginAttempted: true, evidence: { screenshot: shot, url: page.url() }, reason: outcome.reason });
      }
      log.info('Login completed.');

      /* -- 4. Verify the session opens the protected route ------------------ */
      const { ok, page: check } = await routeOpens(context, opts.baseUrl, probe, t.navigationMs);
      if (!ok) {
        const shot = await screenshot(check, opts.evidenceDir, 'auth-access-failed');
        return done({
          state: 'AUTHENTICATED_ACCESS_FAILED', loginAttempted: true, source: 'login-form',
          evidence: { screenshot: shot, url: check.url() },
          reason: `Signed in, but ${probe} still redirected to ${new URL(check.url()).pathname}. The account may lack access to this module.`,
        });
      }
      const dismissed = await dismissOnboarding(check);
      if (dismissed) log.info(`Dismissed the first-run dialog "${dismissed}" before saving the session.`);
      fs.mkdirSync(path.dirname(opts.statePath), { recursive: true, mode: 0o700 });
      await context.storageState({ path: opts.statePath });
      fs.chmodSync(opts.statePath, 0o600);
      log.info(`Authentication verified. Protected route accessible: ${probe}.`);
      return done({ state: 'VERIFIED', loginAttempted: true, source: 'login-form', storageStatePath: opts.statePath, reason: `Signed in as ${role} and ${probe} opened.` });
    } finally {
      await context.close();
    }
  } catch (e) {
    return done({ state: 'AUTHENTICATION_FAILED', reason: `Authentication could not be checked: ${firstLine(e)}` });
  } finally {
    if (owned) await browser?.close().catch(() => {});
  }
}

/**
 * For a person to sign in once, in a visible browser, and save the session -
 * the way through a CAPTCHA that automation must not solve. Resolves when the
 * browser leaves the login page (or the timeout passes).
 */
export async function captureSessionInteractively(opts: {
  baseUrl: string; loginPath: string; statePath: string; timeoutMs: number;
}): Promise<{ saved: boolean; reason: string }> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(urlFor(opts.baseUrl, opts.loginPath), { waitUntil: 'domcontentloaded' });
    log.info(`A browser window is open at ${opts.loginPath}. Sign in there; the session is saved as soon as you leave the login page.`);
    const deadline = Date.now() + opts.timeoutMs;
    while (Date.now() < deadline) {
      await page.waitForTimeout(1000);
      if (page.isClosed()) return { saved: false, reason: 'The browser window was closed before signing in.' };
      if (!(await isLoginPage(page))) {
        await page.waitForTimeout(2000);
        fs.mkdirSync(path.dirname(opts.statePath), { recursive: true, mode: 0o700 });
        await context.storageState({ path: opts.statePath });
        fs.chmodSync(opts.statePath, 0o600);
        return { saved: true, reason: `Session saved to ${opts.statePath}.` };
      }
    }
    return { saved: false, reason: `Not signed in within ${Math.round(opts.timeoutMs / 1000)}s.` };
  } finally {
    await browser.close().catch(() => {});
  }
}
