/**
 * Keeps secrets out of text that leaves this machine - the pull-request
 * comment above all, which anyone with read access to the repository sees.
 *
 * Two nets: the actual values of every credential-shaped variable this process
 * (and the project) holds, and the shapes of common tokens, for secrets that
 * reach the text some other way (a stack trace, a logged request URL).
 */
import { isSecretEnvName } from './process.js';

const MASK = '[redacted]';

const TOKEN_SHAPES: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** "token=x", "password: x" - the value goes, the label stays. Prose like "password field" is untouched. */
const LABELLED = /\b(password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|client[_-]?secret)(\s*[:=]\s*)(["']?)([^\s"'&,;]{6,})\3/gi;
const BEARER = /\b(Bearer)\s+[A-Za-z0-9._~+/-]{10,}=*/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Values too short or too common to mask without mangling ordinary text. */
function worthMasking(value: string): boolean {
  return value.length >= 6 && !/^(true|false|null|undefined|\d{1,6})$/i.test(value);
}

export function secretValues(env: NodeJS.ProcessEnv = process.env, extra: Iterable<string> = []): string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (value && isSecretEnvName(name) && worthMasking(value)) values.add(value);
  }
  for (const value of extra) if (value && worthMasking(value)) values.add(value);
  // Longest first, so a secret that contains another is masked whole.
  return [...values].sort((a, b) => b.length - a.length);
}

export function redactSecrets(text: string, values: string[] = secretValues()): string {
  let out = text;
  for (const value of values) out = out.replace(new RegExp(escapeRegExp(value), 'g'), MASK);
  for (const shape of TOKEN_SHAPES) out = out.replace(shape, MASK);
  return out
    .replace(BEARER, `$1 ${MASK}`)
    .replace(LABELLED, (_m, label: string, sep: string, quote: string) => `${label}${sep}${quote}${MASK}${quote}`);
}
