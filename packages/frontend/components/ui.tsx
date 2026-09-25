'use client';

/** Shared presentational primitives. Every value shown is passed in - nothing here invents data. */
import { useEffect, useRef, type ReactNode } from 'react';
import {
  IconAlert, IconCheck, IconDot, IconInfo, IconLoader, IconX,
} from './icons';

/* -------------------------------------------------------------------------- */
export function PageHeader({ title, description, actions, eyebrow }: {
  title: ReactNode; description?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div style={{ minWidth: 0 }}>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p className="desc">{description}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

export function SectionTitle({ title, hint, actions }: { title: ReactNode; hint?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="section-title">
      <div className="row" style={{ gap: 10 }}>
        <h2>{title}</h2>
        {hint && <span className="hint">{hint}</span>}
      </div>
      {actions}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
export type Tone = 'ok' | 'bad' | 'warn' | 'info' | 'accent' | 'violet' | '';

export function Badge({ tone = '', children, dot, mono, title }: {
  tone?: Tone; children: ReactNode; dot?: boolean; mono?: boolean; title?: string;
}) {
  return (
    <span className={`badge ${tone}${mono ? ' mono' : ''}`} title={title}>
      {dot && <span className="dot" />}
      {children}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
export function Panel({ title, hint, actions, children, flush, className, icon }: {
  title?: ReactNode; hint?: ReactNode; actions?: ReactNode; children: ReactNode;
  flush?: boolean; className?: string; icon?: ReactNode;
}) {
  return (
    <section className={`panel ${className ?? ''}`}>
      {(title || actions) && (
        <div className="panel-head">
          <div style={{ minWidth: 0 }}>
            <h3>{icon}{title}</h3>
            {hint && <div className="hint">{hint}</div>}
          </div>
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      <div className={`panel-body${flush ? ' flush' : ''}`}>{children}</div>
    </section>
  );
}

export function StatCard({ label, value, sub, icon, tone, small }: {
  label: ReactNode; value: ReactNode; sub?: ReactNode; icon?: ReactNode;
  tone?: 'accent' | 'ok' | 'bad' | 'warn' | 'info'; small?: boolean;
}) {
  return (
    <div className={`card stat${tone ? ` tone-${tone}` : ''}`}>
      {icon && <div className="stat-icon">{icon}</div>}
      <div className="card-label" style={{ paddingRight: icon ? 34 : 0 }}>{label}</div>
      <div className={`card-value${small ? ' small' : ''}`}>{value}</div>
      {sub && <div className="card-sub">{sub}</div>}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
export function EmptyState({ icon, title, description, action }: {
  icon?: ReactNode; title: ReactNode; description?: ReactNode; action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      {icon && <div className="es-icon">{icon}</div>}
      <div className="es-title">{title}</div>
      {description && <div className="es-desc">{description}</div>}
      {action && <div className="es-action">{action}</div>}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="stack" aria-busy="true" aria-label={label}>
      <div className="skeleton" style={{ height: 28, width: '40%' }} />
      <div className="skeleton" style={{ height: 14, width: '65%' }} />
      <div className="grid cols-4" style={{ marginTop: 10 }}>
        {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 92 }} />)}
      </div>
      <div className="skeleton" style={{ height: 220 }} />
    </div>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <IconLoader size={size} className="spin" />;
}

/* -------------------------------------------------------------------------- */
export function Notice({ tone = 'info', children, title, onClose }: {
  tone?: 'info' | 'ok' | 'warn' | 'bad'; children?: ReactNode; title?: ReactNode; onClose?: () => void;
}) {
  const Icon = tone === 'ok' ? IconCheck : tone === 'info' ? IconInfo : IconAlert;
  return (
    <div className={`notice ${tone}`} role={tone === 'bad' ? 'alert' : 'status'}>
      <Icon size={16} />
      <div className="notice-body">
        {title && <strong>{title} </strong>}
        {children}
      </div>
      {onClose && (
        <button type="button" className="ghost icon sm" onClick={onClose} aria-label="Dismiss" style={{ color: 'inherit', width: 24, minHeight: 24 }}>
          <IconX size={14} />
        </button>
      )}
    </div>
  );
}

export function Toast({ message, onDone }: { message: string | null; onDone: () => void }) {
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => done.current(), 4500);
    return () => clearTimeout(t);
  }, [message]);
  if (!message) return null;
  return <div className="toast" role="status"><IconCheck size={15} />{message}</div>;
}

/* -------------------------------------------------------------------------- */
export function TableCard({ children }: { children: ReactNode }) {
  return <div className="table-card"><div className="table-wrap">{children}</div></div>;
}

export function Tabs<T extends string>({ tabs, value, onChange }: {
  tabs: { value: T; label: ReactNode; count?: number }[]; value: T; onChange: (v: T) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button type="button" key={t.value} role="tab" className="tab" aria-selected={value === t.value} onClick={() => onChange(t.value)}>
          {t.label}
          {t.count !== undefined && <span className="nav-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({ options, value, onChange }: {
  options: { value: T; label: ReactNode }[]; value: T; onChange: (v: T) => void;
}) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button type="button" key={o.value} aria-pressed={value === o.value} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
export function ProgressBar({ value, total, tone }: { value: number; total: number; tone?: 'ok' | 'warn' | 'bad' }) {
  const pct = total === 0 ? 0 : Math.min(100, Math.round((value / total) * 100));
  return <div className={`bar${tone ? ` ${tone}` : ''}`}><span style={{ width: `${pct}%` }} /></div>;
}

export function Meter({ label, value, total }: { label: string; value: number; total: number }) {
  const pct = total === 0 ? null : Math.round((value / total) * 100);
  const tone = pct === null ? undefined : pct >= 70 ? 'ok' : pct >= 35 ? 'warn' : 'bad';
  return (
    <div className="meter-row">
      <span className="muted">{label}</span>
      <ProgressBar value={value} total={total} tone={tone} />
      <span className="v">{total === 0 ? '—' : `${value}/${total}`}</span>
    </div>
  );
}

export interface DonutSegment { label: string; value: number; color: string }

export function Donut({ segments, size = 132, thickness = 14, centerValue, centerLabel }: {
  segments: DonutSegment[]; size?: number; thickness?: number; centerValue: ReactNode; centerLabel?: ReactNode;
}) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="donut-wrap">
      <div className="donut" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={segments.map((s) => `${s.label}: ${s.value}`).join(', ')}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth={thickness} />
          {total > 0 && segments.filter((s) => s.value > 0).map((s) => {
            const len = (s.value / total) * c;
            const el = (
              <circle
                key={s.label} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={s.color} strokeWidth={thickness}
                strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-offset}
                transform={`rotate(-90 ${size / 2} ${size / 2})`}
              />
            );
            offset += len;
            return el;
          })}
        </svg>
        <div className="donut-center">
          <div>
            <div className="donut-value">{centerValue}</div>
            {centerLabel && <div className="donut-label">{centerLabel}</div>}
          </div>
        </div>
      </div>
      <div className="legend">
        {segments.map((s) => (
          <div className="legend-item" key={s.label}>
            <span className="sw" style={{ background: s.color }} />
            {s.label}
            <span className="lv">{s.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
export interface StepLike { name: string; status: string; detail: string }

export function Stepper({ steps, hidePending = true }: { steps: StepLike[]; hidePending?: boolean }) {
  const visible = hidePending ? steps.filter((s) => s.status !== 'pending') : steps;
  if (visible.length === 0) return <div className="empty">No steps have started yet.</div>;
  return (
    <div className="stepper">
      {visible.map((s) => (
        <div key={s.name} className={`stepper-item ${s.status}`}>
          <div className="step-icon">
            {s.status === 'completed' ? <IconCheck size={12} />
              : s.status === 'failed' ? <IconX size={12} />
              : s.status === 'running' ? <Spinner size={12} />
              : <IconDot size={12} />}
          </div>
          <div style={{ minWidth: 0 }}>
            <div className="step-title">
              {s.name.replace(/_/g, ' ')}
              {s.status === 'skipped' && <Badge>skipped</Badge>}
              {s.status === 'running' && <Badge tone="info">running</Badge>}
              {s.status === 'failed' && <Badge tone="bad">failed</Badge>}
            </div>
            {s.detail && <div className="step-detail">{s.detail}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
export function Modal({ title, onClose, children, footer }: {
  title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-head">
          <h3>{title}</h3>
          <button type="button" className="ghost icon" onClick={onClose} aria-label="Close"><IconX /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
export function Epistemic({ observed, inferred, unknown }: { observed: string[]; inferred: string[]; unknown: string[] }) {
  const col = (cls: string, title: string, items: string[], none: string) => (
    <div className={cls}>
      <h4>{title}</h4>
      {items.length ? <ul>{items.map((x, i) => <li key={i}>{x}</li>)}</ul> : <div className="card-sub">{none}</div>}
    </div>
  );
  return (
    <div className="epistemic">
      {col('observed', 'Observed', observed, 'none recorded')}
      {col('inferred', 'Inferred', inferred, 'none recorded')}
      {col('unknown', 'Unknown', unknown, 'nothing flagged')}
    </div>
  );
}
