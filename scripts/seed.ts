/**
 * Seed the demo state: a watchlist, a funded paper account, and a first pull of
 * news so the terminal has something to show on a cold start.
 */
import { ensureAccount } from '@/lib/gateway/paper';
import { readWatchlist, seedWatchlist } from '@/lib/watchlist';
import { ingestNews } from '@/lib/news';
import { getNews } from '@/lib/market/service';
import { adapterStatus } from '@/lib/market/registry';

async function main() {
  const added = seedWatchlist();
  const watchlist = readWatchlist();
  console.log(
    added > 0
      ? `Seeded watchlist with ${added} symbols.`
      : `Watchlist already has ${watchlist.length} symbols; left it alone.`,
  );

  const startingCash = Number(process.env.GMT_PAPER_STARTING_CASH ?? 100_000);
  const account = ensureAccount('paper-default', startingCash);
  console.log(`Paper account "${account.name}" ready with ${account.cash.toLocaleString()} cash.`);

  console.log('\nData sources:');
  for (const adapter of adapterStatus()) {
    const state = adapter.configured ? 'configured' : adapter.requiresKey ? 'NO KEY' : 'keyless';
    console.log(`  ${adapter.label.padEnd(22)} ${state.padEnd(12)} ${adapter.capabilities.join(', ')}`);
  }

  console.log('\nFetching an initial news pull...');
  const news = await getNews({ days: 3, limit: 80 });
  if (news.ok) {
    const stored = ingestNews(news.data);
    console.log(`  stored ${stored} headlines from ${news.provenance.source}.`);
  } else {
    // A cold start with no network is normal; say so rather than failing.
    console.log(`  no news yet: ${news.message}`);
    console.log('  (the worker retries on its own schedule)');
  }

  console.log('\nDone. Run `pnpm dev` and open http://localhost:3000');
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
