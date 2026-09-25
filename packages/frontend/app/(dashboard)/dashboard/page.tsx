'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Shell, type SystemStatus } from '@/components/Shell';
import { Badge, EmptyState, Loading, Modal, Notice, PageHeader, Panel, StatCard, Toast } from '@/components/ui';
import { IconBranch, IconGit, IconPlus, IconShield, IconPlay, IconSettings, IconX } from '@/components/icons';
import { errorText } from '@/lib/format';

interface Project {
  id: string; name: string; repoUrl: string; owner: string; repo: string;
  branch: string; testBaseUrl: string | null; isPrivate: boolean; lastAnalyzedCommit: string | null;
  hasStoredToken: boolean;
}

export default function HomePage() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [form, setForm] = useState({ repoUrl: '', name: '', branch: 'main', testBaseUrl: '', githubToken: '' });
  const [editing, setEditing] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setProjects((await api.get<{ projects: Project[] }>('/projects')).projects);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
    api.get<SystemStatus>('/system/status').then(setStatus).catch(() => setStatus(null));
  }, [load]);

  const connect = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form.repoUrl.trim()) { setError('Give a repository: github.com/you/app, you/app, or a local path.'); return; }
    setConnecting(true);
    setError(null);
    try {
      await api.post('/projects', {
        repoUrl: form.repoUrl.trim(),
        name: form.name.trim() || form.repoUrl.trim().split('/').pop()!.replace(/\.git$/, ''),
        branch: form.branch.trim() || 'main',
        ...(form.testBaseUrl.trim() ? { testBaseUrl: form.testBaseUrl.trim() } : {}),
        ...(form.githubToken.trim() ? { githubToken: form.githubToken.trim() } : {}),
      });
      setForm({ repoUrl: '', name: '', branch: 'main', testBaseUrl: '', githubToken: '' });
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setConnecting(false);
    }
  };

  return (
    <Shell>
      <PageHeader
        title="Repositories"
        description="Each repository here gets its pull requests reviewed: the diff is analysed, the affected tests are written or updated, Playwright runs them with the browser recorded, and the result is posted as one comment on the pull request."
      />

      {error && <Notice tone="bad" onClose={() => setError(null)}>{error}</Notice>}

      {status && (
        <div className="grid cols-3" style={{ marginBottom: 20 }}>
          <StatCard
            label="Webhook" value={status.pullRequests.webhookConfigured ? 'Listening' : 'Not configured'}
            sub={status.pullRequests.webhookConfigured
              ? `on ${status.pullRequests.reviewActions.join(', ')}`
              : 'set GITHUB_WEBHOOK_SECRET to accept deliveries'}
            icon={<IconShield />} tone={status.pullRequests.webhookConfigured ? 'ok' : 'warn'}
          />
          <StatCard
            label="Browser" value={status.execution.playwrightAvailable ? status.execution.browser : 'Unavailable'}
            sub={status.execution.playwrightAvailable
              ? `recording: ${status.execution.video}`
              : 'run: npm run playwright:install'}
            icon={<IconPlay />} tone={status.execution.playwrightAvailable ? 'ok' : 'bad'}
          />
          <StatCard
            label="Analysis" value={status.ai.disabled || !status.ai.configured ? 'Deterministic' : status.ai.provider}
            sub={status.ai.disabled || !status.ai.configured
              ? 'no AI provider: rules and tests come from the code alone'
              : status.ai.model ?? ''}
            icon={<IconBranch />} tone={status.ai.configured && !status.ai.disabled ? 'ok' : undefined}
          />
        </div>
      )}

      {projects === null ? <Loading /> : projects.length === 0 ? (
        <div className="card" style={{ marginBottom: 20 }}>
          <EmptyState
            icon={<IconGit size={20} />}
            title="No repository connected yet"
            description="Connect one below. A local path works too, which is the quickest way to try a review without touching GitHub."
          />
        </div>
      ) : (
        <Panel flush>
          <table className="table">
            <thead>
              <tr><th>Repository</th><th>Branch</th><th>Application under test</th><th>Last reviewed commit</th><th /></tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id}>
                  <td>
                    <a href={`/projects/${p.id}`}><strong>{p.name}</strong></a>
                    <div className="muted mono" style={{ fontSize: 12 }}>{p.repoUrl}</div>
                  </td>
                  <td><Badge mono>{p.branch}</Badge></td>
                  <td className="mono">{p.testBaseUrl ?? <span className="muted">default</span>}</td>
                  <td className="mono">{p.lastAnalyzedCommit ? p.lastAnalyzedCommit.slice(0, 8) : <span className="muted">never</span>}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button type="button" className="ghost" onClick={() => setEditing(p)} title={`Edit ${p.name}`}>
                      <IconSettings size={14} /> Edit
                    </button>{' '}
                    <button type="button" className="ghost" style={{ color: 'var(--bad)' }} onClick={() => setDeleting(p)} title={`Delete ${p.name}`}>
                      <IconX size={14} /> Delete
                    </button>{' '}
                    <a className="ghost" href={`/projects/${p.id}`}>Pull requests →</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      {editing && (
        <EditProjectModal
          project={editing}
          onClose={() => setEditing(null)}
          onSaved={async (name) => { setEditing(null); setToast(`Saved ${name}.`); await load(); }}
        />
      )}
      {deleting && (
        <DeleteProjectModal
          project={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={async (name) => { setDeleting(null); setToast(`Removed ${name}.`); await load(); }}
        />
      )}
      <Toast message={toast} onDone={() => setToast(null)} />

      <Panel title="Connect a repository" icon={<IconPlus />} hint="A GitHub URL, owner/name, or a path on this machine.">
        <form onSubmit={connect} className="stack">
          <div className="grid cols-2">
            <label className="field">
              <span>Repository</span>
              <input value={form.repoUrl} onChange={(e) => setForm({ ...form, repoUrl: e.target.value })}
                placeholder="github.com/you/app  ·  you/app  ·  /path/to/app" />
            </label>
            <label className="field">
              <span>Name <small className="muted">optional</small></span>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="taken from the repository" />
            </label>
            <label className="field">
              <span>Branch</span>
              <input value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })} placeholder="main" />
            </label>
            <label className="field">
              <span>Application URL <small className="muted">where its tests run</small></span>
              <input value={form.testBaseUrl} onChange={(e) => setForm({ ...form, testBaseUrl: e.target.value })} placeholder="http://localhost:3000" />
            </label>
            <label className="field" style={{ gridColumn: '1 / -1' }}>
              <span>GitHub token <small className="muted">private repositories, and to post the comment (Pull requests: write)</small></span>
              <input type="password" value={form.githubToken} onChange={(e) => setForm({ ...form, githubToken: e.target.value })}
                placeholder="ghp_… — stored encrypted, never shown again" autoComplete="off" />
            </label>
          </div>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="submit" className="primary" disabled={connecting}>
              {connecting ? 'Connecting…' : 'Connect repository'}
            </button>
          </div>
        </form>
      </Panel>

      <Panel title="How a review starts" hint="Three ways in; they all do the same work.">
        <ul className="stack" style={{ margin: 0, paddingLeft: 18 }}>
          <li><strong>GitHub webhook</strong> — point it at <code>/api/github/webhook</code> with <code>GITHUB_WEBHOOK_SECRET</code> set, subscribed to <em>Pull requests</em>. {status?.pullRequests.webhookConfigured ? 'Configured.' : 'Not configured yet.'}</li>
          <li><strong>GitHub Actions</strong> — copy <code>examples/github-actions/qa-pr-review.yml</code> into the repository.</li>
          <li><strong>By hand</strong> — open a repository above and give it a PR number, or run <code>npm run qa -- pr &lt;repo&gt; --number N</code>.</li>
        </ul>
      </Panel>
    </Shell>
  );
}

/**
 * Corrects a connected repository's settings. The repository itself can't be
 * changed (its review history belongs to it); connect a new one instead.
 * A blank token field keeps the stored token.
 */
function EditProjectModal({ project, onClose, onSaved }: {
  project: Project; onClose: () => void; onSaved: (name: string) => void | Promise<void>;
}) {
  const [form, setForm] = useState({
    name: project.name,
    branch: project.branch,
    testBaseUrl: project.testBaseUrl ?? '',
    githubToken: '',
    removeToken: false,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form.name.trim()) { setError('Give the repository a name.'); return; }
    setSaving(true);
    setError(null);
    try {
      await api.patch(`/projects/${project.id}`, {
        name: form.name.trim(),
        branch: form.branch.trim() || 'main',
        // An empty value clears it, so the default application URL is used.
        testBaseUrl: form.testBaseUrl.trim(),
        ...(form.removeToken ? { githubToken: '' } : form.githubToken.trim() ? { githubToken: form.githubToken.trim() } : {}),
      });
      await onSaved(form.name.trim());
    } catch (e) {
      setError(errorText(e));
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`Edit ${project.name}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" form="edit-project" className="primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </>
      }
    >
      <form id="edit-project" onSubmit={save} className="stack">
        {error && <Notice tone="bad" onClose={() => setError(null)}>{error}</Notice>}
        <label className="field">
          <span>Repository <small className="muted">can't be changed</small></span>
          <input value={project.repoUrl} disabled />
        </label>
        <label className="field">
          <span>Name</span>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
        </label>
        <label className="field">
          <span>Branch</span>
          <input value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })} placeholder="main" />
        </label>
        <label className="field">
          <span>Application URL <small className="muted">leave empty to use the default</small></span>
          <input value={form.testBaseUrl} onChange={(e) => setForm({ ...form, testBaseUrl: e.target.value })} placeholder="http://localhost:3000" />
        </label>
        <label className="field">
          <span>
            GitHub token{' '}
            <small className="muted">{project.hasStoredToken ? 'a token is stored; leave empty to keep it' : 'none stored'}</small>
          </span>
          <input type="password" value={form.githubToken} disabled={form.removeToken}
            onChange={(e) => setForm({ ...form, githubToken: e.target.value })}
            placeholder={project.hasStoredToken ? '•••••••• (unchanged)' : 'ghp_… — stored encrypted, never shown again'} autoComplete="off" />
        </label>
        {project.hasStoredToken && (
          <label className="checkbox">
            <input type="checkbox" checked={form.removeToken}
              onChange={(e) => setForm({ ...form, removeToken: e.target.checked, githubToken: '' })} />
            <span>Remove the stored token</span>
          </label>
        )}
      </form>
    </Modal>
  );
}

/** Removes a repository and everything recorded for it, after confirmation. */
function DeleteProjectModal({ project, onClose, onDeleted }: {
  project: Project; onClose: () => void; onDeleted: (name: string) => void | Promise<void>;
}) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    setDeleting(true);
    setError(null);
    try {
      await api.del(`/projects/${project.id}`);
      await onDeleted(project.name);
    } catch (e) {
      setError(errorText(e));
      setDeleting(false);
    }
  };

  return (
    <Modal
      title={`Delete ${project.name}?`}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={deleting}>Cancel</button>
          <button type="button" className="danger" onClick={remove} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete repository'}
          </button>
        </>
      }
    >
      {error && <Notice tone="bad" onClose={() => setError(null)}>{error}</Notice>}
      <p>
        This removes <strong>{project.name}</strong> <span className="muted mono">({project.repoUrl})</span> from
        the dashboard, along with its pull request reviews, test results and stored token.
      </p>
      <p className="muted" style={{ marginBottom: 0 }}>
        Nothing on GitHub is changed, and comments already posted on pull requests stay. This can't be undone;
        you can connect the repository again, but its history won't come back.
      </p>
    </Modal>
  );
}
