'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { api, artifactUrl } from '@/lib/api';
import { Shell } from '@/components/Shell';
import {
  Badge, EmptyState, Loading, Notice, PageHeader, Panel, Spinner, Stepper,
} from '@/components/ui';
import {
  IconBranch, IconChevronDown, IconChevronRight, IconExternal, IconPlay,
} from '@/components/icons';
import {
  CLASSIFICATION_TONE, dateTime, duration, errorText, humanize, outcomeTone, reviewTone, shortSha, timeAgo,
} from '@/lib/format';

interface Project { id: string; name: string; repoUrl: string; owner: string; repo: string; branch: string; testBaseUrl: string | null }

interface Review {
  id: string; prNumber: number; repoFullName: string; title: string;
  baseSha: string | null; headSha: string; runId: string | null;
  status: string; trigger: string; commentUrl: string | null; commentMarkdown: string | null;
  error: string | null; createdAt: string;
  summary: {
    execution?: { total: number; passed: number; failed: number; skipped: number; pending: number } | null;
    affectedModules?: { key: string; risk: string }[];
    testChanges?: { file: string; change: string; scenarios: number }[];
    recordings?: number;
  };
}

interface Detail {
  review: Review;
  run: { id: string; status: string; steps: { name: string; status: string; detail: string }[] } | null;
  results: {
    id: string; specFile: string; title: string; outcome: string; durationMs: number;
    errorMessage: string | null; videoPath: string | null; tracePath: string | null; screenshotPaths: string[];
  }[];
  failures: { id: string; testTitle: string; classification: string | null; confidence: number | null; rootCause: string | null; recommendedAction: string | null }[];
  recordings: { name: string; path: string; kind: string; sizeBytes: number }[];
}

const isLive = (status: string) => status === 'running' || status === 'queued';

export default function PullRequestsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [project, setProject] = useState<Project | null>(null);
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, Detail>>({});
  const [number, setNumber] = useState('');
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, r] = await Promise.all([
        api.get<{ project: Project }>(`/projects/${id}`),
        api.get<{ reviews: Review[] }>(`/projects/${id}/pull-requests`),
      ]);
      setProject(p.project);
      setReviews(r.reviews);
    } catch (e) {
      setError(errorText(e));
    }
  }, [id]);

  const loadDetail = useCallback(async (reviewId: string) => {
    try {
      const fresh = await api.get<Detail>(`/projects/${id}/pull-requests/${reviewId}`);
      setDetail((d) => ({ ...d, [reviewId]: fresh }));
    } catch (e) {
      setError(errorText(e));
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  // A review takes minutes; while one is in flight, keep the page current.
  useEffect(() => {
    if (!reviews?.some((r) => isLive(r.status))) return;
    const timer = setInterval(() => {
      void load();
      if (open) void loadDetail(open);
    }, 4000);
    return () => clearInterval(timer);
  }, [reviews, open, load, loadDetail]);

  const toggle = async (reviewId: string) => {
    const next = open === reviewId ? null : reviewId;
    setOpen(next);
    if (next && !detail[next]) await loadDetail(next);
  };

  const review = async () => {
    const n = Number(number.trim());
    if (!Number.isInteger(n) || n <= 0) { setError('Enter the pull request number.'); return; }
    setStarting(true);
    setError(null);
    try {
      const res = await api.post<{ queued: boolean }>(`/projects/${id}/pull-requests/${n}/review`, { force: true });
      setNotice(res.queued
        ? `Queued a review of #${n}. It appears below as it runs, and as a comment on the pull request.`
        : `A review of #${n} is already queued.`);
      setNumber('');
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setStarting(false);
    }
  };

  const stop = async (r: Review) => {
    if (!window.confirm(`Cancel the review of ${r.prNumber ? `#${r.prNumber}` : 'this change'}? It will not produce results, and nothing is posted on the pull request.`)) return;
    setStopping(r.id);
    setError(null);
    try {
      const res = await api.post<{ stopped: 'live' | 'abandoned' }>(`/projects/${id}/pull-requests/${r.id}/stop`, {});
      setNotice(res.stopped === 'live'
        ? `Cancelling the review of #${r.prNumber}. It finishes the step it is on, then stops.`
        : `The review of #${r.prNumber} was no longer running (the API restarted during it), so it has been marked as cancelled.`);
      await load();
      if (open === r.id) await loadDetail(r.id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setStopping(null);
    }
  };

  return (
    <Shell crumb={project?.name ?? '…'}>
      <PageHeader
        eyebrow={project ? `${project.owner}/${project.repo}` : undefined}
        title={project ? `Pull requests · ${project.name}` : 'Pull requests'}
        description="Every review of this repository: what the change affected, the tests written or updated for it, how they ran, the recordings, and the comment posted back."
        actions={
          <div className="row" style={{ gap: 8 }}>
            <input style={{ width: 130 }} placeholder="PR number" value={number} inputMode="numeric"
              onChange={(e) => setNumber(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void review(); }} />
            <button className="primary" onClick={() => void review()} disabled={starting}>
              {starting ? <><Spinner /> Queuing…</> : <><IconPlay /> Review</>}
            </button>
          </div>
        }
      />

      {error && <Notice tone="bad" onClose={() => setError(null)}>{error}</Notice>}
      {notice && <Notice tone="info" onClose={() => setNotice(null)}>{notice}</Notice>}

      {reviews === null ? <Loading /> : reviews.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={<IconBranch size={20} />}
            title="No pull request reviewed yet"
            description="Give a PR number above, point a GitHub webhook at /api/github/webhook, or add the bundled GitHub Actions workflow to this repository."
          />
        </div>
      ) : (
        <div className="stack">
          {reviews.map((r) => {
            const e = r.summary.execution;
            const d = detail[r.id];
            const expanded = open === r.id;
            return (
              <section key={r.id} className="panel">
                <div className="review-head">
                  <button className="panel-head as-button" onClick={() => void toggle(r.id)} aria-expanded={expanded}>
                    <div className="row" style={{ gap: 10, minWidth: 0 }}>
                      {expanded ? <IconChevronDown /> : <IconChevronRight />}
                      <div style={{ minWidth: 0 }}>
                        <h3 style={{ margin: 0 }}>
                          {r.prNumber ? `#${r.prNumber}` : 'local'} {r.title}
                        </h3>
                        <div className="hint">
                          <span className="mono">{shortSha(r.headSha)}</span>
                          {r.baseSha && <> ← <span className="mono">{shortSha(r.baseSha)}</span></>}
                          {' · '}{r.trigger}{' · '}{timeAgo(r.createdAt)}
                        </div>
                      </div>
                    </div>
                    <div className="row" style={{ gap: 8 }}>
                      {isLive(r.status) && <Spinner />}
                      {e && <span className="muted">{e.passed}/{e.total} passed{e.failed ? `, ${e.failed} failed` : ''}</span>}
                      <Badge tone={reviewTone(r.status)} dot>{humanize(r.status)}</Badge>
                    </div>
                  </button>
                  {isLive(r.status) && (
                    <button className="danger cancel" onClick={() => void stop(r)} disabled={stopping === r.id}>
                      {stopping === r.id ? <><Spinner /> Cancelling…</> : 'Cancel'}
                    </button>
                  )}
                </div>

                {expanded && (
                  <div className="panel-body">
                    {r.error && <Notice tone="warn" title={r.status === 'cancelled' ? 'This review was cancelled' : 'This review did not complete'}>{r.error}</Notice>}

                    {!d ? <Loading /> : (
                      <div className="stack">
                        {d.run && (
                          <div>
                            <h4>Progress</h4>
                            <Stepper steps={d.run.steps} />
                          </div>
                        )}

                        {(r.summary.affectedModules?.length || r.summary.testChanges?.length) ? (
                          <div className="grid cols-2">
                            <div>
                              <h4>Affected modules</h4>
                              {r.summary.affectedModules?.length
                                ? <div className="chain-items">
                                    {r.summary.affectedModules.map((m) => (
                                      <Badge key={m.key} tone={m.risk === 'high' ? 'bad' : m.risk === 'medium' ? 'warn' : 'ok'}>{m.key}</Badge>
                                    ))}
                                  </div>
                                : <p className="muted">Nothing was traced to this change.</p>}
                            </div>
                            <div>
                              <h4>Tests written or updated</h4>
                              {r.summary.testChanges?.length
                                ? <ul className="mono" style={{ margin: 0, paddingLeft: 18, fontSize: 12.5 }}>
                                    {r.summary.testChanges.map((t) => (
                                      <li key={t.file}>{t.change === 'new' ? '🆕' : '✏️'} {t.file} · {t.scenarios} scenario(s)</li>
                                    ))}
                                  </ul>
                                : <p className="muted">No test file needed to change.</p>}
                            </div>
                          </div>
                        ) : null}

                        {d.results.length > 0 && (
                          <div>
                            <h4>Tests</h4>
                            <div className="table-wrap">
                              <table className="table">
                                <thead><tr><th>Test</th><th>Outcome</th><th>Time</th><th>Evidence</th></tr></thead>
                                <tbody>
                                  {d.results.map((t) => (
                                    <tr key={t.id}>
                                      <td>
                                        {t.title}
                                        <div className="muted mono" style={{ fontSize: 12 }}>{t.specFile}</div>
                                        {t.errorMessage && <pre className="mini">{t.errorMessage.split('\n').slice(0, 4).join('\n')}</pre>}
                                      </td>
                                      <td><Badge tone={outcomeTone(t.outcome)} dot>{t.outcome}</Badge></td>
                                      <td className="mono">{duration(t.durationMs)}</td>
                                      <td>
                                        <div className="chain-items">
                                          {t.videoPath && <a className="chip" href={artifactUrl(t.videoPath)} target="_blank" rel="noreferrer">🎥 video</a>}
                                          {t.screenshotPaths.slice(0, 1).map((s) => (
                                            <a key={s} className="chip" href={artifactUrl(s)} target="_blank" rel="noreferrer">📷 shot</a>
                                          ))}
                                          {t.tracePath && <a className="chip" href={artifactUrl(t.tracePath)} target="_blank" rel="noreferrer">🔍 trace</a>}
                                        </div>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )}

                        {d.failures.length > 0 && (
                          <div>
                            <h4>Diagnoses <small className="muted">hypotheses from the evidence, not confirmed defects</small></h4>
                            <div className="stack">
                              {d.failures.map((f) => (
                                <div key={f.id} className="card">
                                  <div className="row" style={{ justifyContent: 'space-between' }}>
                                    <strong>{f.testTitle}</strong>
                                    <Badge tone={CLASSIFICATION_TONE[f.classification ?? ''] ?? ''}>
                                      {f.classification ?? 'unclassified'}{f.confidence != null ? ` · ${Math.round(f.confidence * 100)}%` : ''}
                                    </Badge>
                                  </div>
                                  {f.rootCause && <p style={{ margin: '6px 0 0' }}>{f.rootCause}</p>}
                                  {f.recommendedAction && <p className="muted" style={{ margin: '4px 0 0' }}>{f.recommendedAction}</p>}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {d.recordings.filter((x) => x.kind === 'video').length > 0 && (
                          <div>
                            <h4>Recordings <small className="muted">{d.recordings.filter((x) => x.kind === 'video').length} video(s)</small></h4>
                            <div className="grid cols-3">
                              {d.recordings.filter((x) => x.kind === 'video').slice(0, 6).map((v) => (
                                <figure key={v.path} style={{ margin: 0 }}>
                                  <video src={artifactUrl(v.path)} controls preload="metadata"
                                    style={{ width: '100%', borderRadius: 8, border: '1px solid var(--line)', background: '#000' }} />
                                  <figcaption className="muted mono" style={{ fontSize: 11, marginTop: 4, wordBreak: 'break-all' }}>{v.name}</figcaption>
                                </figure>
                              ))}
                            </div>
                          </div>
                        )}

                        <div>
                          <h4>
                            The comment
                            {r.commentUrl && <> · <a href={r.commentUrl} target="_blank" rel="noreferrer">on GitHub <IconExternal size={12} /></a></>}
                          </h4>
                          {r.commentMarkdown
                            ? <pre className="mini" style={{ maxHeight: 420, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{r.commentMarkdown}</pre>
                            : <p className="muted">No comment was produced{r.status === 'running' ? ' yet' : ''}.</p>}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      {reviews && reviews.length > 0 && (
        <p className="muted" style={{ marginTop: 18, fontSize: 12.5 }}>
          Last updated {dateTime(new Date().toISOString())}. Reviews of one repository run one at a time.
        </p>
      )}
    </Shell>
  );
}
