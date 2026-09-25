/** Pull-request reviews: which PR head was reviewed, by which run, and where the comment is. */
import { fromJson, getDb } from '../client.js';
import { uuid } from '../../util/ids.js';

const now = () => new Date().toISOString();

export type PrReviewStatus = 'queued' | 'running' | 'passed' | 'failed' | 'blocked' | 'partial' | 'no_tests' | 'error' | 'cancelled';
export type PrReviewTrigger = 'webhook' | 'cli' | 'api';

export interface PrReview {
  id: string;
  projectId: string;
  prNumber: number;
  repoFullName: string;
  title: string;
  baseSha: string | null;
  headSha: string;
  runId: string | null;
  status: PrReviewStatus;
  trigger: PrReviewTrigger;
  commentId: string | null;
  commentUrl: string | null;
  /** The comment this review produced, readable without going to GitHub. */
  commentMarkdown: string | null;
  summary: Record<string, unknown>;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

function rowToReview(row: Record<string, unknown>): PrReview {
  return {
    id: String(row['id']),
    projectId: String(row['project_id']),
    prNumber: Number(row['pr_number']),
    repoFullName: String(row['repo_full_name']),
    title: String(row['title'] ?? ''),
    baseSha: (row['base_sha'] as string | null) ?? null,
    headSha: String(row['head_sha']),
    runId: (row['run_id'] as string | null) ?? null,
    status: row['status'] as PrReviewStatus,
    trigger: row['trigger'] as PrReviewTrigger,
    commentId: (row['comment_id'] as string | null) ?? null,
    commentUrl: (row['comment_url'] as string | null) ?? null,
    commentMarkdown: (row['comment_markdown'] as string | null) ?? null,
    summary: fromJson<Record<string, unknown>>(row['summary_json'], {}),
    error: (row['error'] as string | null) ?? null,
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
  };
}

export async function createPrReview(input: {
  projectId: string; prNumber: number; repoFullName: string; title: string;
  baseSha: string | null; headSha: string; trigger: PrReviewTrigger;
}): Promise<PrReview> {
  const db = await getDb();
  const id = uuid();
  await db.run(
    `INSERT INTO pr_reviews (id, project_id, pr_number, repo_full_name, title, base_sha, head_sha, status, trigger, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
    [id, input.projectId, input.prNumber, input.repoFullName, input.title, input.baseSha, input.headSha, input.trigger, now(), now()],
  );
  return (await getPrReview(id))!;
}

export async function updatePrReview(id: string, patch: Partial<Pick<PrReview,
  'runId' | 'status' | 'commentId' | 'commentUrl' | 'commentMarkdown' | 'summary' | 'error' | 'baseSha'>>): Promise<void> {
  const columns: Record<string, unknown> = {
    run_id: patch.runId, status: patch.status, comment_id: patch.commentId, comment_url: patch.commentUrl,
    comment_markdown: patch.commentMarkdown,
    summary_json: patch.summary === undefined ? undefined : JSON.stringify(patch.summary),
    error: patch.error, base_sha: patch.baseSha,
  };
  const set = Object.entries(columns).filter(([, v]) => v !== undefined);
  if (set.length === 0) return;
  const db = await getDb();
  await db.run(
    `UPDATE pr_reviews SET ${set.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
    [...set.map(([, v]) => v), now(), id],
  );
}

export async function getPrReview(id: string): Promise<PrReview | null> {
  const db = await getDb();
  const row = await db.one<Record<string, unknown>>('SELECT * FROM pr_reviews WHERE id = ?', [id]);
  return row ? rowToReview(row) : null;
}

export async function listPrReviews(projectId: string, limit = 50): Promise<PrReview[]> {
  const db = await getDb();
  const rows = await db.query<Record<string, unknown>>(
    'SELECT * FROM pr_reviews WHERE project_id = ? ORDER BY created_at DESC LIMIT ?', [projectId, limit],
  );
  return rows.map(rowToReview);
}

/** The latest review of a PR, any head - its comment id is reused so one comment is kept. */
export async function latestPrReview(projectId: string, prNumber: number, headSha?: string): Promise<PrReview | null> {
  const db = await getDb();
  const row = await db.one<Record<string, unknown>>(
    `SELECT * FROM pr_reviews WHERE project_id = ? AND pr_number = ?${headSha ? ' AND head_sha = ?' : ''}
     ORDER BY created_at DESC LIMIT 1`,
    headSha ? [projectId, prNumber, headSha] : [projectId, prNumber],
  );
  return row ? rowToReview(row) : null;
}
