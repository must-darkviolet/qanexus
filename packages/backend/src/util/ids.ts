import crypto from 'node:crypto';

export function uuid(): string {
  return crypto.randomUUID();
}

/** Short, human-referenceable id, e.g. BR-001 / SC-014. */
export function seqId(prefix: string, n: number, width = 3): string {
  return `${prefix}-${String(n).padStart(width, '0')}`;
}

export function sha256(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** Stable short hash used for cache keys and failure signatures. */
export function shortHash(input: string): string {
  return sha256(input).slice(0, 16);
}

/**
 * Slugifies a string for use as a key: "User Management" -> "user-management".
 */
export function slug(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase()
    .slice(0, 80) || 'unnamed';
}

/** PascalCase identifier suitable for a class name. */
export function pascal(input: string): string {
  return input
    .replace(/[^\w\s-]/g, ' ')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('') || 'Unnamed';
}

export function camel(input: string): string {
  const p = pascal(input);
  return p.charAt(0).toLowerCase() + p.slice(1);
}
