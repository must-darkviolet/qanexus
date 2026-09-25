/**
 * Provider availability check.
 *
 * Cheap by default: it verifies configuration and, for the Claude CLI, that
 * the executable runs and reports a logged-in session - neither of which
 * spends a model call. `live: true` additionally sends one tiny request.
 */
import os from 'node:os';
import { env, type AiProviderName } from '../config/env.js';
import { runProcess, ProcessStartError } from '../util/process.js';
import { cliEnv } from './claudeCli.js';
import { AiConfigError, createProviders } from './factory.js';

export interface ProviderHealth {
  provider: AiProviderName;
  available: boolean;
  reason?: string;
  model?: string;
  version?: string;
  /** Only present with `live: true`. */
  liveCheck?: 'passed' | 'failed';
}

const PROBE_TIMEOUT_MS = 15_000;

async function checkClaudeCli(): Promise<ProviderHealth> {
  const base = { provider: 'claude-cli' as const, model: env.CLAUDE_MODEL ?? 'cli-default' };
  const opts = { timeoutMs: PROBE_TIMEOUT_MS, env: cliEnv(), cwd: os.tmpdir() };

  let version: string;
  try {
    const res = await runProcess(env.CLAUDE_CLI_COMMAND, ['--version'], opts);
    if (res.exitCode !== 0) return { ...base, available: false, reason: `Claude CLI "--version" exited with code ${res.exitCode}` };
    version = res.stdout.trim().split('\n')[0] ?? '';
  } catch (e) {
    const missing = e instanceof ProcessStartError && (e.code === 'ENOENT' || e.code === 'EACCES');
    return { ...base, available: false, reason: missing ? 'Claude CLI not found' : `Claude CLI could not be started: ${(e as Error).message}` };
  }

  // Only the loggedIn flag is read from the status output; account details are discarded.
  try {
    const res = await runProcess(env.CLAUDE_CLI_COMMAND, ['auth', 'status'], opts);
    const status = JSON.parse(res.stdout) as { loggedIn?: unknown };
    if (status.loggedIn === false) {
      return { ...base, version, available: false, reason: 'Claude CLI is not logged in - run "claude" once and log in' };
    }
  } catch {
    // Older CLIs have no "auth status"; the live check (or the first real call) will tell.
  }
  return { ...base, version, available: true };
}

export async function checkAIProvider(
  name: AiProviderName = env.AI_PROVIDER,
  opts: { live?: boolean } = {},
): Promise<ProviderHealth> {
  if (env.AI_DISABLED) return { provider: name, available: false, reason: 'AI_DISABLED=1' };

  let health: ProviderHealth;
  if (name === 'claude-cli') {
    health = await checkClaudeCli();
  } else {
    try {
      const [primary] = createProviders(name);
      health = { provider: name, available: true, model: primary?.model };
    } catch (e) {
      return { provider: name, available: false, reason: e instanceof AiConfigError ? e.message : String(e) };
    }
  }

  if (!opts.live || !health.available) return health;

  try {
    const [provider] = createProviders(name);
    const res = await provider!.generate({
      agent: 'HealthCheck',
      system: 'Return JSON only.',
      user: 'Return {"ok":true}',
      maxOutputTokens: 256,
    });
    const ok = /"ok"\s*:\s*true/.test(res.text);
    return { ...health, model: res.model, liveCheck: ok ? 'passed' : 'failed', ...(ok ? {} : { available: false, reason: 'Unexpected response to the live check' }) };
  } catch (e) {
    return { ...health, available: false, liveCheck: 'failed', reason: e instanceof Error ? e.message : String(e) };
  }
}
