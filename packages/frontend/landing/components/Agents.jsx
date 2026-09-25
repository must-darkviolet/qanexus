import Reveal from './Reveal.jsx';

const agents = [
  { name: 'RepositoryAnalyzer', role: 'what the app is and its modules' },
  { name: 'BusinessRuleAnalyzer', role: 'rules the change touches' },
  { name: 'ApplicationMapper', role: 'flows, roles and state' },
  { name: 'ChangeAnalyzer', role: 'what the diff affects vs. what the PR claims' },
  { name: 'RegressionAdvisor', role: 'what else to re-test' },
  { name: 'ScenarioGenerator', role: 'scenarios the change needs' },
  { name: 'TestGenerator', role: 'the Playwright tests' },
  { name: 'RegressionSelector', role: 'which specs to run' },
  { name: 'FailureAnalyzer', role: 'why a test failed' },
];

export default function Agents() {
  return (
    <section id="ai" className="section">
      <div className="wrap">
        <Reveal as="p" className="kicker">The AI layer</Reveal>
        <Reveal as="h2" delay={80}>Nine agents, each with a deterministic fallback.</Reveal>
        <Reveal as="p" delay={160} className="lead-sm narrow">Every stage of Nexus that needs judgement uses the model, and none of them depends on it. Raw output is parsed, validated against a schema, retried once, and replaced by the deterministic result if it still doesn’t hold up. Anything sent to a provider is scrubbed of credential-shaped strings first.</Reveal>
        <div className="agents">
          {agents.map((a, i) => (
            <Reveal key={a.name} delay={i * 60} className="spot" style={{ '--scan-delay': `${i * 0.35}s` }}>
              <code>{a.name}</code>
              <span>{a.role}</span>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
