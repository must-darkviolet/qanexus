import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env.js';
import { redactSecrets } from '../analysis/secrets.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

function emit(level: Level, scope: string, message: string, meta?: unknown) {
  if (LEVELS[level] < LEVELS[env.LOG_LEVEL]) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  // Every log line is sanitized: this process handles private source code and
  // API keys, and neither may ever reach a log sink (spec section 27).
  const safe = redactSecrets(line);
  const payload = meta === undefined ? '' : ' ' + redactSecrets(safeStringify(meta));
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  sink(safe + payload);
  toFile(safe + payload);
}

/**
 * The same lines, appended to data/logs/qa-agent.log (QA_LOG_FILE to move it,
 * "off" to disable): a review's decisions stay readable after the terminal is gone.
 */
let logFile: string | null | undefined;
function toFile(line: string) {
  if (logFile === undefined) {
    const setting = process.env.QA_LOG_FILE;
    logFile = setting === 'off' || process.env.NODE_ENV === 'test' || process.argv.some((a) => a === '--test') ? null
      : path.resolve(setting || path.join(process.cwd().replace(/[\\/]packages[\\/]backend$/, ''), 'data', 'logs', 'qa-agent.log'));
    if (logFile) { try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); } catch { logFile = null; } }
  }
  if (!logFile) return;
  try { fs.appendFileSync(logFile, `${line}\n`); } catch { /* the console still has it */ }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v));
  } catch {
    return String(value);
  }
}

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, meta) => emit('debug', scope, m, meta),
    info: (m, meta) => emit('info', scope, m, meta),
    warn: (m, meta) => emit('warn', scope, m, meta),
    error: (m, meta) => emit('error', scope, m, meta),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

export const logger = createLogger('qa-agent');
