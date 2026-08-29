import type { Metadata } from 'next';
import './globals.css';
import { TerminalShell } from '@/components/TerminalShell';

export const metadata: Metadata = {
  title: 'GMT Terminal',
  description:
    'A dense, keyboard-driven market terminal for US equities, crypto and forex. ' +
    'Signals are descriptive, not predictive. Not investment advice.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Loaded as a plain stylesheet rather than through next/font so the app
            builds and runs with no network access; the fallback stack in
            globals.css carries the design if this never arrives. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap"
        />
      </head>
      <body className="min-h-screen bg-term-bg text-term-text antialiased">
        <TerminalShell>{children}</TerminalShell>
      </body>
    </html>
  );
}
