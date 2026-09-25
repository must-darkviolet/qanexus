/**
 * Safe child-process execution.
 *
 * Arguments are always an array handed straight to the executable: no shell
 * is involved, so nothing in a prompt or a file name can be interpreted as a
 * command. Output is captured with a size cap and the process is killed on
 * timeout (SIGTERM, then SIGKILL if it ignores that).
 */
import { spawn } from 'node:child_process';

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface RunProcessOptions {
  /** Written to stdin, then stdin is closed. */
  input?: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Per-stream capture limit; anything beyond it is dropped. */
  maxOutputBytes?: number;
}

/** Thrown when the executable could not be started at all (ENOENT, EACCES). */
export class ProcessStartError extends Error {
  constructor(message: string, readonly code: string | undefined) {
    super(message);
    this.name = 'ProcessStartError';
  }
}

const KILL_GRACE_MS = 3000;

/**
 * Names that must not reach a child process: this system's own secrets, and
 * anything shaped like a credential (NPM_TOKEN, AWS_SECRET_ACCESS_KEY, …).
 *
 * A child here is either the application under test - whose start command and
 * install scripts come from the repository being reviewed, including a fork -
 * or generated test code. Neither is entitled to the ambient environment of
 * whatever machine this runs on. This is deliberately a deny-list by shape
 * rather than an allow-list, because an application under test legitimately
 * needs its own configuration from the environment.
 */
const SECRET_NAME = new RegExp(
  '^(' +
  // this system's own configuration
  'GEMINI_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GITHUB_TOKEN|GH_TOKEN' +
  '|GITHUB_APP_PRIVATE_KEY|GITHUB_WEBHOOK_SECRET|CREDENTIAL_ENCRYPTION_KEY|DATABASE_URL' +
  // anything credential-shaped, whoever set it
  '|.*_(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS|PRIVATE_KEY|API_KEY|ACCESS_KEY|SECRET_KEY)' +
  '|AWS_(ACCESS_KEY_ID|SESSION_TOKEN|SECURITY_TOKEN)|SSH_AUTH_SOCK|NPM_TOKEN' +
  ')$',
);

export function isSecretEnvName(name: string): boolean {
  return SECRET_NAME.test(name.toUpperCase());
}

/** A copy of an environment with every credential-shaped entry removed. */
export function withoutSecrets(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !isSecretEnvName(key)));
}

export function runProcess(command: string, args: string[], opts: RunProcessOptions): Promise<ProcessResult> {
  const maxBytes = opts.maxOutputBytes ?? 20 * 1024 * 1024;
  const started = Date.now();

  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      reject(new ProcessStartError(err.message, err.code));
      return;
    }

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let settled = false;

    child.stdout!.on('data', (d: Buffer) => { if (outBytes < maxBytes) { out.push(d); outBytes += d.length; } });
    child.stderr!.on('data', (d: Buffer) => { if (errBytes < maxBytes) { err.push(d); errBytes += d.length; } });

    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
    }, opts.timeoutMs);

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      fn();
    };

    child.on('error', (e: NodeJS.ErrnoException) => {
      finish(() => reject(new ProcessStartError(e.message, e.code)));
    });
    child.on('close', (exitCode, signal) => {
      finish(() => resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
        durationMs: Date.now() - started,
      }));
    });

    // A child that exits before reading stdin raises EPIPE; the exit code is what matters.
    child.stdin!.on('error', () => undefined);
    child.stdin!.end(opts.input ?? '');
  });
}
