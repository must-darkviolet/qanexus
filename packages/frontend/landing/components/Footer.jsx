import Logo from './Logo.jsx';

export default function Footer() {
  return (
    <footer className="footer">
      <div className="wrap footer-inner">
        <span className="brand small"><Logo size={14} strokeWidth={2.4} /> Nexus</span>
        <span className="muted">AI QA for every pull request · Playwright · Gemini · GitHub</span>
      </div>
    </footer>
  );
}
