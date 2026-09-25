/**
 * Serial run queue.
 *
 * A run clones a repository, runs Playwright and calls an AI provider, so running
 * several at once on one machine is a recipe for flaky results and blown rate
 * limits. Runs are queued per project and executed one at a time.
 */
import type { Project, RunMode, RunSummary } from '@qa-agent/shared';
import { createRun, getRun, updateRun } from '../db/repos/runs.js';
import { executeRun } from '../pipeline/orchestrator.js';
import { createLogger } from '../util/logger.js';
import { errorMessage } from '../util/errors.js';

const log = createLogger('queue');

interface QueuedJob {
  /** Set for pipeline runs, which can be cancelled while still queued. */
  runId: string | null;
  label: string;
  execute: () => Promise<unknown>;
}

const queues = new Map<string, QueuedJob[]>();
const running = new Set<string>();

export async function enqueueRun(project: Project, mode: RunMode, opts?: { force?: boolean; baseRef?: string }): Promise<RunSummary> {
  const run = await createRun(project.id, mode, project.branch);
  const force = opts?.force ?? false;
  const baseRef = opts?.baseRef?.trim() || undefined;
  push(project, {
    runId: run.id,
    label: `run ${run.id.slice(0, 8)} (${mode})`,
    execute: async () => {
      try {
        await executeRun({ project, runId: run.id, mode, force, baseRef });
      } catch (e) {
        // executeRun already records failures; this is the last-resort guard.
        await updateRun(run.id, { status: 'failed', error: errorMessage(e), finished: true }).catch(() => {});
        throw e;
      }
    },
  });
  return run;
}

/**
 * Queues other work that must not overlap a run of the same project - a
 * pull-request review checks out the same workspace and suite.
 *
 * Identical pending work is collapsed: three pushes to one pull request in a
 * minute should queue one review of its latest head, not three of them.
 */
export function enqueueTask(project: Project, label: string, execute: () => Promise<unknown>): boolean {
  if ((queues.get(project.id) ?? []).some((job) => job.label === label)) {
    log.info(`${label} is already queued for ${project.owner}/${project.repo}; not queuing it again.`);
    return false;
  }
  push(project, { runId: null, label, execute });
  return true;
}

function push(project: Project, job: QueuedJob): void {
  const queue = queues.get(project.id) ?? [];
  queue.push(job);
  queues.set(project.id, queue);
  log.info(`Queued ${job.label} for ${project.owner}/${project.repo}. Queue depth: ${queue.length}.`);
  void drain(project.id);
}

async function drain(projectId: string): Promise<void> {
  if (running.has(projectId)) return;
  running.add(projectId);

  try {
    for (;;) {
      const queue = queues.get(projectId) ?? [];
      const job = queue.shift();
      queues.set(projectId, queue);
      if (!job) break;

      try {
        await job.execute();
      } catch (e) {
        log.error(`${job.label} threw outside its own handler.`, e);
      }
    }
  } finally {
    running.delete(projectId);
  }
}

export function queueDepth(projectId: string): number {
  return (queues.get(projectId) ?? []).length + (running.has(projectId) ? 1 : 0);
}

export async function cancelQueued(runId: string): Promise<boolean> {
  for (const [projectId, queue] of queues) {
    const index = queue.findIndex((j) => j.runId === runId);
    if (index === -1) continue;
    queue.splice(index, 1);
    queues.set(projectId, queue);
    await updateRun(runId, { status: 'cancelled', finished: true });
    log.info(`Cancelled queued run ${runId.slice(0, 8)}.`);
    return true;
  }
  // A run already executing is stopped through util/cancellation instead, and
  // one that already finished has nothing to cancel.
  return false;
}
