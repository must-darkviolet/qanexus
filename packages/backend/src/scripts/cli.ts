/**
 * Command-line interface for the pull-request QA service.
 *
 *   npm run qa -- projects
 *   npm run qa -- add <repo> [--name N] [--branch B] [--base-url URL]
 *   npm run qa -- pr  <project> --number N [--repo owner/name] [--base-url URL] [--start CMD]
 *                     [--no-comment] [--comment-file F] [--force] [--fail-on-failures]
 *   npm run qa -- pr  <project> --base REF --head REF [--title T] [--body B | --body-file F]
 *                     [--comment-file F]          (offline: nothing is posted)
 *                     [--full-regression]         (also run tier 3: every spec)
 *   npm run qa -- auth <project> [--role user] [--login-path /login] [--base-url URL]
 *                     Opens a browser to sign in by hand (e.g. through a CAPTCHA) and saves
 *                     the session every review then reuses until it expires.
 *   npm run qa -- auth <project> --check [--route /path]   (is the saved session or login working?)
 *   npm run qa -- ai-check [--provider gemini|claude-cli] [--live]
 *
 * <project> is a project id, its name, or its repository path/URL. For `pr`, an
 * unregistered local path is registered on the fly (useful in CI).
 */
import path from 'node:path';
import fs from 'node:fs';
import type { Project, RunSummary } from '@qa-agent/shared';
import { runMigrations } from '../db/migrate.js';
import { closeDb } from '../db/client.js';
import { createProject, getProjectSecrets, listProjects } from '../db/repos/projects.js';
import { env } from '../config/env.js';
import { reviewPullRequest } from '../pipeline/prReview.js';
import { errorMessage } from '../util/errors.js';
import { checkAIProvider } from '../ai/health.js';
import { captureSessionInteractively, establishAuthentication, sessionStatePath } from '../auth/session.js';
import { AI_PROVIDERS, type AiProviderName } from '../config/env.js';

const out = (line = '') => process.stdout.write(`${line}\n`);

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; }
    else flags[key] = true;
  }
  return { positional, flags };
}

const str = (v: string | boolean | undefined) => (typeof v === 'string' ? v : undefined);

/**
 * npm runs workspace scripts from the package directory, so a relative path
 * typed at the repository root is resolved against where the user ran npm.
 */
const invokedFrom = process.env['INIT_CWD'] ?? process.cwd();
const userPath = (p: string) => path.resolve(invokedFrom, p);
const existingPath = (p: string) => (fs.existsSync(userPath(p)) ? userPath(p) : null);

async function findProject(ref: string | undefined): Promise<Project> {
  const projects = await listProjects();
  if (!ref) {
    if (projects.length === 1) return projects[0]!;
    throw new Error('Specify a project (id, name or repository). Run "projects" to list them.');
  }
  const resolved = existingPath(ref) ?? ref;
  const match = projects.find((p) => p.id === ref || p.id.startsWith(ref) || p.name === ref || p.repoUrl === resolved || `${p.owner}/${p.repo}` === ref);
  if (!match) throw new Error(`No project matches "${ref}". Run "projects" to list them, or "add" to register one.`);
  return match;
}

function printRun(run: RunSummary): void {
  out(`Run ${run.id} ${run.status.toUpperCase()} (${run.mode})`);
  for (const step of run.steps) {
    if (step.status === 'pending') continue;
    const mark = step.status === 'completed' ? ' ok ' : step.status === 'skipped' ? 'skip' : step.status === 'failed' ? 'FAIL' : ' .. ';
    out(`  [${mark}] ${step.name.padEnd(24)} ${step.detail}`);
  }
  if (run.execution) {
    const e = run.execution;
    out(`\n  Tests: ${e.passed} passed, ${e.failed} failed, ${e.skipped + e.pending} skipped of ${e.total} (${Math.round(e.durationMs / 1000)}s)`);
  }
  if (run.error) out(`\n  Error: ${run.error}`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  await runMigrations();

  switch (command) {
    case 'projects': {
      const projects = await listProjects();
      if (!projects.length) out('No projects. Add one with: add <repo>');
      for (const p of projects) {
        out(`${p.id}  ${p.name.padEnd(24)} ${p.repoUrl} @ ${p.branch}  last: ${p.lastAnalyzedCommit?.slice(0, 8) ?? 'never'}`);
      }
      return;
    }
    case 'add': {
      const repo = positional[0];
      if (!repo) throw new Error('Usage: add <repo> [--name N] [--branch B] [--base-url URL]');
      const repoUrl = existingPath(repo) ?? repo;
      const project = await createProject({
        name: str(flags['name']) ?? path.basename(repoUrl).replace(/\.git$/, ''),
        repoUrl, branch: str(flags['branch']) ?? 'main', testBaseUrl: str(flags['base-url']),
      });
      out(`Added ${project.name} (${project.id}).`);
      return;
    }
    case 'pr': {
      const ref = positional[0];
      const number = str(flags['number']);
      const base = str(flags['base']);
      const head = str(flags['head']);
      if (!number && !(base && head)) {
        throw new Error('Usage: pr <project> --number N [...], or pr <project> --base REF --head REF [...]');
      }
      if (number !== undefined && !/^\d+$/.test(number)) throw new Error(`--number must be a pull request number, not "${number}".`);

      let project: Project;
      try {
        project = await findProject(ref);
      } catch (e) {
        const repoPath = ref ? existingPath(ref) : null;
        if (!repoPath) throw e;
        project = await createProject({
          name: path.basename(repoPath), repoUrl: repoPath,
          branch: str(flags['branch']) ?? 'main', testBaseUrl: str(flags['base-url']),
        });
        out(`Registered ${repoPath} as project ${project.name} (${project.id}).`);
      }

      const bodyFile = str(flags['body-file']);
      const commentFile = str(flags['comment-file']);
      const result = await reviewPullRequest({
        project, trigger: 'cli',
        ...(number ? { number: Number(number) } : {
          local: {
            base: base!, head: head!, title: str(flags['title']),
            body: bodyFile ? fs.readFileSync(userPath(bodyFile), 'utf8') : str(flags['body']),
          },
        }),
        repoFullName: str(flags['repo']),
        baseUrl: str(flags['base-url']),
        ...(flags['start'] !== undefined ? { startCommand: str(flags['start']) ?? null } : {}),
        postComment: number ? !flags['no-comment'] : false,
        commentFile: commentFile ? userPath(commentFile) : undefined,
        force: Boolean(flags['force']),
        fullRegression: Boolean(flags['full-regression']),
      });

      if (result.skipped) { out(result.skipped); return; }
      if (result.run) printRun(result.run);
      out(`\nVerdict: ${result.verdict}`);
      if (result.commentUrl) out(`Comment: ${result.commentUrl}`);
      if (commentFile) out(`Comment written to ${userPath(commentFile)}`);
      if (!result.commentUrl && !commentFile) out(`\n${result.comment}`);
      // Unverified is not success: a blocked or failed review fails the command.
      if (result.verdict === 'error' || result.verdict === 'blocked' || (flags['fail-on-failures'] && (result.verdict === 'failed' || result.verdict === 'partial'))) process.exitCode = 1;
      return;
    }
    case 'auth': {
      const project = await findProject(positional[0]);
      const role = str(flags['role']) ?? 'user';
      const baseUrl = str(flags['base-url']) ?? project.testBaseUrl ?? env.TEST_BASE_URL;
      const creds = (await getProjectSecrets(project.id)).credentials ?? {};
      const statePath = sessionStatePath(project.id, role);
      if (flags['check']) {
        const check = await establishAuthentication({
          baseUrl, routes: [str(flags['route']) ?? '/'], role, statePath,
          credentials: { email: creds[`${role}Email`] || (role === 'admin' ? env.TEST_ADMIN_EMAIL : env.TEST_USER_EMAIL), password: creds[`${role}Password`] || (role === 'admin' ? env.TEST_ADMIN_PASSWORD : env.TEST_USER_PASSWORD) },
          loginPath: str(flags['login-path']) ?? creds['loginPath'] ?? env.TEST_LOGIN_PATH,
          evidenceDir: path.join(env.artifactRoot, project.id, 'auth-check'),
        });
        out(`${check.state}: ${check.reason}`);
        if (check.evidence.screenshot) out(`Screenshot: ${check.evidence.screenshot}`);
        if (check.state !== 'VERIFIED' && check.state !== 'NOT_REQUIRED') process.exitCode = 1;
        return;
      }
      const result = await captureSessionInteractively({
        baseUrl, statePath, timeoutMs: 5 * 60_000,
        loginPath: str(flags['login-path']) ?? creds['loginPath'] ?? env.TEST_LOGIN_PATH ?? '/login',
      });
      out(result.reason);
      if (result.saved) out(`Reviews of ${project.name} will reuse this ${role} session until it expires. Check it with: npm run qa -- auth ${project.id} --check --route <protected route>`);
      else process.exitCode = 1;
      return;
    }
    case 'ai-check': {
      // --live sends one tiny request; without it no model call is made.
      const provider = str(flags['provider']);
      if (provider && !(AI_PROVIDERS as readonly string[]).includes(provider)) {
        throw new Error(`Unknown provider "${provider}". Use one of: ${AI_PROVIDERS.join(', ')}.`);
      }
      const health = await checkAIProvider(provider as AiProviderName | undefined, { live: Boolean(flags['live']) });
      out(JSON.stringify(health, null, 2));
      if (!health.available) process.exitCode = 1;
      return;
    }
    default:
      out(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]!.replace(/^\/\*\*?|^ \* ?/gm, ''));
      if (command) process.exitCode = 1;
  }
}

main()
  .catch((e) => { process.stderr.write(`Error: ${errorMessage(e)}\n`); process.exitCode = 1; })
  .finally(() => { void closeDb().then(() => process.exit()); });
