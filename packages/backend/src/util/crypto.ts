import crypto from 'node:crypto';
import { env } from '../config/env.js';

/**
 * Credential encryption at rest (spec section 27).
 *
 * Test credentials and GitHub tokens are stored encrypted with AES-256-GCM.
 * When no key is configured we refuse to store rather than storing plaintext.
 */
const ALGO = 'aes-256-gcm';

function key(): Buffer {
  const hex = env.CREDENTIAL_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error(
      'CREDENTIAL_ENCRYPTION_KEY is not set. Generate one with:\n' +
      '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== 32) throw new Error('CREDENTIAL_ENCRYPTION_KEY must be 32 bytes of hex (64 hex chars).');
  return buf;
}

export function canEncrypt(): boolean {
  try { key(); return true; } catch { return false; }
}

export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
}

export function decrypt(payload: string): string {
  const [version, ivB64, tagB64, dataB64] = payload.split('.');
  if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) throw new Error('Malformed encrypted payload.');
  const decipher = crypto.createDecipheriv(ALGO, key(), Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
}
