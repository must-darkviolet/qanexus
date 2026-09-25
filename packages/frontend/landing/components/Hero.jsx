import { Fragment, useEffect, useState } from 'react';
import { useInView, prefersReducedMotion } from '../hooks.js';
import { DASHBOARD_URL } from '../config.js';

const points = [
  'Every conclusion comes with evidence',
  'Failures are hypotheses, not verdicts',
  'Your repository is never modified',
];

const headline = ['A', 'QA', 'engineer', 'on', 'every pull request.'];

const TOTAL_TESTS = 17;
const FLAKY_AT = 9; // index of the one flaky test in the simulated run

function ReportCard() {
  const [ref, inView] = useInView({ threshold: 0.3 });
  const [done, setDone] = useState(0);

  // Simulate the review running: tests finish one by one, then the verdict lands.
  useEffect(() => {
    if (!inView) return;
    if (prefersReducedMotion()) {
      setDone(TOTAL_TESTS);
      return;
    }
    let count = 0;
    let interval;
    const start = setTimeout(() => {
      interval = setInterval(() => {
        count += 1;
        setDone(count);
        if (count >= TOTAL_TESTS) clearInterval(interval);
      }, 120);
    }, 900);
    return () => {
      clearTimeout(start);
      clearInterval(interval);
    };
  }, [inView]);

  const finished = done >= TOTAL_TESTS;
  const flaky = done > FLAKY_AT ? 1 : 0;
  const results = [
    { value: done - flaky, label: 'passed' },
    { value: 0, label: 'failed' },
    { value: flaky, label: 'flaky' },
    { value: done, label: 'total' },
  ];

  return (
    <div ref={ref} className="comment-card intro" style={{ '--d': '350ms' }} aria-label="Example pull request comment">
      <div className="cc-head">
        <span className="avatar">🤖</span>
        <div>
          <strong>nexus</strong>{' '}
          <span className="muted">{finished ? 'commented · edited on each push' : 'is reviewing this pull request…'}</span>
        </div>
      </div>
      <div className="cc-body">
        <h3>🤖 Nexus QA Report</h3>
        {finished ? (
          <div className="status status-pass pop">✅ PASS <span>all required tests ran and passed</span></div>
        ) : (
          <div className="status status-run"><i className="spinner" aria-hidden="true" /> RUNNING <span>recording {TOTAL_TESTS} tests in Chromium</span></div>
        )}
        <div className="cc-row">
          <span className="muted">Affected modules</span>
          <span><code>members</code> <em className="risk risk-high">high</em> <code>settings</code> <em className="risk risk-low">low</em></span>
        </div>
        <div className="cc-row"><span className="muted">Tests</span><span>🆕 3 new · ✏️ 2 updated · 11 existing</span></div>
        <div className={`run-bar${finished ? ' complete' : ''}`} aria-hidden="true">
          <span style={{ width: `${(done / TOTAL_TESTS) * 100}%` }} />
        </div>
        <div className="results">
          {results.map((r) => (
            <div key={r.label}><b>{r.value}</b><span>{r.label}</span></div>
          ))}
        </div>
        <div className="cc-row">
          <span className="muted">Authentication</span>
          <span>signed in as <code>admin</code>, <code>viewer</code></span>
        </div>
        <div className={`evidence${finished ? ' shown' : ''}`}>
          <span>▶ walkthrough.webm</span><span>▶ 17 test videos</span><span>📄 HTML report</span>
        </div>
      </div>
    </div>
  );
}

// Lets the dotted backdrop brighten around the cursor.
function trackPointer(e) {
  const rect = e.currentTarget.getBoundingClientRect();
  e.currentTarget.style.setProperty('--px', `${e.clientX - rect.left}px`);
  e.currentTarget.style.setProperty('--py', `${e.clientY - rect.top}px`);
}

export default function Hero() {
  return (
    <section className="hero" onPointerMove={trackPointer}>
      <div className="hero-glow" aria-hidden="true" />
      <div className="hero-dots" aria-hidden="true" />
      <div className="wrap hero-grid">
        <div>
          <span className="eyebrow intro"><span className="dot glow"></span> Playwright · Gemini · GitHub</span>
          <h1>
            {headline.map((w, i) => (
              <Fragment key={w}>
                <span className="word"><span style={{ '--i': i }}>{w}</span></span>
                {i < headline.length - 1 && ' '}
              </Fragment>
            ))}
          </h1>
          <p className="lead intro" style={{ '--d': '450ms' }}>
            When a PR is opened or pushed to, Nexus reads the description and the diff,
            works out what the change affects, writes or updates the Playwright tests for those areas,
            runs them with the browser recorded, and posts the result as one comment on the pull request.
          </p>
          <div className="cta intro" style={{ '--d': '550ms' }}>
            <a href={DASHBOARD_URL} className="btn">Get started <span className="arrow">→</span></a>
            <a href="#how" className="btn btn-ghost">See how it works <span className="arrow">→</span></a>
          </div>
          <ul className="hero-points">
            {points.map((p, i) => (
              <li key={p} className="intro" style={{ '--d': `${650 + i * 90}ms` }}>{p}</li>
            ))}
          </ul>
        </div>
        <ReportCard />
      </div>
    </section>
  );
}
