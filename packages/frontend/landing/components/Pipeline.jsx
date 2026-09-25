import { useEffect, useState } from 'react';
import Reveal from './Reveal.jsx';
import { useInView, prefersReducedMotion } from '../hooks.js';

const steps = [
  { title: 'Checkout', body: <>Fetches the PR head (forks included) and checks it out <em>before</em> the app is served, so the build under test is the pull request’s.</> },
  { title: 'Diff', body: <><code>git diff</code> against the merge base: the same range GitHub shows under “Files changed”.</> },
  { title: 'Analysis', body: 'Routes, components, APIs, roles, validation and authorization rules are extracted with the TypeScript compiler.' },
  { title: 'Impact', body: 'Each changed file is traced to the routes, rules and tests it reaches, and every link records why it was drawn.' },
  { title: 'Tests', body: <>Scenarios become Page Object Model Playwright tests. Hard waits, <code>force: true</code> and unjustified selectors are rejected.</> },
  { title: 'Execution', body: 'Only the specs the change can affect. A video for every test, plus a screenshot and trace on failure.' },
  { title: 'Walkthrough', body: 'Each affected route is visited in a recorded browser and compared with what the code claimed.' },
  { title: 'Diagnosis & comment', body: 'Failures are classified with confidence and evidence, then one comment is posted and kept up to date.' },
];

const STEP_MS = 1400;

export default function Pipeline() {
  const [ref, inView] = useInView({ threshold: 0.3 });
  const [active, setActive] = useState(-1);

  // Walk through the stages on a loop, holding briefly on "all done" before restarting.
  useEffect(() => {
    if (!inView) return;
    if (prefersReducedMotion()) {
      setActive(steps.length);
      return;
    }
    let i = 0;
    setActive(0);
    const id = setInterval(() => {
      i = (i + 1) % (steps.length + 2);
      setActive(i);
    }, STEP_MS);
    return () => clearInterval(id);
  }, [inView]);

  return (
    <section id="how" className="section">
      <div className="wrap">
        <Reveal as="p" className="kicker">How a Nexus review works</Reveal>
        <Reveal as="h2" delay={80}>From “PR opened” to a comment backed by recordings.</Reveal>
        <ol ref={ref} className="pipeline" style={{ '--step-ms': `${STEP_MS}ms` }}>
          {steps.map((s, i) => (
            <Reveal
              as="li"
              key={s.title}
              delay={i * 70}
              className={`spot${i === active ? ' is-active' : i < active ? ' is-done' : ''}`}
            >
              <span className="n">{i < active ? '✓ ' : ''}{String(i + 1).padStart(2, '0')}</span>
              <h4>{s.title}</h4>
              <p>{s.body}</p>
              <span className="step-bar" aria-hidden="true"><span /></span>
            </Reveal>
          ))}
        </ol>
      </div>
    </section>
  );
}
