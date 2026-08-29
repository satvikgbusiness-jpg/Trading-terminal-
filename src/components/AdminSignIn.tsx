'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Panel } from './ui';

/**
 * Operator sign-in for the bot console.
 *
 * The console shows the audit log, the token list and the kill switch, and its
 * routes decide live-order approvals. That is the human side of the containment
 * model, so it is gated on a secret the bot does not hold. The secret is
 * exchanged here for an httpOnly cookie and is never kept in page state.
 */
export function AdminSignIn({ configured }: { configured: boolean }) {
  const router = useRouter();
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!configured) {
    return (
      <div className="p-2">
        <Panel title="Operator console unavailable">
          <div className="p-3 text-xs leading-relaxed text-term-dim">
            <p className="mb-2 text-term-text">GMT_ADMIN_TOKEN is not set.</p>
            <p className="mb-2">
              The console approves live orders, issues and revokes bot tokens, clears a locked
              gateway and reads the audit log. It refuses to run without an operator secret rather
              than serving those controls to anyone who can reach the port — including the bot.
            </p>
            <p>
              Put a long random value in <code className="text-term-text">.env.local</code> as{' '}
              <code className="text-term-text">GMT_ADMIN_TOKEN</code> and restart the server.
            </p>
          </div>
        </Panel>
      </div>
    );
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const response = await fetch('/api/admin/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    setBusy(false);
    if (response.ok) {
      setToken('');
      router.refresh();
      return;
    }
    const body = await response.json().catch(() => ({}));
    setError(body.error ?? 'Sign-in failed');
  };

  return (
    <div className="p-2">
      <Panel title="Operator sign-in">
        <form onSubmit={submit} className="flex flex-col gap-3 p-3 text-xs">
          <p className="text-term-dim">
            Enter the operator secret from <code className="text-term-text">.env.local</code>.
          </p>
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder="GMT_ADMIN_TOKEN"
            className="border border-term-border bg-term-bg px-2 py-1 font-mono text-term-text outline-none focus:border-term-accent"
          />
          {error && <p className="text-term-down">{error}</p>}
          <button
            type="submit"
            disabled={busy || token.length === 0}
            className="self-start border border-term-border px-3 py-1 text-term-text hover:border-term-accent disabled:opacity-40"
          >
            {busy ? 'checking...' : 'sign in'}
          </button>
        </form>
      </Panel>
    </div>
  );
}
