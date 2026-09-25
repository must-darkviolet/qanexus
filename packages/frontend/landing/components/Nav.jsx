import { useEffect, useRef, useState } from 'react';
import Logo from './Logo.jsx';
import { DASHBOARD_URL } from '../config.js';

const links = [
  { href: '#how', label: 'How it works' },
  { href: '#report', label: 'The report' },
  { href: '#ai', label: 'AI layer' },
  { href: '#trust', label: 'Safety' },
];

export default function Nav() {
  const ringRef = useRef(null);
  const [scrolled, setScrolled] = useState(false);
  const [active, setActive] = useState('');

  // Reading-progress ring around the logo + solid nav once the page has moved.
  useEffect(() => {
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const doc = document.documentElement;
        const max = doc.scrollHeight - doc.clientHeight;
        const progress = max > 0 ? doc.scrollTop / max : 0;
        if (ringRef.current) ringRef.current.style.strokeDashoffset = String(1 - progress);
        setScrolled(doc.scrollTop > 8);
      });
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  // Highlight the link for the section in the middle of the viewport.
  useEffect(() => {
    if (!('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && setActive(`#${e.target.id}`)),
      { rootMargin: '-45% 0px -50% 0px' }
    );
    links.forEach((l) => {
      const el = document.querySelector(l.href);
      if (el) io.observe(el);
    });
    return () => io.disconnect();
  }, []);

  return (
    <header className={`nav${scrolled ? ' scrolled' : ''}`}>
      <div className="wrap nav-inner">
        <a href="#" className="brand">
          <span className="logo-ring">
            <svg viewBox="0 0 40 40" aria-hidden="true">
              <defs>
                <linearGradient id="ring-grad" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stopColor="#7c6cff" />
                  <stop offset="1" stopColor="#3ddc97" />
                </linearGradient>
              </defs>
              <circle className="ring-track" cx="20" cy="20" r="18.5" pathLength="1" />
              <circle ref={ringRef} className="ring-fill" cx="20" cy="20" r="18.5" pathLength="1" />
            </svg>
            <Logo />
          </span>
          Nexus
        </a>
        <nav className="nav-links">
          {links.map((l) => (
            <a key={l.href} href={l.href} className={active === l.href ? 'active' : undefined}>{l.label}</a>
          ))}
          <a href={DASHBOARD_URL} className="btn btn-sm">
            Get started <span className="arrow" aria-hidden="true">→</span>
          </a>
        </nav>
      </div>
    </header>
  );
}
