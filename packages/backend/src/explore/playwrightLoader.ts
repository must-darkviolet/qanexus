/**
 * Optional Playwright loader.
 *
 * Browser exploration and PDF export are optional capabilities, so Playwright
 * is not a build-time dependency. The module name is held in a variable so the
 * compiler does not try to resolve it, and callers get a clear message when it
 * is absent instead of a crash.
 */
const MODULE_NAME = 'playwright';

export interface PlaywrightLike {
  chromium: {
    launch(options?: { headless?: boolean }): Promise<BrowserLike>;
  };
}

export interface BrowserLike {
  newContext(options?: Record<string, unknown>): Promise<ContextLike>;
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

export interface ContextLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

export interface PageLike {
  goto(url: string, options?: Record<string, unknown>): Promise<{ status(): number } | null>;
  waitForLoadState(state: string, options?: Record<string, unknown>): Promise<void>;
  title(): Promise<string>;
  url(): string;
  on(event: string, handler: (payload: never) => void): void;
  $$eval<T>(selector: string, fn: (elements: never[]) => T): Promise<T>;
  screenshot(options: Record<string, unknown>): Promise<unknown>;
  pdf(options: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
  /** Present when the context records video; the file is complete once the page closes. */
  video(): { path(): Promise<string> } | null;
}

export class PlaywrightUnavailableError extends Error {
  constructor() {
    super(
      'Playwright is not installed. Run "npm install playwright -w @qa-agent/backend" ' +
      'followed by "npx playwright install chromium" to enable browser exploration and PDF export.',
    );
    this.name = 'PlaywrightUnavailableError';
  }
}

export async function loadPlaywright(): Promise<PlaywrightLike> {
  try {
    return (await import(MODULE_NAME)) as unknown as PlaywrightLike;
  } catch {
    throw new PlaywrightUnavailableError();
  }
}

export async function playwrightAvailable(): Promise<boolean> {
  try { await loadPlaywright(); return true; } catch { return false; }
}
