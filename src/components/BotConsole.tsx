'use client';

import { useEffect, useState, useTransition } from 'react';
import clsx from 'clsx';
import type { AuditEntry, PaperFill } from '@/lib/db/schema';
import type { ChainVerification } from '@/lib/gateway/audit';
import type { Scope } from '@/lib/gateway/auth';
import type { LockState, RiskLimits } from '@/lib/gateway/limits';
import type { Portfolio } from '@/lib/gateway/paper';
import type { PublicIntent } from '@/lib/gateway/service';
import { changeColor, formatMoney, formatPrice, timeAgo } from '@/lib/format';
import { Panel, Unavailable } from './ui';
import { AdminSignIn } from './AdminSignIn';

interface TokenRow {
  id: string;
  name: string;
  scopes: Scope[];
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  revokedReason: string | null;
}

export interface BotConsoleData {
  portfolio: Portfolio | null;
  pending: PublicIntent[];
  intents: PublicIntent[];
  fills: PaperFill[];
  audit: AuditEntry[];
  verification: ChainVerification;
  tokens: TokenRow[];
  lock: LockState;
  limits: RiskLimits;
}

export function BotConsole({ initial }: { initial: BotConsoleData }) {
  const [data, setData] = useState(initial);
  const [busy, startTransition] = useTransition();
  const [issued, setIssued] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** Set when an admin call comes back 401, i.e. the operator session lapsed. */
  const [signedOut, setSignedOut] = useState(false);

  /**
   * Every admin call goes through here so a lapsed session shows the sign-in
   * panel instead of the console quietly failing to refresh.
   */
  const adminFetch = async (input: string, init?: RequestInit): Promise<Response | null> => {
    const response = await fetch(input, init);
    if (response.status === 401 || response.status === 503) {
      setSignedOut(true);
      return null;
    }
    return response;
  };

  // The approval countdown has to keep moving even with no server round-trip.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const reload = async () => {
    const responses = await Promise.all([
      adminFetch('/api/admin/approvals'),
      adminFetch('/api/admin/audit?limit=60'),
      adminFetch('/api/admin/unlock'),
    ]);
    if (responses.some((r) => r === null)) return;
    const [approvals, audit, lock] = await Promise.all(responses.map((r) => r!.json()));
    setData((current) => ({
      ...current,
      pending: approvals.intents ?? [],
      audit: audit.entries ?? [],
      verification: audit.verification ?? current.verification,
      lock,
    }));
  };

  const decide = (id: string, decision: 'approve' | 'reject') =>
    startTransition(async () => {
      await adminFetch(`/api/admin/approvals/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      await reload();
    });

  const kill = () =>
    startTransition(async () => {
      if (!window.confirm('Revoke every bot token, cancel open intents, and lock the gateway?')) {
        return;
      }
      await adminFetch('/api/admin/kill', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'kill switch pressed in the operator console' }),
      });
      const tokenResponse = await adminFetch('/api/admin/tokens');
      if (tokenResponse) {
        const tokens = await tokenResponse.json();
        setData((current) => ({ ...current, tokens: tokens.tokens ?? current.tokens }));
      }
      await reload();
    });

  const unlock = () =>
    startTransition(async () => {
      await adminFetch('/api/admin/unlock', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note: 'cleared from the operator console' }),
      });
      await reload();
    });

  const issueToken = () =>
    startTransition(async () => {
      const response = await adminFetch('/api/admin/tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: `bot-${new Date().toISOString().slice(0, 16)}` }),
      });
      if (!response) return;
      const body = await response.json();
      if (response.ok) setIssued(body.token);
      const tokenResponse = await adminFetch('/api/admin/tokens');
      if (!tokenResponse) return;
      const tokens = await tokenResponse.json();
      setData((current) => ({ ...current, tokens: tokens.tokens ?? current.tokens }));
    });

  if (signedOut) return <AdminSignIn configured />;

  return (
    <div className="flex flex-col gap-2 p-2">
      {/* ---------- Status bar ---------- */}
      <div
        className={clsx(
          'flex flex-wrap items-center gap-3 border px-3 py-2',
          data.lock.locked
            ? 'border-term-down/50 bg-term-down/10'
            : 'border-term-border bg-term-panel',
        )}
      >
        <span
          className={clsx('font-bold tracking-wide', data.lock.locked ? 'text-term-down' : 'text-term-up')}
        >
          GATEWAY {data.lock.locked ? 'LOCKED' : 'OPEN'}
        </span>
        <span className="text-term-warn">PAPER MODE ONLY</span>
        {data.lock.locked && (
          <>
            <span className="min-w-0 flex-1 truncate text-term-text" title={data.lock.reason ?? ''}>
              {data.lock.reason}
            </span>
            <button
              type="button"
              onClick={unlock}
              disabled={busy}
              className="border border-term-warn/60 px-2 py-0.5 text-term-warn hover:bg-term-warn/10 disabled:opacity-40"
            >
              CLEAR LOCK
            </button>
          </>
        )}
        <button
          type="button"
          onClick={kill}
          disabled={busy}
          className="ml-auto border border-term-down bg-term-down/10 px-3 py-0.5 font-bold text-term-down hover:bg-term-down/20 disabled:opacity-40"
        >
          KILL SWITCH
        </button>
      </div>

      <div className="grid gap-2 lg:grid-cols-[1fr_400px]">
        <div className="flex min-w-0 flex-col gap-2">
          <PnlPanel portfolio={data.portfolio} />
          <ApprovalQueue pending={data.pending} now={now} onDecide={decide} busy={busy} />
          <FillsPanel fills={data.fills} />
          <IntentsPanel intents={data.intents} />
        </div>

        <div className="flex min-w-0 flex-col gap-2">
          <LimitsPanel limits={data.limits} />
          <TokensPanel tokens={data.tokens} issued={issued} onIssue={issueToken} busy={busy} />
          <AuditPanel entries={data.audit} verification={data.verification} />
        </div>
      </div>
    </div>
  );
}

function PnlPanel({ portfolio }: { portfolio: Portfolio | null }) {
  if (!portfolio) {
    return (
      <Panel title="Paper P&L">
        <Unavailable reason="No paper account yet. Run pnpm seed." compact />
      </Panel>
    );
  }

  const { valuation, positions, pricingGaps } = portfolio;
  const open = positions.filter((p) => p.position.quantity !== 0);

  return (
    <Panel
      title={`Paper P&L - ${portfolio.account.name}`}
      right={<span className="text-term-faint">{timeAgo(portfolio.asOf)}</span>}
    >
      <div className="grid grid-cols-2 gap-px bg-term-border sm:grid-cols-5">
        <Metric label="Equity" value={formatMoney(valuation.equity)} />
        <Metric label="Cash" value={formatMoney(valuation.cash)} />
        <Metric
          label="Total P&L"
          value={formatMoney(valuation.totalPnl)}
          className={changeColor(valuation.totalPnl)}
        />
        <Metric
          label="Realised"
          value={formatMoney(valuation.realizedPnl)}
          className={changeColor(valuation.realizedPnl)}
        />
        <Metric
          label="Unrealised"
          value={formatMoney(valuation.unrealizedPnl)}
          className={changeColor(valuation.unrealizedPnl)}
        />
      </div>

      {pricingGaps.length > 0 && (
        <p className="border-t border-term-border bg-term-warn/5 px-2 py-1 text-2xs text-term-warn">
          {pricingGaps.length} position{pricingGaps.length === 1 ? '' : 's'} could not be priced and
          are excluded from equity: {pricingGaps.map((g) => g.symbol).join(', ')}. They are not
          marked at cost.
        </p>
      )}

      {open.length === 0 ? (
        <p className="px-2 py-2 text-term-dim">No open positions.</p>
      ) : (
        <table className="w-full border-t border-term-border">
          <thead>
            <tr className="border-b border-term-border text-left">
              <th className="label px-2 py-1 font-normal">Symbol</th>
              <th className="label px-2 py-1 text-right font-normal">Qty</th>
              <th className="label px-2 py-1 text-right font-normal">Avg</th>
              <th className="label px-2 py-1 text-right font-normal">Last</th>
              <th className="label px-2 py-1 text-right font-normal">Value</th>
              <th className="label px-2 py-1 text-right font-normal">Unrealised</th>
            </tr>
          </thead>
          <tbody>
            {open.map((row) => (
              <tr key={row.symbol} className="border-b border-term-border/50">
                <td className="px-2 py-1 text-term-bright">{row.symbol}</td>
                <td
                  className={clsx(
                    'px-2 py-1 text-right tabular-nums',
                    row.position.quantity < 0 ? 'text-term-down' : 'text-term-text',
                  )}
                >
                  {row.position.quantity}
                </td>
                <td className="px-2 py-1 text-right tabular-nums text-term-dim">
                  {formatPrice(row.position.averagePrice)}
                </td>
                <td className="px-2 py-1 text-right tabular-nums text-term-text">
                  {row.price === null ? (
                    <span className="text-term-warn">no price</span>
                  ) : (
                    <>
                      {formatPrice(row.price)}
                      {row.priceStale && <span className="ml-1 text-term-warn">*</span>}
                    </>
                  )}
                </td>
                <td className="px-2 py-1 text-right tabular-nums text-term-text">
                  {row.marketValue === null ? '--' : formatMoney(row.marketValue)}
                </td>
                <td className={clsx('px-2 py-1 text-right tabular-nums', changeColor(row.unrealizedPnl))}>
                  {row.unrealizedPnl === null ? '--' : formatMoney(row.unrealizedPnl)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function Metric({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="bg-term-panel p-2">
      <div className="label">{label}</div>
      <div className={clsx('tabular-nums text-term-bright', className)}>{value}</div>
    </div>
  );
}

/**
 * The approval queue.
 *
 * Each intent is decided individually and expires on a visible countdown. There
 * is no bulk-approve control and no auto-approve setting, by design.
 */
function ApprovalQueue({
  pending,
  now,
  onDecide,
  busy,
}: {
  pending: PublicIntent[];
  now: number;
  onDecide: (id: string, decision: 'approve' | 'reject') => void;
  busy: boolean;
}) {
  return (
    <Panel
      title="Approval queue"
      right={
        <span className={pending.length > 0 ? 'text-term-warn' : 'text-term-faint'}>
          {pending.length} awaiting a human
        </span>
      }
    >
      {pending.length === 0 ? (
        <p className="px-2 py-2 text-term-dim">
          Nothing queued. Any intent flagged <code className="text-term-text">live</code> lands here
          and waits for an explicit decision.
        </p>
      ) : (
        <ul className="divide-y divide-term-border/50">
          {pending.map((intent) => {
            const remaining = intent.expiresAt ? intent.expiresAt - now : 0;
            const seconds = Math.max(0, Math.floor(remaining / 1000));
            return (
              <li key={intent.id} className="flex flex-wrap items-center gap-2 px-2 py-1.5">
                <span className="w-40 shrink-0 truncate text-term-faint" title={intent.id}>
                  {intent.id}
                </span>
                <span
                  className={clsx(
                    'shrink-0 font-medium',
                    intent.side === 'buy' ? 'text-term-up' : 'text-term-down',
                  )}
                >
                  {intent.side.toUpperCase()}
                </span>
                <span className="shrink-0 tabular-nums text-term-bright">
                  {intent.quantity} {intent.symbol}
                </span>
                <span className="shrink-0 text-term-dim">
                  {intent.orderType}
                  {intent.limitPrice !== null ? ` @ ${formatPrice(intent.limitPrice)}` : ''}
                </span>
                <span
                  className={clsx(
                    'shrink-0 tabular-nums',
                    seconds < 60 ? 'text-term-down' : 'text-term-warn',
                  )}
                  title="Approvals expire 10 minutes after submission."
                >
                  {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
                </span>
                <span className="ml-auto flex shrink-0 gap-1">
                  <button
                    type="button"
                    disabled={busy || seconds === 0}
                    onClick={() => onDecide(intent.id, 'approve')}
                    className="border border-term-up/50 px-2 py-0.5 text-term-up hover:bg-term-up/10 disabled:opacity-40"
                  >
                    APPROVE
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onDecide(intent.id, 'reject')}
                    className="border border-term-down/50 px-2 py-0.5 text-term-down hover:bg-term-down/10 disabled:opacity-40"
                  >
                    REJECT
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="border-t border-term-border px-2 py-1 text-2xs text-term-faint">
        Approving records the decision and audits it. It does not place an order: v1 ships no broker
        adapter, so an approved live intent terminates in{' '}
        <code className="text-term-text">blocked_no_broker</code>.
      </p>
    </Panel>
  );
}

function FillsPanel({ fills }: { fills: PaperFill[] }) {
  return (
    <Panel title="Paper fills" right={<span className="text-term-faint">{fills.length} recent</span>}>
      {fills.length === 0 ? (
        <p className="px-2 py-2 text-term-dim">No fills yet.</p>
      ) : (
        <table className="w-full">
          <thead>
            <tr className="border-b border-term-border text-left">
              <th className="label px-2 py-1 font-normal">When</th>
              <th className="label px-2 py-1 font-normal">Side</th>
              <th className="label px-2 py-1 font-normal">Symbol</th>
              <th className="label px-2 py-1 text-right font-normal">Qty</th>
              <th className="label px-2 py-1 text-right font-normal">Price</th>
              <th className="label px-2 py-1 text-right font-normal">P&L</th>
              <th className="label px-2 py-1 text-right font-normal">Price source</th>
            </tr>
          </thead>
          <tbody>
            {fills.map((fill) => (
              <tr key={fill.id} className="border-b border-term-border/50">
                <td className="px-2 py-1 text-term-dim">{timeAgo(fill.filledAt)}</td>
                <td className={clsx('px-2 py-1', fill.side === 'buy' ? 'text-term-up' : 'text-term-down')}>
                  {fill.side.toUpperCase()}
                </td>
                <td className="px-2 py-1 text-term-bright">{fill.symbol}</td>
                <td className="px-2 py-1 text-right tabular-nums">{fill.quantity}</td>
                <td className="px-2 py-1 text-right tabular-nums">{formatPrice(fill.price)}</td>
                <td className={clsx('px-2 py-1 text-right tabular-nums', changeColor(fill.realizedPnl))}>
                  {fill.realizedPnl === 0 ? '--' : formatMoney(fill.realizedPnl)}
                </td>
                {/* Every fill records which feed produced the price it filled at. */}
                <td className="px-2 py-1 text-right text-2xs text-term-accent">{fill.priceSource}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

const STATUS_STYLE: Record<string, string> = {
  filled: 'text-term-up',
  rejected: 'text-term-down',
  pending_approval: 'text-term-warn',
  approved: 'text-term-accent',
  expired: 'text-term-dim',
  cancelled: 'text-term-dim',
  blocked_no_broker: 'text-term-violet',
};

function IntentsPanel({ intents }: { intents: PublicIntent[] }) {
  return (
    <Panel title="Order intents" right={<span className="text-term-faint">{intents.length}</span>}>
      {intents.length === 0 ? (
        <p className="px-2 py-2 text-term-dim">No intents submitted yet.</p>
      ) : (
        <ul className="divide-y divide-term-border/50">
          {intents.map((intent) => (
            <li key={intent.id} className="flex flex-wrap items-baseline gap-2 px-2 py-1">
              <span className="w-16 shrink-0 text-term-dim">{timeAgo(intent.createdAt)}</span>
              <span className={clsx('w-28 shrink-0', STATUS_STYLE[intent.status] ?? 'text-term-text')}>
                {intent.status}
              </span>
              <span className="shrink-0 text-term-bright">
                {intent.side} {intent.quantity} {intent.symbol}
              </span>
              <span className="shrink-0 text-2xs text-term-faint">{intent.mode}</span>
              {intent.statusReason && (
                <span className="min-w-0 flex-1 truncate text-2xs text-term-dim" title={intent.statusReason}>
                  {intent.statusReason}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function LimitsPanel({ limits }: { limits: RiskLimits }) {
  return (
    <Panel title="Hard limits" right={<span className="text-term-faint">enforced server-side</span>}>
      <dl className="divide-y divide-term-border/50">
        <Limit label="Max order notional" value={formatMoney(limits.maxOrderNotional)} />
        <Limit label="Max position notional" value={formatMoney(limits.maxPositionNotional)} />
        <Limit label="Max position concentration" value={`${limits.maxPositionPercentEquity}% of equity`} />
        <Limit label="Max daily loss" value={formatMoney(limits.maxDailyLoss)} />
        <Limit label="Max orders / minute" value={String(limits.maxOrdersPerMinute)} />
        <Limit label="Max orders / day" value={String(limits.maxOrdersPerDay)} />
      </dl>
      <div className="border-t border-term-border p-2">
        <div className="label mb-1">Instrument allowlist ({limits.instrumentAllowlist.length})</div>
        <div className="flex flex-wrap gap-1">
          {limits.instrumentAllowlist.map((symbol) => (
            <span key={symbol} className="border border-term-border-bright px-1 text-2xs text-term-text">
              {symbol}
            </span>
          ))}
        </div>
      </div>
      <p className="border-t border-term-border px-2 py-1 text-2xs text-term-faint">
        Breaching any of these locks the gateway until a human clears it. The bot cannot read or
        change these values, and no bearer-token route unlocks the gateway.
      </p>
    </Panel>
  );
}

function Limit({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 px-2 py-1">
      <dt className="text-term-dim">{label}</dt>
      <dd className="tabular-nums text-term-bright">{value}</dd>
    </div>
  );
}

function TokensPanel({
  tokens,
  issued,
  onIssue,
  busy,
}: {
  tokens: TokenRow[];
  issued: string | null;
  onIssue: () => void;
  busy: boolean;
}) {
  return (
    <Panel
      title="Bot tokens"
      right={
        <button
          type="button"
          onClick={onIssue}
          disabled={busy}
          className="border border-term-border-bright px-2 text-term-dim hover:border-term-accent/60 hover:text-term-bright disabled:opacity-40"
        >
          ISSUE
        </button>
      }
    >
      {issued && (
        <div className="border-b border-term-warn/40 bg-term-warn/10 p-2">
          <p className="text-2xs text-term-warn">
            Shown once. Copy it now -- only its hash is stored, so it cannot be recovered.
          </p>
          <code className="mt-1 block break-all bg-term-bg p-1.5 text-term-bright">{issued}</code>
        </div>
      )}
      {tokens.length === 0 ? (
        <p className="px-2 py-2 text-term-dim">No tokens issued.</p>
      ) : (
        <ul className="divide-y divide-term-border/50">
          {tokens.map((token) => (
            <li key={token.id} className="px-2 py-1">
              <div className="flex items-baseline gap-2">
                <span className="truncate text-term-bright">{token.name}</span>
                <span
                  className={clsx(
                    'ml-auto shrink-0 text-2xs',
                    token.revokedAt ? 'text-term-down' : 'text-term-up',
                  )}
                >
                  {token.revokedAt ? 'REVOKED' : 'ACTIVE'}
                </span>
              </div>
              <div className="text-2xs text-term-faint">
                {token.id} · {token.scopes.join(' ')} ·{' '}
                {token.lastUsedAt ? `used ${timeAgo(token.lastUsedAt)}` : 'never used'}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function AuditPanel({
  entries,
  verification,
}: {
  entries: AuditEntry[];
  verification: ChainVerification;
}) {
  return (
    <Panel
      title="Audit log"
      right={
        <span className={verification.valid ? 'text-term-up' : 'text-term-down'}>
          {verification.valid
            ? `chain verified (${verification.entries})`
            : `CHAIN BROKEN at ${verification.brokenAt}`}
        </span>
      }
      className="min-h-0"
      bodyClassName="min-h-0"
    >
      {!verification.valid && (
        <p className="border-b border-term-down/40 bg-term-down/10 px-2 py-1 text-term-down">
          {verification.reason}
        </p>
      )}
      <ul className="max-h-96 divide-y divide-term-border/50 overflow-y-auto">
        {entries.map((entry) => (
          <li key={entry.id} className="px-2 py-1">
            <div className="flex items-baseline gap-2">
              <span className="shrink-0 text-term-faint">{timeAgo(entry.ts)}</span>
              <span className="shrink-0 text-term-accent">{entry.action}</span>
              <span className="ml-auto shrink-0 text-2xs text-term-dim">{entry.actor}</span>
            </div>
            {entry.subjectId && (
              <div className="truncate text-2xs text-term-faint" title={entry.payload}>
                {entry.subjectType}:{entry.subjectId}
              </div>
            )}
          </li>
        ))}
      </ul>
      <p className="border-t border-term-border px-2 py-1 text-2xs text-term-faint">
        Append-only and hash-chained. UPDATE and DELETE are blocked by database triggers, and each
        entry's hash covers the previous one, so an edit anywhere breaks every hash after it.
      </p>
    </Panel>
  );
}
