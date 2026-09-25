/**
 * Repository workspace: clone/fetch a repo at a branch or commit and expose
 * git history and diffs (spec sections 2 and 8).
 *
 * One persistent checkout per project means the second analysis is an
 * incremental fetch, and `git diff previous..current` is available directly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import { env } from '../config/env.js';
import { createLogger } from '../util/logger.js';
import { authenticatedCloneUrl, isLocalRepo, parseRepoUrl, resolveCredential } from './auth.js';
import { redactSecrets } from '../analysis/secrets.js';

const log = createLogger('workspace');

export interface CheckoutResult {
  dir: string;
  commitSha: string;
  branch: string;
  isPrivate: boolean;
  commits: { sha: string; message: string; author: string; date: string }[];
}

export function workspaceDir(projectId: string): string {
  return path.join(env.workspaceRoot, projectId, 'repo');
}

function git(dir: string): SimpleGit {
  return simpleGit({ baseDir: dir, maxConcurrentProcesses: 1 });
}

/** Never let a token reach a log line or an error surfaced to the API. */
function safeError(e: unknown): Error {
  const message = redactSecrets(e instanceof Error ? e.message : String(e));
  return new Error(message.replace(/x-access-token:[^@]*@/g, 'x-access-token:[REDACTED]@'));
}

export async function checkoutRepository(opts: {
  projectId: string;
  repoUrl: string;
  branch: string;
  commitish?: string | null;
  projectToken?: string | null;
  /**
   * Extra refspecs to fetch, e.g. "+refs/pull/12/head:refs/qa/pr/12" so a pull
   * request's commits - which live outside refs/heads - can be checked out.
   * Fetched into refs/qa/*, never into refs/remotes/origin/*, so a pruning
   * fetch cannot remove them. Failures are logged, not fatal.
   */
  fetchRefs?: string[];
}): Promise<CheckoutResult> {
  const { owner, repo, url } = parseRepoUrl(opts.repoUrl);
  const local = isLocalRepo(opts.repoUrl);
  // A local repository needs no credential at all - least privilege by default.
  const credential = local ? { token: null, source: 'anonymous' as const } : await resolveCredential(opts.projectToken);
  const dir = workspaceDir(opts.projectId);
  const cloneUrl = authenticatedCloneUrl(url, credential.token);

  log.info(`Preparing workspace for ${owner}/${repo}@${opts.branch} (auth: ${credential.source}).`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });

  try {
    if (!fs.existsSync(path.join(dir, '.git'))) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      // Full history is needed for commit-to-commit diffs across runs.
      await git(path.dirname(dir)).clone(cloneUrl, dir, ['--no-tags']);
      log.info('Repository cloned.');
    } else {
      const g = git(dir);
      await g.remote(['set-url', 'origin', cloneUrl]);
      await g.fetch(['origin', '--prune']);
      log.info('Repository fetched.');
    }

    const g = git(dir);
    // A local source's checked-out commit may be reachable from no branch (CI
    // checks out a pull request detached), so its HEAD is fetched as well.
    const extraRefs = [...(opts.fetchRefs ?? []), ...(local ? ['+HEAD:refs/qa/source-head'] : [])];
    for (const refspec of extraRefs) {
      await g.fetch(['origin', refspec]).catch((e: unknown) =>
        log.warn(`Could not fetch ${refspec}: ${safeError(e).message.split('\n')[0]}`));
    }

    const target = opts.commitish?.trim() || `origin/${opts.branch}`;
    try {
      await g.raw(['checkout', '--force', '--detach', target]);
    } catch {
      // The branch may only exist locally, or the default branch may differ.
      const fallback = (await g.raw(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => '')).trim()
        || `origin/${opts.branch}`;
      log.warn(`Could not check out "${target}"; falling back to "${fallback}".`);
      await g.raw(['checkout', '--force', '--detach', fallback]);
    }

    const commitSha = (await g.revparse(['HEAD'])).trim();
    const logResult = await g.log({ maxCount: 30 });
    const commits = logResult.all.map((c) => ({
      sha: c.hash,
      message: c.message,
      author: c.author_name,
      date: c.date,
    }));

    // Strip the credential from .git/config so it never sits on disk.
    await g.remote(['set-url', 'origin', url]).catch(() => {});

    const isPrivate = !local && credential.source !== 'anonymous';
    log.info(`Checked out ${commitSha.slice(0, 8)} on ${opts.branch}.`);
    return { dir, commitSha, branch: opts.branch, isPrivate, commits };
  } catch (e) {
    throw safeError(e);
  }
}

export interface RawDiffFile {
  path: string;
  previousPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  patch?: string;
}

/** `git diff from..to` with per-file patches, capped so prompts stay small. */
export async function diffCommits(dir: string, from: string, to: string, opts?: { maxPatchChars?: number }): Promise<RawDiffFile[]> {
  const g = git(dir);
  const maxPatch = opts?.maxPatchChars ?? 6000;

  const nameStatus = await g.raw(['diff', '--name-status', '-M', `${from}..${to}`]);
  const numStat = await g.raw(['diff', '--numstat', '-M', `${from}..${to}`]);

  const counts = new Map<string, { additions: number; deletions: number }>();
  for (const line of numStat.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const file = parts[2]!.includes('=>') ? parts[2]!.replace(/.*=> /, '').replace(/[{}]/g, '') : parts[2]!;
    counts.set(file.trim(), {
      additions: Number(parts[0]) || 0,
      deletions: Number(parts[1]) || 0,
    });
  }

  const files: RawDiffFile[] = [];
  for (const line of nameStatus.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const code = parts[0]!;
    let status: RawDiffFile['status'];
    let filePath: string;
    let previousPath: string | undefined;

    if (code.startsWith('R')) {
      status = 'renamed';
      previousPath = parts[1];
      filePath = parts[2] ?? parts[1] ?? '';
    } else {
      filePath = parts[1] ?? '';
      status = code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : 'modified';
    }
    if (!filePath) continue;

    let patch: string | undefined;
    if (status !== 'deleted') {
      try {
        const raw = await g.raw(['diff', '-M', '--unified=3', `${from}..${to}`, '--', filePath]);
        patch = redactSecrets(raw.length > maxPatch ? `${raw.slice(0, maxPatch)}\n... [patch truncated]` : raw);
      } catch { /* a binary or unreadable file - skip the patch */ }
    }

    const count = counts.get(filePath) ?? { additions: 0, deletions: 0 };
    files.push({ path: filePath, previousPath, status, ...count, patch });
  }
  return files;
}

export async function commitsBetween(dir: string, from: string, to: string) {
  const g = git(dir);
  try {
    const result = await g.log({ from, to, maxCount: 100 });
    return result.all.map((c) => ({ sha: c.hash, message: c.message, author: c.author_name, date: c.date }));
  } catch {
    return [];
  }
}

export async function fileAtCommit(dir: string, commit: string, filePath: string): Promise<string | null> {
  try {
    return await git(dir).show([`${commit}:${filePath}`]);
  } catch {
    return null;
  }
}

/** The commit a pull request branched from: GitHub diffs a PR against this, not the base tip. */
export async function mergeBase(dir: string, a: string, b: string): Promise<string | null> {
  if (a.startsWith('-') || b.startsWith('-')) return null;
  try {
    return (await git(dir).raw(['merge-base', a, b])).trim() || null;
  } catch {
    return null;
  }
}

export async function commitExists(dir: string, sha: string): Promise<boolean> {
  try {
    await git(dir).raw(['cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** Resolves a branch, tag, short SHA or `HEAD~n` to a full commit SHA. */
export async function resolveRef(dir: string, ref: string): Promise<string | null> {
  // A leading dash would be read by git as an option, never as a ref.
  if (!ref || ref.startsWith('-')) return null;
  const candidates = [ref, `origin/${ref}`];
  for (const candidate of candidates) {
    try {
      return (await git(dir).raw(['rev-parse', '--verify', `${candidate}^{commit}`])).trim();
    } catch { /* try the next spelling */ }
  }
  return null;
}

/**
 * Uncommitted work in a local repository (`git status` + `git diff HEAD`):
 * staged, unstaged and untracked files, compared against HEAD. Read-only - the
 * working tree is never modified.
 */
export async function diffWorkingTree(dir: string, opts?: { maxPatchChars?: number }): Promise<RawDiffFile[]> {
  const g = git(dir);
  const maxPatch = opts?.maxPatchChars ?? 6000;
  const files: RawDiffFile[] = [];

  const nameStatus = await g.raw(['diff', 'HEAD', '--name-status', '-M']);
  const numStat = await g.raw(['diff', 'HEAD', '--numstat', '-M']);
  const counts = new Map<string, { additions: number; deletions: number }>();
  for (const line of numStat.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const file = parts[2]!.includes('=>') ? parts[2]!.replace(/.*=> /, '').replace(/[{}]/g, '') : parts[2]!;
    counts.set(file.trim(), { additions: Number(parts[0]) || 0, deletions: Number(parts[1]) || 0 });
  }

  for (const line of nameStatus.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const code = parts[0]!;
    const renamed = code.startsWith('R');
    const filePath = renamed ? parts[2] ?? '' : parts[1] ?? '';
    if (!filePath) continue;
    const status: RawDiffFile['status'] = renamed ? 'renamed'
      : code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : 'modified';

    let patch: string | undefined;
    if (status !== 'deleted') {
      try {
        const raw = await g.raw(['diff', 'HEAD', '-M', '--unified=3', '--', filePath]);
        patch = redactSecrets(raw.length > maxPatch ? `${raw.slice(0, maxPatch)}\n... [patch truncated]` : raw);
      } catch { /* binary or unreadable */ }
    }
    files.push({
      path: filePath, previousPath: renamed ? parts[1] : undefined, status,
      ...(counts.get(filePath) ?? { additions: 0, deletions: 0 }), patch,
    });
  }

  // Untracked files are part of "the current change" too.
  const untracked = await g.raw(['ls-files', '--others', '--exclude-standard']);
  for (const filePath of untracked.split('\n').map((l) => l.trim()).filter(Boolean)) {
    let additions = 0;
    try { additions = fs.readFileSync(path.join(dir, filePath), 'utf8').split('\n').length; } catch { /* unreadable */ }
    files.push({ path: filePath, status: 'added', additions, deletions: 0 });
  }
  return files;
}

/** Reads a file from the working tree, refusing paths that escape the repo. */
export function readWorkingFile(dir: string, filePath: string): string | null {
  const abs = path.resolve(dir, filePath);
  if (!abs.startsWith(path.resolve(dir) + path.sep)) return null;
  try { return fs.readFileSync(abs, 'utf8'); } catch { return null; }
}

export async function isGitRepository(dir: string): Promise<boolean> {
  try {
    return (await git(dir).raw(['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch {
    return false;
  }
}
