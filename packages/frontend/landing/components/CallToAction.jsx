import Reveal from './Reveal.jsx';
import { DASHBOARD_URL } from '../config.js';

export default function CallToAction() {
  return (
    <section className="section closing">
      <div className="closing-glow" aria-hidden="true" />
      <div className="wrap closing-inner">
        <Reveal as="p" className="kicker">Ready when your next PR is</Reveal>
        <Reveal as="h2" delay={80}>Put Nexus on your next pull request.</Reveal>
        <Reveal as="p" delay={160} className="lead-sm">
          Every pull request tested, recorded and explained, with the evidence posted
          right where your team already reviews code.
        </Reveal>
        <Reveal delay={240} className="cta">
          <a href={DASHBOARD_URL} className="btn">Open the dashboard <span className="arrow">→</span></a>
          <a href="#how" className="btn btn-ghost">See how it works</a>
        </Reveal>
      </div>
    </section>
  );
}
