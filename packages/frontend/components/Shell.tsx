'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { Badge } from './ui';
import { IconBranch, IconMoon, IconSun } from './icons';

export interface SystemStatus {
  ai: { configured: boolean; disabled: boolean; provider: string; model: string | null; available: boolean; reason?: string };
  execution: { playwrightAvailable: boolean; browser: string; video: string; baseUrl: string };
  pullRequests: { webhookConfigured: boolean; reviewActions: string[]; reviewsForks: boolean; startsApp: boolean; publicUrl: string | null };
}

/**
 * The frame every page sits in. There is one feature here - reviewing pull
 * requests - so the chrome stays out of the way: where you are, whether the
 * service can actually review anything, and the theme.
 */
export function Shell({ children, crumb }: { children: ReactNode; crumb?: ReactNode }) {
  const pathname = usePathname();
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [status, setStatus] = useState<SystemStatus | null>(null);

  useEffect(() => {
    const stored = (() => { try { return localStorage.getItem('qa-theme'); } catch { return null; } })();
    const initial = stored === 'dark' || stored === 'light'
      ? stored
      : (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    setTheme(initial);
    document.documentElement.setAttribute('data-theme', initial);
    api.get<SystemStatus>('/system/status').then(setStatus).catch(() => setStatus(null));
  }, []);

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('qa-theme', next); } catch { /* private mode */ }
  };

  return (
    <div className="app plain">
      <div className="main">
        <header className="topbar">
          <a href="/" className="brand" style={{ padding: 0 }}>
            <span className="brand-logo"><IconBranch size={17} /></span>
            <span>
              <div className="brand-name">QA PR Review</div>
              <div className="brand-sub">reads the diff, tests it, records it, comments</div>
            </span>
          </a>
          <nav className="crumbs" aria-label="Breadcrumb">
            {pathname !== '/' && (
              <>
                <span className="sep">/</span>
                <a href="/">Repositories</a>
                {crumb && <><span className="sep">/</span><span className="current">{crumb}</span></>}
              </>
            )}
          </nav>
          <div className="topbar-actions">
            {status && (
              <Badge tone={status.ai.configured && !status.ai.disabled ? 'ok' : ''} dot title={status.ai.reason ?? undefined}>
                {status.ai.disabled || !status.ai.configured ? 'deterministic' : `${status.ai.provider}`}
              </Badge>
            )}
            {status && !status.execution.playwrightAvailable && <Badge tone="bad" dot>no browser</Badge>}
            <button className="ghost icon" onClick={toggleTheme} aria-label="Toggle theme" title="Toggle theme">
              {theme === 'dark' ? <IconSun /> : <IconMoon />}
            </button>
          </div>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
