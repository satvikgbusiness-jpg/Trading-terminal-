/**
 * Background worker.
 *
 * Handles the work that should happen whether or not a browser tab is open:
 *
 *   - refresh news for watchlist symbols and score it
 *   - expire lapsed approval requests
 *   - warm the candle cache so ticker pages open instantly
 *   - prune the disk cache and old news rows
 *
 * Everything it does goes through the same rate-limited scheduler the web app
 * uses, so it competes for the same budget rather than doubling consumption.
 */
import { pruneCache } from '@/lib/market/cache-maintenance';
import { getCandles, getNews } from '@/lib/market/service';
import { adapterStatus } from '@/lib/market/registry';
import { ingestNews, pruneNews } from '@/lib/news';
import { readWatchlist, seedWatchlist } from '@/lib/watchlist';
import { expireStaleApprovals } from '@/lib/gateway/service';

const NEWS_INTERVAL_MS = Number(process.env.GMT_WORKER_NEWS_MS ?? 5 * 60_000);
const APPROVAL_INTERVAL_MS = 30_000;
const CANDLE_INTERVAL_MS = Number(process.env.GMT_WORKER_CANDLE_MS ?? 30 * 60_000);
const PRUNE_INTERVAL_MS = 6 * 60 * 60_000;

let stopping = false;
const timers: Array<ReturnType<typeof setInterval>> = [];

function log(message: string): void {
  console.log(`${new Date().toISOString().slice(11, 19)} ${message}`);
}

/** Run `task` now and then on an interval, never letting a throw kill the loop. */
function every(intervalMs: number, name: string, task: () => Promise<void>): void {
  const run = async () => {
    if (stopping) return;
    try {
      await task();
    } catch (err) {
      log(`${name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  void run();
  timers.push(setInterval(run, intervalMs));
}

async function refreshNews(): Promise<void> {
  const symbols = readWatchlist().map((item) => item.symbol);

  // The general pull covers the RSS feeds and populates the market-wide stream.
  const general = await getNews({ days: 3, limit: 80 });
  let stored = general.ok ? ingestNews(general.data) : 0;

  // Then company news for equities, which is the only class the news providers
  // key by symbol.
  for (const symbol of symbols.slice(0, 12)) {
    if (stopping) return;
    const result = await getNews({ symbol, days: 5, limit: 30 });
    if (result.ok) stored += ingestNews(result.data);
  }

  log(stored > 0 ? `news: stored ${stored} new headlines` : 'news: nothing new');
}

async function warmCandles(): Promise<void> {
  const symbols = readWatchlist().map((item) => item.symbol);
  let warmed = 0;
  for (const symbol of symbols) {
    if (stopping) return;
    const result = await getCandles(symbol, { resolution: 'D', lookbackDays: 400 });
    if (result.ok) warmed += 1;
  }
  log(`candles: ${warmed}/${symbols.length} series cached`);
}

async function sweepApprovals(): Promise<void> {
  const expired = expireStaleApprovals();
  if (expired > 0) log(`approvals: expired ${expired} lapsed request(s)`);
}

async function prune(): Promise<void> {
  const files = await pruneCache();
  const rows = pruneNews(60);
  if (files > 0 || rows > 0) log(`prune: ${files} cache files, ${rows} news rows`);
}

function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  log(`${signal} received, stopping.`);
  for (const timer of timers) clearInterval(timer);
  // Give any in-flight fetch a moment to settle before exiting.
  setTimeout(() => process.exit(0), 250);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

log('worker starting');
const unconfigured = adapterStatus().filter((a) => a.requiresKey && !a.configured);
if (unconfigured.length > 0) {
  log(`no API key for: ${unconfigured.map((a) => a.label).join(', ')} -- those feeds will be skipped`);
}

// A brand-new database has no watchlist, and the worker would then have nothing
// to do; seed it so a fresh checkout starts producing data immediately.
if (readWatchlist().length === 0) {
  const added = seedWatchlist();
  log(`seeded watchlist with ${added} symbols`);
}

every(APPROVAL_INTERVAL_MS, 'approvals', sweepApprovals);
every(NEWS_INTERVAL_MS, 'news', refreshNews);
every(CANDLE_INTERVAL_MS, 'candles', warmCandles);
every(PRUNE_INTERVAL_MS, 'prune', prune);
