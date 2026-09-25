/**
 * Serving the application under test from a checkout.
 *
 * A pull request has to be tested as the PR's code, not whatever happens to
 * be running. When a start command is configured (PR_APP_START_COMMAND or
 * `qa pr --start`), the checked-out PR is served for the duration of the
 * review and stopped afterwards.
 *
 * The command is configuration written by the operator, not input from the
 * PR, so it is run through the shell like any npm script would be.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { env } from '../config/env.js';
import { createLogger } from '../util/logger.js';
import { withoutSecrets } from '../util/process.js';

const log = createLogger('app-server');

export interface RunningApp {
  url: string;
  stop(): Promise<void>;
}

/** True when anything answers HTTP at the URL (any status: a 404 still means a server). */
export async function isReachable(url: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    await res.body?.cancel().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/** The environment a served app gets: no secrets of this system, and the port it should bind. */
function appEnv(url: string): NodeJS.ProcessEnv {
  const base = withoutSecrets(process.env);
  // An application may genuinely need a secret of its own to boot (a session
  // key, for instance). Those are named explicitly rather than inherited.
  for (const name of env.PR_APP_ENV_ALLOW.split(',').map((n) => n.trim()).filter(Boolean)) {
    if (process.env[name] !== undefined) base[name] = process.env[name];
  }
  const port = new URL(url).port;
  return { ...base, ...(port ? { PORT: port } : {}), BROWSER: 'none', CI: base['CI'] ?? '1' };
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    // The command runs in its own process group, so its children (the dev
    // server npm spawned) are stopped with it.
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    else process.kill(-child.pid, signal);
  } catch { /* already gone */ }
}

export async function startApp(opts: {
  command: string;
  cwd: string;
  url: string;
  timeoutMs: number;
}): Promise<RunningApp> {
  if (await isReachable(opts.url)) {
    throw new Error(
      `Something is already serving ${opts.url}. Stop it, or use a different base URL, so that the pull request's own build is what gets tested.`,
    );
  }

  log.info(`Starting the application: ${opts.command}`);
  const child = spawn(opts.command, {
    cwd: opts.cwd, shell: true, env: appEnv(opts.url),
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const keep = (d: Buffer) => { output = (output + d.toString()).slice(-3000); };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);

  // exitCode stays null when a process is killed by a signal (an OOM kill,
  // a segfault), so the exit event is what "gone" is decided on.
  let gone = false;
  child.once('exit', () => { gone = true; });

  const stop = async () => {
    if (gone) return;
    killTree(child, 'SIGTERM');
    let timer: NodeJS.Timeout | undefined;
    const exited = await Promise.race([
      new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 5000); }),
    ]);
    clearTimeout(timer);
    if (!exited) killTree(child, 'SIGKILL');
    log.info('Application stopped.');
  };

  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    if (gone) {
      throw new Error(
        `The start command ${child.exitCode !== null ? `exited with code ${child.exitCode}` : `was killed by ${child.signalCode}`}`
        + ` before ${opts.url} responded.\n${output.slice(-1500)}`,
      );
    }
    if (await isReachable(opts.url)) {
      log.info(`Application is up at ${opts.url}.`);
      return { url: opts.url, stop };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  await stop();
  throw new Error(`${opts.url} did not respond within ${Math.round(opts.timeoutMs / 1000)}s of running "${opts.command}".\n${output.slice(-1500)}`);
}
