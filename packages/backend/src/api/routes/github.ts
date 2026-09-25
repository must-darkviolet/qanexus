/**
 * GitHub integration endpoints.
 *
 *   POST /api/github/webhook                     pull_request events -> PR review
 *   GET  /api/projects/:id/pull-requests         reviews recorded for a project
 *   POST /api/projects/:id/pull-requests/:number/review   review a PR on demand
 *   POST /api/projects/:id/pull-requests/:reviewId/stop   stop a review in progress
 *
 * The webhook is mounted before the JSON body parser: its signature is
 * computed over the raw bytes GitHub sent, so they must reach it untouched.
 */
import fs from 'node:fs';
import path from 'node:path';
import express, { Router } from 'express';
import type { Project } from '@qa-agent/shared';
import { createLogger } from '../../util/logger.js';
import { errorMessage } from '../../util/errors.js';
import { asyncHandler } from '../middleware.js';
import { listProjects, requireProject } from '../../db/repos/projects.js';
import { getPrReview, listPrReviews, updatePrReview } from '../../db/repos/prReviews.js';
import { getRun, RunStepTracker, updateRun } from '../../db/repos/runs.js';
import { listTestResults, listFailures } from '../../knowledge/evidence.js';
import { env } from '../../config/env.js';
import { conflict, notFound } from '../../util/errors.js';
import { STOPPED_MESSAGE, cancel } from '../../util/cancellation.js';
import { verifyWebhookSignature } from '../../github/pullRequests.js';
import { reviewPullRequest } from '../../pipeline/prReview.js';
import { enqueueTask } from '../runQueue.js';

const log = createLogger('github-webhook');

interface PullRequestEvent {
  action?: string;
  number?: number;
  pull_request?: {
    number: number; draft?: boolean; state?: string;
    head?: { sha?: string; repo?: { full_name?: string } | null };
  };
  repository?: { full_name?: string; clone_url?: string; html_url?: string };
}

/** True when the pull request's branch lives in another repository (a fork). */
export function isFork(payload: PullRequestEvent): boolean {
  const head = payload.pull_request?.head?.repo?.full_name?.toLowerCase();
  const base = payload.repository?.full_name?.toLowerCase();
  return Boolean(head && base && head !== base);
}

/** Finds the registered project a delivery is about, by owner/repo or clone URL. */
export function matchProject(projects: Project[], repository: PullRequestEvent['repository']): Project | null {
  const fullName = repository?.full_name?.toLowerCase();
  const urls = [repository?.clone_url, repository?.html_url].filter(Boolean).map((u) => u!.toLowerCase().replace(/\.git$/, ''));
  return projects.find((p) => `${p.owner}/${p.repo}`.toLowerCase() === fullName)
    ?? projects.find((p) => urls.includes(p.repoUrl.toLowerCase().replace(/\.git$/, '')))
    ?? null;
}

function queueReview(project: Project, number: number, trigger: 'webhook' | 'api', force: boolean): boolean {
  return enqueueTask(project, `review of #${number}`, async () => {
    try {
      await reviewPullRequest({ project, number, trigger, force });
    } catch (e) {
      log.error(`Review of ${project.owner}/${project.repo}#${number} failed: ${errorMessage(e)}`);
    }
  });
}

export const githubWebhookRouter = Router();

githubWebhookRouter.post('/webhook', express.raw({ type: '*/*', limit: '10mb' }), asyncHandler(async (req, res) => {
  if (!env.GITHUB_WEBHOOK_SECRET) {
    res.status(503).json({ error: { code: 'not_configured', message: 'Set GITHUB_WEBHOOK_SECRET to accept GitHub webhooks.' } });
    return;
  }
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (!verifyWebhookSignature(env.GITHUB_WEBHOOK_SECRET, raw, req.header('x-hub-signature-256'))) {
    res.status(401).json({ error: { code: 'bad_signature', message: 'The webhook signature does not match.' } });
    return;
  }

  const event = req.header('x-github-event');
  if (event === 'ping') { res.json({ ok: true, pong: true }); return; }
  if (event !== 'pull_request') { res.status(202).json({ ignored: `event "${event}"` }); return; }

  let payload: PullRequestEvent;
  try { payload = JSON.parse(raw.toString('utf8')) as PullRequestEvent; }
  catch { res.status(400).json({ error: { code: 'bad_payload', message: 'The payload is not JSON.' } }); return; }

  const action = payload.action ?? '';
  const pr = payload.pull_request;
  const wanted = env.PR_REVIEW_ACTIONS.split(',').map((a) => a.trim()).filter(Boolean);
  if (!pr || !wanted.includes(action)) { res.status(202).json({ ignored: `action "${action}"` }); return; }
  if (pr.draft && action !== 'ready_for_review') { res.status(202).json({ ignored: 'draft pull request' }); return; }
  // Reviewing a fork means building and serving code written by whoever opened
  // the pull request, on this machine. That is opt-in, never the default.
  if (isFork(payload) && !env.PR_REVIEW_FORKS) {
    log.warn(`Ignoring ${payload.repository?.full_name}#${pr.number}: it comes from a fork and PR_REVIEW_FORKS is not set.`);
    res.status(202).json({ ignored: 'pull request from a fork (set PR_REVIEW_FORKS=1 to review them)' });
    return;
  }
  if (pr.state && pr.state !== 'open') { res.status(202).json({ ignored: `pull request is ${pr.state}` }); return; }

  const project = matchProject(await listProjects(), payload.repository);
  if (!project) {
    res.status(202).json({ ignored: `no project is registered for ${payload.repository?.full_name ?? 'this repository'}` });
    return;
  }

  const queued = queueReview(project, pr.number, 'webhook', action === 'reopened');
  if (queued) log.info(`Queued review of ${project.owner}/${project.repo}#${pr.number} (${action}).`);
  res.status(202).json({
    queued, project: project.id, pullRequest: pr.number,
    ...(queued ? {} : { note: 'a review of this pull request is already queued; it will pick up the latest head' }),
  });
}));

export const pullRequestsRouter = Router();

pullRequestsRouter.get('/:id/pull-requests', asyncHandler(async (req, res) => {
  const project = await requireProject(req.params.id!);
  res.json({ reviews: await listPrReviews(project.id) });
}));

/** Everything one review produced: its steps, results, failures and recordings. */
pullRequestsRouter.get('/:id/pull-requests/:reviewId', asyncHandler(async (req, res) => {
  const project = await requireProject(req.params.id!);
  const review = await getPrReview(req.params.reviewId!);
  if (!review || review.projectId !== project.id) throw notFound('No such review.');

  const run = review.runId ? await getRun(review.runId) : null;
  const results = review.runId ? await listTestResults(review.runId) : [];
  const failures = review.runId ? await listFailures({ runId: review.runId }) : [];

  res.json({
    review, run, results, failures,
    recordings: review.runId ? listRecordings(project.id, review.runId) : [],
  });
}));

pullRequestsRouter.post('/:id/pull-requests/:number/review', asyncHandler(async (req, res) => {
  const project = await requireProject(req.params.id!);
  const number = Number(req.params.number);
  if (!Number.isInteger(number) || number <= 0) {
    res.status(400).json({ error: { code: 'bad_request', message: 'The pull request number must be a positive integer.' } });
    return;
  }
  const force = Boolean((req.body as { force?: unknown } | undefined)?.force);
  const queued = queueReview(project, number, 'api', force);
  res.status(202).json({ queued, project: project.id, pullRequest: number });
}));

/**
 * Stops a review in progress. One this process is running is aborted and
 * records its own outcome; one nothing is running any more (the API restarted
 * part-way through) is marked stopped here, or it would show as running forever.
 */
pullRequestsRouter.post('/:id/pull-requests/:reviewId/stop', asyncHandler(async (req, res) => {
  const project = await requireProject(req.params.id!);
  const review = await getPrReview(req.params.reviewId!);
  if (!review || review.projectId !== project.id) throw notFound('No such review.');
  if (review.status !== 'running' && review.status !== 'queued') throw conflict(`This review already finished (${review.status}).`);

  const stoppedReview = cancel(review.id);
  const stoppedRun = review.runId ? cancel(review.runId) : false;
  if (stoppedReview || stoppedRun) {
    log.info(`Stopping the review of ${review.repoFullName}#${review.prNumber}.`);
    res.status(202).json({ stopped: 'live' });
    return;
  }

  const reason = `${STOPPED_MESSAGE} No process was running it any more; the API most likely restarted while it was in progress.`;
  const run = review.runId ? await getRun(review.runId) : null;
  if (run && (run.status === 'running' || run.status === 'queued')) {
    await new RunStepTracker(run.id, run.steps).stopRunning(STOPPED_MESSAGE);
    await updateRun(run.id, { status: 'cancelled', error: reason, finished: true });
  }
  await updatePrReview(review.id, { status: 'cancelled', error: reason });
  log.info(`Marked the abandoned review of ${review.repoFullName}#${review.prNumber} as stopped.`);
  res.json({ stopped: 'abandoned' });
}));

/**
 * The video, screenshot and trace files a run wrote. Paths are returned as the
 * artifacts endpoint expects them, so the UI can play them directly.
 */
function listRecordings(projectId: string, runId: string): { name: string; path: string; kind: string; sizeBytes: number }[] {
  const root = path.join(env.artifactRoot, projectId, 'runs', runId);
  const out: { name: string; path: string; kind: string; sizeBytes: number }[] = [];
  const walk = (dir: string, prefix: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full, `${prefix}${entry.name}/`); continue; }
      const kind = entry.name.endsWith('.webm') ? 'video'
        : entry.name.endsWith('.png') ? 'screenshot'
        : entry.name.endsWith('.zip') ? 'trace' : 'other';
      if (kind === 'other') continue;
      let sizeBytes = 0;
      try { sizeBytes = fs.statSync(full).size; } catch { /* vanished */ }
      out.push({ name: `${prefix}${entry.name}`, path: full, kind, sizeBytes });
    }
  };
  walk(root, '');
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
