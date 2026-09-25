'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Shell, type SystemStatus } from '@/components/Shell';
import { Badge, EmptyState, Loading, Notice, PageHeader, Panel, StatCard } from '@/components/ui';
import { IconBranch, IconGit, IconPlus, IconShield, IconPlay } from '@/components/icons';
import { errorText } from '@/lib/format';

interface Project {
  id: string; name: string; repoUrl: string; owner: string; repo: string;
  branch: string; testBaseUrl: string | null; isPrivate: boolean; lastAnalyzedCommit: string | null;
}

export default function HomePage() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [form, setForm] = useState({ repoUrl: '', name: '', branch: 'main', testBaseUrl: '', githubToken: '' });

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
                  <td style={{ textAlign: 'right' }}>
                    <a className="ghost" href={`/projects/${p.id}`}>Pull requests →</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

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
