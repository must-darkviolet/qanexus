/**
 * Pull requests on GitHub: reading one, verifying webhook deliveries about it,
 * and keeping one QA comment on it up to date.
 *
 * Writing a comment is the only write this system makes to GitHub. It needs a
 * token with "Pull requests: write" (or "Issues: write") on the repository -
 * in GitHub Actions, `permissions: pull-requests: write` on GITHUB_TOKEN.
 */
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { createLogger } from '../util/logger.js';
import { redactSecrets } from '../analysis/secrets.js';

const log = createLogger('github-pr');

/** Identifies the comment this system owns, so a re-run edits it instead of adding another. */
export const COMMENT_MARKER = '<!-- qa-intelligence:pr-review -->';
/** GitHub rejects comment bodies over 65,536 characters. */
const MAX_COMMENT_CHARS = 65_000;

export interface PullRequestInfo {
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  draft: boolean;
  author: string | null;
  headSha: string;
  headRef: string;
  baseSha: string;
  baseRef: string;
  /** Repository the head branch lives in; differs from the base for forks. */
  headRepoFullName: string | null;
}

export interface PostedComment {
  id: number;
  url: string;
  created: boolean;
}

export class GitHubApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

async function api<T>(token: string | null, method: string, route: string, body?: unknown): Promise<T> {
  const res = await fetch(`${env.GITHUB_API_URL}${route}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'qa-intelligence',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const hint = res.status === 403 || res.status === 404
      ? ' Check that the token can access this repository (commenting needs "Pull requests: write").'
      : res.status === 401 ? ' The token is missing, expired or invalid.' : '';
    throw new GitHubApiError(res.status,
      `GitHub ${method} ${route} failed with ${res.status}.${hint} ${redactSecrets(detail.slice(0, 300))}`.trim());
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const repoPath = (owner: string, repo: string) => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

interface RawPullRequest {
  number: number; title: string; body: string | null; html_url: string; state: string; draft?: boolean;
  user?: { login?: string } | null;
  head: { sha: string; ref: string; repo?: { full_name?: string } | null };
  base: { sha: string; ref: string };
}

export function toPullRequestInfo(raw: RawPullRequest): PullRequestInfo {
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? '',
    url: raw.html_url,
    state: raw.state,
    draft: Boolean(raw.draft),
    author: raw.user?.login ?? null,
    headSha: raw.head.sha,
    headRef: raw.head.ref,
    baseSha: raw.base.sha,
    baseRef: raw.base.ref,
    headRepoFullName: raw.head.repo?.full_name ?? null,
  };
}

export async function getPullRequest(owner: string, repo: string, number: number, token: string | null): Promise<PullRequestInfo> {
  return toPullRequestInfo(await api<RawPullRequest>(token, 'GET', `${repoPath(owner, repo)}/pulls/${number}`));
}

/** Fits a comment within GitHub's limit, keeping the start (the verdict) intact. */
export function fitComment(body: string): string {
  const safe = redactSecrets(body);
  if (safe.length <= MAX_COMMENT_CHARS) return safe;
  return `${safe.slice(0, MAX_COMMENT_CHARS - 200)}\n\n…\n\n_The review was truncated to fit GitHub's comment size limit. The full report is in the run's artifacts._\n`;
}

/**
 * Creates the QA comment, or edits the one already there. The known comment id
 * is tried first; otherwise the PR's comments are searched for the marker.
 */
export async function upsertPullRequestComment(opts: {
  owner: string; repo: string; number: number; body: string; token: string | null;
  knownCommentId?: string | number | null;
}): Promise<PostedComment> {
  if (!opts.token) {
    throw new Error('No GitHub token is available to comment with. Set GITHUB_TOKEN, a project token, or a GitHub App.');
  }
  const base = repoPath(opts.owner, opts.repo);
  const body = fitComment(opts.body.includes(COMMENT_MARKER) ? opts.body : `${COMMENT_MARKER}\n${opts.body}`);

  const edit = async (id: string | number): Promise<PostedComment> => {
    const res = await api<{ id: number; html_url: string }>(opts.token, 'PATCH', `${base}/issues/comments/${id}`, { body });
    return { id: res.id, url: res.html_url, created: false };
  };

  if (opts.knownCommentId) {
    try { return await edit(opts.knownCommentId); } catch (e) {
      // Deleted by someone, most likely - fall through and look again.
      if (!(e instanceof GitHubApiError && e.status === 404)) throw e;
    }
  }

  for (let page = 1; page <= 10; page++) {
    const comments = await api<{ id: number; body?: string }[]>(
      opts.token, 'GET', `${base}/issues/${opts.number}/comments?per_page=100&page=${page}`,
    );
    const mine = comments.find((c) => c.body?.includes(COMMENT_MARKER));
    if (mine) return edit(mine.id);
    if (comments.length < 100) break;
  }

  const res = await api<{ id: number; html_url: string }>(opts.token, 'POST', `${base}/issues/${opts.number}/comments`, { body });
  log.info(`Commented on ${opts.owner}/${opts.repo}#${opts.number}.`);
  return { id: res.id, url: res.html_url, created: true };
}

/**
 * Verifies a webhook delivery's X-Hub-Signature-256 header against the raw
 * request body. Constant-time, and false for any malformed header.
 */
export function verifyWebhookSignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!secret || !header?.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`);
  const received = Buffer.from(header);
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}
