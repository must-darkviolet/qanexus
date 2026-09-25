import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Finds the monorepo root.
 *
 * npm workspace scripts run with the working directory set to the *package*,
 * so `npm run migrate` from the repo root would otherwise resolve
 * "./data/qa-agent.db" inside packages/backend and quietly use a different
 * database than `npm run dev` does. The root is located by walking up for the
 * package.json that declares the workspaces.
 */
function findRepoRoot(): string {
  if (process.env.QA_AGENT_ROOT) return path.resolve(process.env.QA_AGENT_ROOT);

  const candidates = [process.cwd(), path.dirname(fileURLToPath(import.meta.url))];
  for (const start of candidates) {
    let dir = start;
    for (let depth = 0; depth < 8; depth++) {
      const manifest = path.join(dir, 'package.json');
      try {
        if (fs.existsSync(manifest)) {
          const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { workspaces?: unknown };
          if (pkg.workspaces) return dir;
        }
      } catch { /* keep walking */ }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return process.cwd();
}

const ROOT = findRepoRoot();

// .env lives at the repo root, not beside whichever package is running.
dotenv.config({ path: path.join(ROOT, '.env') });

const abs = (p: string) => (path.isAbsolute(p) ? p : path.resolve(ROOT, p));

const boolish = (def: boolean) =>
  z.string().optional().transform((v) => (v === undefined || v.trim() === '' ? def : /^(1|true|yes|on)$/i.test(v)));

/** Empty values in .env ("GEMINI_MODEL=") mean "use the default", not "use ''". */
const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const withDefault = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(blankToUndefined, schema);

export const AI_PROVIDERS = ['gemini', 'claude-cli', 'openai'] as const;
export type AiProviderName = (typeof AI_PROVIDERS)[number];

const providerName = z.string().optional().transform((v, ctx) => {
  const value = v?.trim() ?? '';
  if (value === '') return undefined;
  if ((AI_PROVIDERS as readonly string[]).includes(value)) return value as AiProviderName;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: `unsupported provider "${value}". Use one of: ${AI_PROVIDERS.join(', ')}.`
      + (value === 'claude' ? ' Claude runs through the locally authenticated CLI: use "claude-cli".' : ''),
  });
  return z.NEVER;
});

export const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().default(4000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  AI_PROVIDER: providerName.transform((v) => v ?? 'gemini'),
  /** Tried only when the primary provider is unavailable. Empty = no cross-provider fallback. */
  AI_FALLBACK_PROVIDER: providerName,
  AI_DISABLED: boolish(false),
  /** Ceiling on AI requests per minute (0 = adapt automatically after the first 429). */
  AI_MAX_REQUESTS_PER_MINUTE: z.coerce.number().int().min(0).default(0),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: withDefault(z.string().default('gemini-3.6-flash')),
  /** Comma-separated Gemini models tried in order when the primary is exhausted (free tiers are per model). */
  GEMINI_FALLBACK_MODELS: z.string().default(''),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: withDefault(z.string().default('gpt-4o-mini')),

  /** Claude runs through the locally installed, already authenticated Claude Code CLI - no API key. */
  CLAUDE_CLI_COMMAND: withDefault(z.string().default('claude')),
  /** Empty = whatever model the CLI is configured to use. */
  CLAUDE_MODEL: z.string().optional().transform((v) => v?.trim() || undefined),
  CLAUDE_CLI_TIMEOUT_MS: withDefault(z.coerce.number().int().positive().default(120_000)),
  /** Optional --effort level (low|medium|high|xhigh|max); lower spends fewer thinking tokens. */
  CLAUDE_CLI_EFFORT: withDefault(z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional()),

  /** Token budgets. Characters are used because they are measurable before a call; ~4 chars per token. */
  AI_MAX_INPUT_CHARS: withDefault(z.coerce.number().int().min(2000).default(48_000)),
  AI_MAX_OUTPUT_TOKENS: withDefault(z.coerce.number().int().min(256).default(8192)),
  AI_MAX_FILES_PER_REQUEST: withDefault(z.coerce.number().int().min(1).default(8)),
  AI_MAX_TESTS_PER_REQUEST: withDefault(z.coerce.number().int().min(1).default(25)),
  AI_MAX_DIFF_CHARS: withDefault(z.coerce.number().int().min(1000).default(20_000)),
  AI_CACHE_ENABLED: boolish(true),

  DATABASE_URL: z.string().default('sqlite:./data/qa-agent.db'),

  GITHUB_TOKEN: z.string().optional(),
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_APP_INSTALLATION_ID: z.string().optional(),
  /** REST endpoint; set for GitHub Enterprise Server. GitHub Actions sets it automatically. */
  GITHUB_API_URL: withDefault(z.string().url().default('https://api.github.com')).transform((v) => v.replace(/\/+$/, '')),

  TEST_BASE_URL: z.string().default('http://localhost:3000'),
  PLAYWRIGHT_BROWSER: withDefault(z.enum(['chromium', 'firefox', 'webkit']).default('chromium')),
  PLAYWRIGHT_TIMEOUT_MS: withDefault(z.coerce.number().int().positive().default(600_000)),
  /** No test may take longer than this to begin: browser launch, config and compilation. */
  PLAYWRIGHT_STARTUP_TIMEOUT_MS: withDefault(z.coerce.number().int().positive().default(120_000)),
  /** 0 = let Playwright choose; the default of 1 keeps recordings and stubs deterministic. */
  PLAYWRIGHT_WORKERS: withDefault(z.coerce.number().int().min(0).default(1)),
  PLAYWRIGHT_HEADED: boolish(false),
  /** Every test is recorded by default so a reviewer can watch what happened. */
  PLAYWRIGHT_VIDEO: withDefault(z.enum(['on', 'off', 'retain-on-failure', 'on-first-retry']).default('on')),
  PLAYWRIGHT_SCREENSHOT: withDefault(z.enum(['on', 'off', 'only-on-failure']).default('only-on-failure')),
  PLAYWRIGHT_TRACE: withDefault(z.enum(['on', 'off', 'retain-on-failure', 'on-first-retry']).default('retain-on-failure')),
  /** Stub the app's API with type-derived fixtures in generated tests (0 = use the real backend). */
  TEST_MOCK_API: boolish(true),
  TEST_USER_EMAIL: z.string().optional(),
  TEST_USER_PASSWORD: z.string().optional(),
  TEST_ADMIN_EMAIL: z.string().optional(),
  TEST_ADMIN_PASSWORD: z.string().optional(),
  /**
   * Where tests sign in, when not the app's own redirect target. May carry a
   * test-environment CAPTCHA bypass (e.g. /login?token=...): the query is
   * treated as a secret and masked in every report.
   */
  TEST_LOGIN_PATH: z.string().optional().transform((v) => v?.trim() || undefined),

  BROWSER_EXPLORATION_ENABLED: boolish(false),

  /** Pull-request review (see pipeline/prReview.ts). */
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  /** pull_request actions that start a review. */
  PR_REVIEW_ACTIONS: withDefault(z.string().default('opened,synchronize,reopened,ready_for_review')),
  /** Where the PR's build is served, e.g. https://pr-{number}.preview.example.com. Empty = the project's base URL. */
  PR_PREVIEW_URL_TEMPLATE: z.string().optional().transform((v) => v?.trim() || undefined),
  /** Shell command that serves the checked-out PR (e.g. "npm ci && npm run dev"). Empty = the app is already running. */
  PR_APP_START_COMMAND: z.string().optional().transform((v) => v?.trim() || undefined),
  PR_APP_START_TIMEOUT_MS: withDefault(z.coerce.number().int().positive().default(180_000)),
  /**
   * Credential-shaped variables (…_SECRET, …_TOKEN, …_KEY) are withheld from
   * the application under test. Name any it genuinely needs here, comma-separated.
   */
  PR_APP_ENV_ALLOW: withDefault(z.string().default('')),
  /** Pull requests from forks run the fork's code; off by default. */
  PR_REVIEW_FORKS: boolish(false),
  /**
   * Hosts a review may test besides local, dev/staging/qa/preview-named and PR
   * preview hosts (comma-separated; "*.example.com" matches subdomains).
   * Anything else is refused so a review never writes to production.
   */
  QA_ALLOWED_TEST_HOSTS: withDefault(z.string().default('')),
  /** Also run the target repository's own Playwright tests related to the change. */
  REPO_TESTS_ENABLED: boolish(true),
  REPO_TESTS_MAX: withDefault(z.coerce.number().int().min(1).default(20)),
  /** Public URL of this API, so PR comments can link to recordings. Empty = paths only. */
  QA_PUBLIC_URL: z.string().optional().transform((v) => v?.trim().replace(/\/+$/, '') || undefined),

  WORKSPACE_ROOT: z.string().default('./workspaces'),
  ARTIFACT_ROOT: z.string().default('./artifacts'),
  CREDENTIAL_ENCRYPTION_KEY: z.string().optional(),
  ARTIFACT_RETENTION_DAYS: z.coerce.number().int().default(30),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = {
  ...parsed.data,
  rootDir: ROOT,
  workspaceRoot: abs(parsed.data.WORKSPACE_ROOT),
  artifactRoot: abs(parsed.data.ARTIFACT_ROOT),
  isProduction: parsed.data.NODE_ENV === 'production',
};

/**
 * True when the configured provider can be attempted. The pipeline degrades
 * to deterministic-only analysis rather than failing outright (spec section 26:
 * "The system should continue working if AI temporarily fails where
 * deterministic processing is possible").
 *
 * claude-cli needs no key: the CLI owns its authentication, and whether it is
 * installed and logged in is checked by checkAIProvider(), not guessed here.
 */
export function providerIsConfigured(name: AiProviderName): boolean {
  switch (name) {
    case 'gemini': return Boolean(env.GEMINI_API_KEY);
    case 'openai': return Boolean(env.OPENAI_API_KEY);
    case 'claude-cli': return Boolean(env.CLAUDE_CLI_COMMAND);
  }
}

export function aiIsConfigured(): boolean {
  if (env.AI_DISABLED) return false;
  return providerIsConfigured(env.AI_PROVIDER)
    || (env.AI_FALLBACK_PROVIDER ? providerIsConfigured(env.AI_FALLBACK_PROVIDER) : false);
}
