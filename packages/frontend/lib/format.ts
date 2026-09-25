/** Formatting helpers and status-to-tone mappings shared across pages. */
import type { Tone } from '@/components/ui';

export const shortSha = (sha: string | null | undefined, n = 8) => (sha ? sha.slice(0, n) : '—');

export const humanize = (s: string) => s.replace(/_/g, ' ');

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const s = Math.round((Date.now() - then) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

export const dateTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—');

export function duration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export const pct = (n: number | null | undefined) => (n == null ? '—' : `${Math.round(n * 100)}%`);

export function runStatusTone(status: string): Tone {
  if (status === 'completed') return 'ok';
  if (status === 'failed' || status === 'cancelled') return 'bad';
  if (status === 'running') return 'info';
  return '';
}

export function outcomeTone(outcome: string | null | undefined): Tone {
  if (outcome === 'passed') return 'ok';
  if (outcome === 'failed') return 'bad';
  if (outcome === 'pending' || outcome === 'skipped') return 'warn';
  return '';
}

export function reviewTone(status: string): Tone {
  if (status === 'passed') return 'ok';
  if (status === 'failed') return 'bad';
  if (status === 'error' || status === 'blocked' || status === 'partial') return 'warn';
  if (status === 'running' || status === 'queued') return 'info';
  return '';
}

export function riskTone(risk: string): Tone {
  return risk === 'high' ? 'bad' : risk === 'medium' ? 'warn' : 'ok';
}

export function priorityTone(p: string): Tone {
  return p === 'critical' ? 'bad' : p === 'high' ? 'warn' : p === 'medium' ? 'info' : '';
}

export function changeTone(status: string): Tone {
  return status === 'added' ? 'ok' : status === 'deleted' || status === 'removed' ? 'bad' : status === 'renamed' ? 'info' : 'warn';
}

export const CLASSIFICATION_TONE: Record<string, Tone> = {
  APPLICATION_BUG: 'bad', TEST_BUG: 'warn', LOCATOR_CHANGED: 'warn', UI_CHANGED: 'warn',
  API_FAILURE: 'warn', AUTHENTICATION_FAILURE: 'warn',
  ENVIRONMENT_FAILURE: 'info', NETWORK_FAILURE: 'info', TIMING_OR_STATE_ISSUE: 'info',
  TEST_DATA_ISSUE: 'warn', DEPENDENCY_FAILURE: 'warn', PREEXISTING_FAILURE: 'info', UNKNOWN: '',
};

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
