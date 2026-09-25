'use client';

import { useSpotlight } from './hooks.js';
import Nav from './components/Nav.jsx';
import Hero from './components/Hero.jsx';
import Pipeline from './components/Pipeline.jsx';
import Report from './components/Report.jsx';
import Agents from './components/Agents.jsx';
import Trust from './components/Trust.jsx';
import CallToAction from './components/CallToAction.jsx';
import Footer from './components/Footer.jsx';

export default function App() {
  useSpotlight();

  return (
    <>
      <Nav />
      <main>
        <Hero />
        <Pipeline />
        <Report />
        <Agents />
        <Trust />
        <CallToAction />
      </main>
      <Footer />
    </>
  );
}
