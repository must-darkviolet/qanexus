/**
 * GitHub authentication (spec section 2).
 *
 * The spec prefers GitHub App authentication but allows a simpler MVP as long
 * as the auth layer can grow into it. This module is that layer: callers ask
 * for a token for a repository and never learn where it came from.
 *
 * Rules enforced here:
 *  - a user's GitHub password is never requested or accepted
 *  - tokens are never returned to the frontend (see api/routes/projects.ts)
 *  - the token with the narrowest scope wins: project token > env token
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../config/env.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('github-auth');

export type AuthSource = 'project_token' | 'env_token' | 'github_app' | 'anonymous';

export interface GitHubCredential {
  token: string | null;
  source: AuthSource;
}

/** Cached installation tokens; GitHub App tokens live for one hour. */
const appTokenCache = new Map<string, { token: string; expiresAt: number }>();

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** Builds the short-lived JWT that identifies the GitHub App itself. */
function createAppJwt(appId: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(`${header}.${payload}`)
    .sign(privateKeyPem.replace(/\\n/g, '\n'))
    .toString('base64url');
  return `${header}.${payload}.${signature}`;
}

async function getInstallationToken(): Promise<string | null> {
  const { GITHUB_APP_ID: appId, GITHUB_APP_PRIVATE_KEY: key, GITHUB_APP_INSTALLATION_ID: installationId } = env;
  if (!appId || !key || !installationId) return null;

  const cached = appTokenCache.get(installationId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  try {
    const jwt = createAppJwt(appId, key);
    const res = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) {
      log.warn(`GitHub App token exchange failed with status ${res.status}; falling back to a personal access token.`);
      return null;
    }
    const body = (await res.json()) as { token: string; expires_at: string };
    appTokenCache.set(installationId, { token: body.token, expiresAt: Date.parse(body.expires_at) });
    log.info('Obtained a GitHub App installation token.');
    return body.token;
  } catch (e) {
    log.warn(`GitHub App authentication error: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Resolves the credential to use for a repository.
 * `projectToken` is the decrypted per-project token, when one was stored.
 */
export async function resolveCredential(projectToken?: string | null): Promise<GitHubCredential> {
  if (projectToken) return { token: projectToken, source: 'project_token' };

  const appToken = await getInstallationToken();
  if (appToken) return { token: appToken, source: 'github_app' };

  if (env.GITHUB_TOKEN) return { token: env.GITHUB_TOKEN, source: 'env_token' };

  return { token: null, source: 'anonymous' };
}

/** Rejects anything that looks like a password rather than a token. */
export function assertLooksLikeToken(value: string): void {
  const looksLikeToken =
    /^gh[pousr]_[A-Za-z0-9]{16,}$/.test(value) ||
    /^github_pat_[A-Za-z0-9_]{20,}$/.test(value) ||
    /^[0-9a-f]{40}$/.test(value);
  if (!looksLikeToken) {
    throw new Error(
      'The supplied value does not look like a GitHub token. ' +
      'This system never accepts GitHub passwords - create a fine-grained personal access token ' +
      'with read-only Contents access, or configure a GitHub App.',
    );
  }
}

/** Builds a clone URL carrying the token, for private repositories. */
export function authenticatedCloneUrl(repoUrl: string, token: string | null): string {
  if (!token || isLocalRepo(repoUrl)) return repoUrl;
  const url = new URL(repoUrl);
  // x-access-token is the documented username for both PATs and App tokens.
  url.username = 'x-access-token';
  url.password = token;
  return url.toString();
}

/** True for a filesystem path or file:// URL rather than a hosted repository. */
export function isLocalRepo(input: string): boolean {
  const trimmed = input.trim();
  return trimmed.startsWith('file://') || trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('../') || /^[A-Za-z]:[\\/]/.test(trimmed);
}

export function parseRepoUrl(input: string): { owner: string; repo: string; url: string } {
  const trimmed = input.trim().replace(/\.git$/, '');

  // A local checkout is supported so the system can be demonstrated, and
  // tested, without network access or a GitHub account.
  if (isLocalRepo(trimmed)) {
    const asPath = trimmed.startsWith('file://') ? fileURLToPath(trimmed) : path.resolve(trimmed);
    const repo = path.basename(asPath) || 'repo';
    const owner = path.basename(path.dirname(asPath)) || 'local';
    return { owner, repo, url: asPath };
  }
  const sshMatch = trimmed.match(/^git@([^:]+):([^/]+)\/(.+)$/);
  if (sshMatch) {
    const [, host, owner, repo] = sshMatch;
    return { owner: owner!, repo: repo!, url: `https://${host}/${owner}/${repo}` };
  }
  const shorthand = trimmed.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (shorthand) {
    const [, owner, repo] = shorthand;
    return { owner: owner!, repo: repo!, url: `https://github.com/${owner}/${repo}` };
  }
  let url: URL;
  try { url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`); }
  catch { throw new Error(`Could not parse "${input}" as a GitHub repository.`); }
  const parts = url.pathname.split('/').filter(Boolean);
  const owner = parts[0];
  const repo = parts[1];
  if (!owner || !repo) throw new Error(`Could not parse owner/repo from "${input}".`);
  return { owner, repo, url: `${url.origin}/${owner}/${repo}` };
}
