/**
 * Project records.
 *
 * GitHub tokens and test credentials are encrypted at rest and are never
 * included in anything returned to the API layer (spec sections 2 and 27) -
 * the public `Project` shape only exposes whether a secret exists.
 */
import type { Project, ProjectInput } from '@qa-agent/shared';
import { getDb, toBool } from '../client.js';
import { uuid } from '../../util/ids.js';
import { canEncrypt, decrypt, encrypt } from '../../util/crypto.js';
import { assertLooksLikeToken, parseRepoUrl } from '../../github/auth.js';
import { badRequest, notFound } from '../../util/errors.js';

const now = () => new Date().toISOString();

function rowToProject(row: Record<string, unknown>): Project {
  return {
    id: String(row['id']),
    name: String(row['name']),
    repoUrl: String(row['repo_url']),
    owner: String(row['owner']),
    repo: String(row['repo']),
    branch: String(row['branch']),
    commitish: (row['commitish'] as string | null) ?? null,
    testBaseUrl: (row['test_base_url'] as string | null) ?? null,
    isPrivate: toBool(row['is_private']),
    lastAnalyzedCommit: (row['last_analyzed_commit'] as string | null) ?? null,
    lastAnalyzedAt: (row['last_analyzed_at'] as string | null) ?? null,
    hasStoredToken: Boolean(row['github_token_enc']),
    hasStoredCredentials: Boolean(row['credentials_enc']),
    createdAt: String(row['created_at']),
  };
}

export async function createProject(input: ProjectInput): Promise<Project> {
  const db = await getDb();
  const { owner, repo, url } = parseRepoUrl(input.repoUrl);

  const existing = await db.one<Record<string, unknown>>(
    'SELECT * FROM projects WHERE repo_url = ? AND branch = ?', [url, input.branch],
  );
  if (existing) return rowToProject(existing);

  let tokenEnc: string | null = null;
  if (input.githubToken) {
    // Refuse a password outright; the spec forbids ever asking for one.
    assertLooksLikeToken(input.githubToken);
    if (!canEncrypt()) {
      throw badRequest(
        'A GitHub token was supplied but CREDENTIAL_ENCRYPTION_KEY is not configured, ' +
        'so it cannot be stored securely. Set the key, or leave the token out and use GITHUB_TOKEN in the server environment.',
      );
    }
    tokenEnc = encrypt(input.githubToken);
  }

  let credentialsEnc: string | null = null;
  if (input.credentials && Object.keys(input.credentials).length > 0) {
    if (!canEncrypt()) {
      throw badRequest('Test credentials were supplied but CREDENTIAL_ENCRYPTION_KEY is not configured.');
    }
    credentialsEnc = encrypt(JSON.stringify(input.credentials));
  }

  const id = uuid();
  await db.run(
    `INSERT INTO projects (id, name, repo_url, owner, repo, branch, commitish, test_base_url, is_private,
       github_token_enc, credentials_enc, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.name, url, owner, repo, input.branch, input.commitish ?? null,
     input.testBaseUrl ?? null, tokenEnc ? 1 : 0, tokenEnc, credentialsEnc, now(), now()],
  );

  const row = await db.one<Record<string, unknown>>('SELECT * FROM projects WHERE id = ?', [id]);
  return rowToProject(row!);
}

export async function listProjects(): Promise<Project[]> {
  const db = await getDb();
  const rows = await db.query<Record<string, unknown>>('SELECT * FROM projects ORDER BY created_at DESC');
  return rows.map(rowToProject);
}

export async function getProject(id: string): Promise<Project | null> {
  const db = await getDb();
  const row = await db.one<Record<string, unknown>>('SELECT * FROM projects WHERE id = ?', [id]);
  return row ? rowToProject(row) : null;
}

export async function requireProject(id: string): Promise<Project> {
  const project = await getProject(id);
  if (!project) throw notFound(`Project ${id} was not found.`);
  return project;
}

export async function updateProject(id: string, patch: Partial<ProjectInput>): Promise<Project> {
  const db = await getDb();
  await requireProject(id);

  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (column: string, value: unknown) => { sets.push(`${column} = ?`); params.push(value); };

  if (patch.name !== undefined) set('name', patch.name);
  if (patch.branch !== undefined) set('branch', patch.branch);
  if (patch.commitish !== undefined) set('commitish', patch.commitish || null);
  if (patch.testBaseUrl !== undefined) set('test_base_url', patch.testBaseUrl || null);
  if (patch.githubToken !== undefined) {
    if (patch.githubToken) {
      assertLooksLikeToken(patch.githubToken);
      if (!canEncrypt()) throw badRequest('CREDENTIAL_ENCRYPTION_KEY is not configured.');
      set('github_token_enc', encrypt(patch.githubToken));
      set('is_private', 1);
    } else {
      // Empty string means "revoke this project's stored access" (spec section 27).
      set('github_token_enc', null);
    }
  }
  if (patch.credentials !== undefined) {
    if (patch.credentials && Object.keys(patch.credentials).length) {
      if (!canEncrypt()) throw badRequest('CREDENTIAL_ENCRYPTION_KEY is not configured.');
      set('credentials_enc', encrypt(JSON.stringify(patch.credentials)));
    } else {
      set('credentials_enc', null);
    }
  }

  if (sets.length) {
    set('updated_at', now());
    await db.run(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
  }
  return (await getProject(id))!;
}

export async function recordAnalyzedCommit(projectId: string, commitSha: string): Promise<void> {
  const db = await getDb();
  await db.run(
    'UPDATE projects SET last_analyzed_commit = ?, last_analyzed_at = ?, updated_at = ? WHERE id = ?',
    [commitSha, now(), now(), projectId],
  );
}

/** Server-side only. Never call this from a route handler's response path. */
export async function getProjectSecrets(projectId: string): Promise<{ githubToken: string | null; credentials: Record<string, string> }> {
  const db = await getDb();
  const row = await db.one<{ github_token_enc: string | null; credentials_enc: string | null }>(
    'SELECT github_token_enc, credentials_enc FROM projects WHERE id = ?', [projectId],
  );
  if (!row) return { githubToken: null, credentials: {} };

  let githubToken: string | null = null;
  let credentials: Record<string, string> = {};
  try { if (row.github_token_enc) githubToken = decrypt(row.github_token_enc); } catch { githubToken = null; }
  try { if (row.credentials_enc) credentials = JSON.parse(decrypt(row.credentials_enc)) as Record<string, string>; } catch { credentials = {}; }
  return { githubToken, credentials };
}

export async function deleteProject(id: string): Promise<void> {
  const db = await getDb();
  // Cascade by hand so the schema stays portable across both engines.
  for (const table of [
    'pr_reviews', 'impact_reports',
    'evidence', 'failures', 'test_results', 'healing_proposals', 'traceability',
    'generated_tests', 'scenarios', 'business_rules', 'app_map', 'features',
    'applications', 'repo_changes', 'repo_snapshots', 'memory_entries',
    'ai_cache', 'ai_usage', 'file_analysis_cache', 'reports', 'runs',
  ]) {
    await db.run(`DELETE FROM ${table} WHERE project_id = ?`, [id]).catch(() => {});
  }
  await db.run('DELETE FROM projects WHERE id = ?', [id]);
}
