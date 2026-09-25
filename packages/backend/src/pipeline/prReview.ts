/**
 * Pull-request review.
 *
 * When a pull request is opened or updated:
 *
 *   read the PR (title, description, base, head)
 *     -> check out its head and diff it against the merge base
 *     -> serve that build (optional: PR_APP_START_COMMAND / --start)
 *     -> run the pipeline with the PR's intent: impact analysis, scenarios,
 *        new or updated Playwright tests for the affected modules, targeted
 *        execution with every test recorded, failure analysis
 *     -> walk through the affected routes in a recorded browser
 *     -> post (or update) one comment on the PR with the results
 *
 * Triggered by the GitHub webhook (api/routes/github.ts), by `qa pr` from a
 * terminal or CI, or by the API. A review can also be run offline against two
 * local refs, in which case the comment is written to a file instead.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Project, RunSummary } from '@qa-agent/shared';
import { env } from '../config/env.js';
import { createLogger } from '../util/logger.js';
import { errorMessage } from '../util/errors.js';
import {
  isCancelled, registerCancellable, releaseCancellable, throwIfCancelled,
} from '../util/cancellation.js';
import { resolveCredential, isLocalRepo } from '../github/auth.js';
import { checkoutRepository, commitExists, diffCommits, mergeBase, resolveRef } from '../github/workspace.js';
import { getPullRequest, upsertPullRequestComment } from '../github/pullRequests.js';
import { getProjectSecrets } from '../db/repos/projects.js';
import { createRun } from '../db/repos/runs.js';
import {
  createPrReview, latestPrReview, updatePrReview, type PrReview, type PrReviewTrigger,
} from '../db/repos/prReviews.js';
import { executeRunDetailed, type PullRequestContext, type RunDetails } from './orchestrator.js';
import { isReachable, startApp, type RunningApp } from './appServer.js';
import { renderPrComment, reviewVerdict, type ArtifactLinker, type ReviewVerdict, type SinceLastReview } from './prComment.js';
import { unsafeTargetReason } from './safety.js';
import { redactSecrets, secretValues } from '../util/redact.js';
import { artifactFileUrl } from '../api/routes/artifacts.js';

const log = createLogger('pr-review');
const prLog = createLogger('PR');
const readyLog = createLogger('APP-READINESS');
const reportLog = createLogger('REPORT');
const githubLog = createLogger('GITHUB');

export interface ReviewPullRequestOptions {
  project: Project;
  trigger: PrReviewTrigger;
  /** A GitHub pull request; its details are read from the API. */
  number?: number;
  /** Offline review of two refs, with the PR text supplied directly. */
  local?: { base: string; head: string; title?: string; body?: string };
  /** owner/repo for API calls when the project was registered by local path (CI). */
  repoFullName?: string;
  baseUrl?: string;
  /** Serves the checked-out PR while it is reviewed. Null disables PR_APP_START_COMMAND. */
  startCommand?: string | null;
  /** Post the comment on GitHub (default: yes, for a GitHub PR). */
  postComment?: boolean;
  /** Also write the comment's markdown here. */
  commentFile?: string;
  /** Review again even when this head commit was already reviewed. */
  force?: boolean;
  /** Include tier 3 (every generated spec), not just the modules the change reaches. */
  fullRegression?: boolean;
}

export interface PullRequestReviewResult {
  review: PrReview | null;
  verdict: ReviewVerdict;
  run: RunSummary | null;
  details: RunDetails | null;
  comment: string;
  commentUrl: string | null;
  /** Set when an identical head was already reviewed and force was not given. */
  skipped?: string;
}

function repoOf(project: Project, override?: string): { owner: string; repo: string } {
  const full = override?.trim();
  if (full) {
    const [owner, repo] = full.split('/');
    if (!owner || !repo) throw new Error(`"${full}" is not an owner/repo name.`);
    return { owner, repo: repo.replace(/\.git$/, '') };
  }
  return { owner: project.owner, repo: project.repo };
}

/** Where the application for this PR is served. */
export function reviewBaseUrl(project: Project, prNumber: number | null, explicit?: string): string {
  if (explicit) return explicit;
  if (env.PR_PREVIEW_URL_TEMPLATE && prNumber !== null) {
    return env.PR_PREVIEW_URL_TEMPLATE.replace(/\{number\}/g, String(prNumber));
  }
  return project.testBaseUrl ?? env.TEST_BASE_URL;
}

/**
 * How recordings are referenced from the comment: served by this API when it
 * has a public URL, otherwise found in the CI run's uploaded artifacts, or on
 * disk.
 */
export function artifactLinker(runDir: string): ArtifactLinker {
  const exists = (file: string) => fs.existsSync(file);
  if (env.QA_PUBLIC_URL) {
    const publicUrl = env.QA_PUBLIC_URL;
    return {
      // Served by path, so the HTML report's relative links to videos and traces resolve.
      link: (file) => artifactFileUrl(publicUrl, file) ?? `${publicUrl}/api/artifacts?path=${encodeURIComponent(path.resolve(file))}`,
      where: 'Each link above opens the file from the QA server.',
      exists,
    };
  }
  const { GITHUB_ACTIONS, GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  if (GITHUB_ACTIONS === 'true' && GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID) {
    const name = process.env['QA_ARTIFACT_NAME'] ?? 'qa-recordings';
    return {
      link: () => null,
      exists,
      where: `Download the **${name}** artifact from [this workflow run](${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}); the file names above are paths inside it.`,
    };
  }
  return { link: () => null, exists, where: `They are stored on the QA server in \`${runDir}\`.` };
}

/** What changed between the head the previous review saw and this one. */
async function sinceLastReview(dir: string, previous: PrReview, headSha: string): Promise<SinceLastReview> {
  const failures = (previous.summary['failures'] as { test: string }[] | undefined) ?? [];
  let files: SinceLastReview['files'] = null;
  if (await commitExists(dir, previous.headSha)) {
    try {
      files = (await diffCommits(dir, previous.headSha, headSha, { maxPatchChars: 0 })).map((f) => ({ path: f.path, status: f.status }));
    } catch (e) {
      log.warn(`Could not diff the previous review's head: ${errorMessage(e)}`);
    }
  }
  return { previousHead: previous.headSha, previousVerdict: previous.status, files, previouslyFailed: failures.map((f) => f.test) };
}

export async function reviewPullRequest(opts: ReviewPullRequestOptions): Promise<PullRequestReviewResult> {
  const { project } = opts;
  if (opts.number === undefined && !opts.local) throw new Error('Give a pull request number, or local base and head refs.');

  const { owner, repo } = repoOf(project, opts.repoFullName);
  const secrets = await getProjectSecrets(project.id);
  const token = (await resolveCredential(secrets.githubToken)).token;

  /* -- 1. Read the pull request ---------------------------------------------- */
  let ctx: PullRequestContext;
  let headSpec: string;
  let baseSpec: string;
  const fetchRefs: string[] = [];

  if (opts.number !== undefined) {
    const pr = await getPullRequest(owner, repo, opts.number, token);
    ctx = { number: pr.number, title: pr.title, body: pr.body, url: pr.url, headRef: pr.headRef, baseRef: pr.baseRef };
    headSpec = pr.headSha;
    baseSpec = pr.baseSha;
    // A fork's commits are only reachable through the base repository's PR ref.
    if (!isLocalRepo(project.repoUrl)) fetchRefs.push(`+refs/pull/${pr.number}/head:refs/qa/pr/${pr.number}`);
    prLog.info(`Reviewing ${owner}/${repo}#${pr.number} "${pr.title}" (${pr.headRef} @ ${pr.headSha.slice(0, 8)}).`);
  } else {
    const local = opts.local!;
    ctx = {
      number: 0, title: local.title ?? `${local.head} into ${local.base}`, body: local.body ?? '',
      url: null, headRef: local.head, baseRef: local.base,
    };
    headSpec = local.head;
    baseSpec = local.base;
  }

  /* -- 2. Check out the head and find the merge base -------------------------- */
  const fetched = await checkoutRepository({
    projectId: project.id, repoUrl: project.repoUrl, branch: project.branch,
    projectToken: secrets.githubToken, fetchRefs,
  });
  const headSha = await resolveRef(fetched.dir, headSpec);
  if (!headSha) throw new Error(`The pull request head "${headSpec}" is not in ${owner}/${repo}. Was it force-pushed away?`);
  const baseTip = await resolveRef(fetched.dir, baseSpec);
  if (!baseTip) throw new Error(`The base "${baseSpec}" could not be resolved in ${owner}/${repo}.`);
  const baseSha = (await mergeBase(fetched.dir, baseTip, headSha)) ?? baseTip;

  // The working tree must hold the pull request's code *before* the
  // application is served from it: a build-and-serve start command would
  // otherwise build the base branch, and the tests would review code the
  // pull request does not contain. The pipeline checks out the same commit
  // again, which is then a no-op on an unchanged tree.
  const checkout = await checkoutRepository({
    projectId: project.id, repoUrl: project.repoUrl, branch: project.branch,
    projectToken: secrets.githubToken, commitish: headSha,
  });

  const previous = ctx.number ? await latestPrReview(project.id, ctx.number) : null;
  if (!opts.force && previous?.headSha === headSha && !['error', 'blocked', 'running', 'queued', 'cancelled'].includes(previous.status)) {
    const reason = `Head ${headSha.slice(0, 8)} of #${ctx.number} was already reviewed (${previous.status}).`;
    log.info(`${reason} Skipping; use force to review it again.`);
    return { review: previous, verdict: previous.status as ReviewVerdict, run: null, details: null, comment: '', commentUrl: previous.commentUrl, skipped: reason };
  }

  const review = await createPrReview({
    projectId: project.id, prNumber: ctx.number, repoFullName: `${owner}/${repo}`,
    title: ctx.title, baseSha, headSha, trigger: opts.trigger,
  });
  // Stopping the review aborts this; once the pipeline starts, its run is stopped too.
  const signal = registerCancellable(review.id);
  const postComment = opts.postComment ?? opts.number !== undefined;
  let commentId = previous?.commentId ?? null;
  let commentUrl = previous?.commentUrl ?? null;

  const post = async (body: string) => {
    if (!postComment || !ctx.number) return;
    try {
      const posted = await upsertPullRequestComment({ owner, repo, number: ctx.number, body, token, knownCommentId: commentId });
      githubLog.info(`PR comment ${posted.created ? 'posted' : 'updated'}: ${posted.url}`);
      commentId = String(posted.id);
      commentUrl = posted.url;
      await updatePrReview(review.id, { commentId, commentUrl });
    } catch (e) {
      // A review that ran is still worth keeping when the comment cannot be posted.
      githubLog.error(`Could not comment on #${ctx.number}: ${errorMessage(e)}`);
    }
  };

  const baseUrl = reviewBaseUrl(project, ctx.number || null, opts.baseUrl);
  const since = previous && previous.headSha !== headSha ? await sinceLastReview(checkout.dir, previous, headSha) : null;
  const startCommand = opts.startCommand === undefined ? env.PR_APP_START_COMMAND : opts.startCommand;

  /* -- 3. Serve the PR's build, then run the pipeline ------------------------- */
  const notes: string[] = [];
  let app: RunningApp | null = null;
  let run: RunSummary | null = null;
  let details: RunDetails | null = null;
  let failure: string | null = null;
  let runId: string | null = null;

  try {
    // A review signs in and submits forms: never against what looks like production.
    const unsafe = unsafeTargetReason(baseUrl, { allowedHosts: env.QA_ALLOWED_TEST_HOSTS, previewTemplate: env.PR_PREVIEW_URL_TEMPLATE });
    if (unsafe) throw new Error(unsafe);
    if (startCommand) {
      app = await startApp({ command: startCommand, cwd: checkout.dir, url: baseUrl, timeoutMs: env.PR_APP_START_TIMEOUT_MS });
      notes.push(`The pull request's own build was started for this review (${'`'}${startCommand}${'`'}).`);
      readyLog.info(`Application started from the pull request's build and answering at ${baseUrl}.`);
    } else if (!(await isReachable(baseUrl, 15_000))) {
      // Every browser step would fail as an environment problem; say so now instead.
      throw new Error(`Application readiness timeout: nothing answered at ${baseUrl} within 15s. Start the application, or configure PR_APP_START_COMMAND or a preview URL.`);
    } else {
      readyLog.info(`Application ready at ${baseUrl}.`);
      notes.push(`Reviewed against the application already served at ${baseUrl}; make sure it is this pull request's build.`);
    }

    throwIfCancelled(signal);
    const created = await createRun(project.id, 'full_cycle', ctx.headRef);
    runId = created.id;
    await updatePrReview(review.id, { runId });
    ({ run, details } = await executeRunDetailed({
      project, runId, mode: 'full_cycle',
      commitish: headSha, baseRef: baseSha, baseUrl,
      pullRequest: ctx, fullRegression: opts.fullRegression,
    }));
  } catch (e) {
    if (!isCancelled(e)) {
      failure = errorMessage(e);
      log.error(`Review of #${ctx.number} failed: ${failure}`);
    }
  } finally {
    await app?.stop().catch(() => {});
    releaseCancellable(review.id);
  }
  const cancelled = signal.aborted;
  if (cancelled) log.info(`Review of #${ctx.number} was stopped.`);

  /* -- 4. Report back --------------------------------------------------------- */
  const verdict = reviewVerdict(run, details, failure, cancelled);
  reportLog.info(`Status: ${verdict.toUpperCase()}${failure ? ` (${failure})` : ''}.`);
  const runDir = path.join(env.artifactRoot, project.id, 'runs', runId ?? 'none');
  // Nothing credential-shaped leaves this machine, wherever in the run it came from.
  const secretsToMask = secretValues(process.env, [
    ...Object.values(secrets.credentials ?? {}),
    // A login URL's query can be a CAPTCHA bypass token.
    ...[env.TEST_LOGIN_PATH, secrets.credentials?.['loginPath']].flatMap((p) => (p?.includes('?') ? [p.split('?')[1]!, p.split('?')[1]!.split('=').pop()!] : [])),
    ...(secrets.githubToken ? [secrets.githubToken] : []),
    ...(token ? [token] : []),
  ]);
  const comment = redactSecrets(renderPrComment({
    pr: ctx, run, details, baseUrl, artifacts: artifactLinker(runDir),
    error: failure, cancelled, notes, aiSource: details?.impact?.ai.source, sinceLastReview: since,
  }), secretsToMask);

  if (opts.commentFile) {
    fs.mkdirSync(path.dirname(path.resolve(opts.commentFile)), { recursive: true });
    fs.writeFileSync(opts.commentFile, comment, 'utf8');
  }
  // The pull request only hears about a review once it has a result; a
  // cancelled one has none, so nothing is posted for it.
  if (!cancelled) await post(comment);

  await updatePrReview(review.id, {
    status: verdict,
    commentMarkdown: comment,
    error: failure ?? run?.error ?? details?.executionError ?? null,
    summary: {
      verdict,
      execution: details?.execution ?? null,
      affectedModules: details?.impact?.affectedFeatures.map((f) => ({ key: f.key, risk: f.risk })) ?? [],
      testChanges: details?.testChanges ?? [],
      failures: details?.failures.map((f) => ({ test: f.testTitle, classification: f.classification })) ?? [],
      recordings: (details?.results.filter((r) => r.videoPath).length ?? 0)
        + (details?.exploration.pages.filter((p) => p.videoPath).length ?? 0),
    },
  });

  log.info(`Review of #${ctx.number} finished: ${verdict}${commentUrl ? ` (${commentUrl})` : ''}.`);
  return { review: { ...review, status: verdict, commentUrl, commentId }, verdict, run, details, comment, commentUrl };
}
