import Reveal from './Reveal.jsx';

const statuses = [
  { cls: 'status-pass', label: '✅ PASS', text: 'required tests ran and passed' },
  { cls: 'status-fail', label: '❌ FAIL', text: 'some required tests failed' },
  { cls: 'status-block', label: '⚠️ BLOCKED', text: 'environment or sign-in failed, so the code wasn’t verified' },
];

const features = [
  { title: 'Change analysis', text: 'Stated intent, files touched, kinds of code changed, and what’s new since the last review.' },
  { title: 'Affected modules', text: 'Risk, changed files, and why each one was implicated.' },
  { title: 'Tests executed', text: 'Generated specs (new, updated, rejected) plus the repository’s own related tests.' },
  { title: 'Results', text: 'Passed, failed, skipped, flaky. Every failure is retried once before it’s reported.' },
  { title: 'Findings', text: 'Severity, scenario, expected vs. actual, console errors, failed requests, likely cause and recommended action.' },
  { title: 'Regression assessment', text: 'Per module, including which earlier failures are now fixed.' },
  { title: 'Evidence', text: 'The recorded walkthrough, every test video and the Playwright HTML report.' },
];

export default function Report() {
  return (
    <section id="report" className="section alt">
      <div className="wrap two-col">
        <div>
          <Reveal as="p" className="kicker">What the comment says</Reveal>
          <Reveal as="h2" delay={80}>A full QA report, not a thumbs-up.</Reveal>
          <Reveal as="p" delay={160} className="lead-sm">Nexus posts it only once the review has finished. Secrets are masked throughout, and cancelling a review from the dashboard posts nothing.</Reveal>
          <div className="statuses">
            {statuses.map((s, i) => (
              <Reveal key={s.cls} delay={240 + i * 90} className={`status ${s.cls}`}>{s.label} <span>{s.text}</span></Reveal>
            ))}
          </div>
          <Reveal as="p" delay={520} className="note">Zero executed tests is never a pass.</Reveal>
        </div>
        <ul className="feature-list">
          {features.map((f, i) => (
            <Reveal as="li" key={f.title} delay={i * 60}><b>{f.title}</b><span>{f.text}</span></Reveal>
          ))}
        </ul>
      </div>
    </section>
  );
}
