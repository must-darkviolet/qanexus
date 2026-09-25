import Reveal from './Reveal.jsx';

const items = [
  { title: 'No credentials leak into tests', body: 'The app under test and the generated suite start with secrets, tokens, keys and the database URL stripped from the environment.' },
  { title: 'Refuses production', body: <>A review won’t run against a host that looks like production. Nexus only tests against approved test environments.</> },
  { title: 'PR text is data', body: 'The title and description go to the model as a claim to verify, and are escaped in the comment, so neither can forge a verdict.' },
  { title: 'Auth is a prerequisite', body: 'Protected routes are signed into and verified before anything runs. If sign-in fails, the review is blocked, never reported as a pass.' },
];

export default function Trust() {
  return (
    <section id="trust" className="section alt">
      <div className="wrap">
        <Reveal as="p" className="kicker">What Nexus is trusted to do</Reveal>
        <Reveal as="h2" delay={80}>Built to run someone else’s code carefully.</Reveal>
        <div className="trust">
          {items.map((it, i) => (
            <Reveal key={it.title} delay={i * 100}><h4>{it.title}</h4><p>{it.body}</p></Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
