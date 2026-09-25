import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'QA PR Review',
  description: 'Reviews pull requests: reads the diff, writes and runs Playwright tests, records the browser, and comments the result.',
};

/** Applies a stored theme choice before first paint so there is no flash. */
const THEME_SCRIPT = `try{var t=localStorage.getItem('qa-theme');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
