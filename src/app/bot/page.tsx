import { headers } from 'next/headers';
import { getPortfolio, ensureAccount, getFills } from '@/lib/gateway/paper';
import { listIntents, pendingApprovals, toPublicIntent } from '@/lib/gateway/service';
import { readAudit, verifyChain } from '@/lib/gateway/audit';
import { listTokens } from '@/lib/gateway/auth';
import { loadLimits, readLockState } from '@/lib/gateway/limits';
import { BotConsole } from '@/components/BotConsole';
import { AdminSignIn } from '@/components/AdminSignIn';
import { adminSecret, requireAdmin } from '@/lib/gateway/admin-auth';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Bot gateway - GMT Terminal' };

/**
 * The operator console.
 *
 * Everything a human needs to supervise the bot in one screen: the paper book,
 * the approval queue, the hard limits in force, the kill switch, and the audit
 * log with a live verification of its hash chain.
 *
 * Gated on the same operator secret as the `/api/admin` routes. Guarding only
 * the routes would not have been enough: this page reads the audit log, the
 * token list and the limits straight from the database and renders them, so
 * anything that can fetch the page can read them without touching an API.
 */
export default async function BotPage() {
  const requestHeaders = await headers();
  const admin = requireAdmin(new Request('http://local/bot', { headers: requestHeaders }));
  if (!admin.ok) return <AdminSignIn configured={adminSecret() !== null} />;

  const account = ensureAccount();
  const portfolio = await getPortfolio(account.id);

  return (
    <BotConsole
      initial={{
        portfolio,
        pending: pendingApprovals().map(toPublicIntent),
        intents: listIntents(account.id, 40).map(toPublicIntent),
        fills: getFills(account.id, 30),
        audit: readAudit({ limit: 60 }),
        verification: verifyChain(),
        tokens: listTokens(),
        lock: readLockState(),
        limits: loadLimits(),
      }}
    />
  );
}
