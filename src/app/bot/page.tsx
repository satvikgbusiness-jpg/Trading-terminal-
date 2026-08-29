import { getPortfolio, ensureAccount, getFills } from '@/lib/gateway/paper';
import { listIntents, pendingApprovals, toPublicIntent } from '@/lib/gateway/service';
import { readAudit, verifyChain } from '@/lib/gateway/audit';
import { listTokens } from '@/lib/gateway/auth';
import { loadLimits, readLockState } from '@/lib/gateway/limits';
import { BotConsole } from '@/components/BotConsole';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Bot gateway - GMT Terminal' };

/**
 * The operator console.
 *
 * Everything a human needs to supervise the bot in one screen: the paper book,
 * the approval queue, the hard limits in force, the kill switch, and the audit
 * log with a live verification of its hash chain.
 */
export default async function BotPage() {
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
