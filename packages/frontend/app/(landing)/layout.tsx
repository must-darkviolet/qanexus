import type { ReactNode } from 'react';
import '@/landing/styles.css';

export const metadata = {
  title: 'Nexus · AI QA for every pull request',
  description: 'Nexus is an AI QA engineer for pull requests. It reads the diff, writes the Playwright tests, runs them on camera and posts the evidence as a comment on the PR.',
};

export default function LandingLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
      </head>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
