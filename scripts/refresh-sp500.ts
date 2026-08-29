/**
 * Replace the bundled S&P 500 snapshot with a live constituent list.
 *
 *   pnpm refresh:sp500
 *
 * `data/sp500.json` ships as a hand-compiled partial snapshot so that search and
 * the sector heatmap work on a clean checkout with no API key. This script
 * overwrites it with whatever a configured provider actually returns.
 *
 * It refuses to write a list that is obviously worse than the one already on
 * disk. A provider that answers with fifty names because the endpoint is on a
 * paid plan would otherwise silently shrink the universe, and the terminal would
 * look like it had lost four hundred companies.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getIndexConstituents } from '@/lib/market/service';
import { SP500 } from '@/lib/universe';

const TARGET = path.join(process.cwd(), 'data', 'sp500.json');
/** Accept a refresh only if it carries at least this fraction of what we have. */
const MIN_RATIO = 0.9;

async function main() {
  const force = process.argv.includes('--force');

  console.log(`Current snapshot: ${SP500.count} constituents (${SP500.snapshotDate})`);
  console.log('Fetching a live constituent list for ^GSPC...\n');

  const result = await getIndexConstituents('^GSPC');

  if (!result.ok) {
    console.error(`Could not fetch constituents: ${result.message}`);
    console.error(
      '\nThis endpoint is on a paid plan for most providers. The bundled snapshot\n' +
        'is unchanged, and the terminal keeps working from it.',
    );
    process.exit(1);
  }

  const fetched = result.data.filter((c) => c.symbol);
  console.log(`${result.provenance.source} returned ${fetched.length} constituents.`);

  const withSector = fetched.filter((c) => c.sector && c.sector !== 'Unknown').length;
  console.log(`${withSector} of them carry a sector classification.`);

  if (!force && fetched.length < SP500.count * MIN_RATIO) {
    console.error(
      `\nRefusing to overwrite: ${fetched.length} names is less than ${Math.round(MIN_RATIO * 100)}% ` +
        `of the ${SP500.count} already bundled.\n` +
        'That usually means the endpoint returned a truncated list rather than the full index.\n' +
        'Re-run with --force if you are sure.',
    );
    process.exit(1);
  }

  if (withSector === 0) {
    console.warn(
      '\nWarning: no sector data in the response. The heatmap groups by sector, so\n' +
        'every name would land in a single "Unknown" bucket. Carrying sectors over\n' +
        'from the bundled snapshot where the symbol matches.',
    );
  }

  // Preserve the sectors we already know for symbols the provider did not classify,
  // so a sector-less response does not flatten the heatmap.
  const knownSector = new Map(SP500.constituents.map((c) => [c.symbol, c.sector]));
  const knownName = new Map(SP500.constituents.map((c) => [c.symbol, c.name]));

  const constituents = fetched
    .map((c) => ({
      symbol: c.symbol,
      name: c.name && c.name !== c.symbol ? c.name : (knownName.get(c.symbol) ?? c.symbol),
      sector:
        c.sector && c.sector !== 'Unknown'
          ? c.sector
          : (knownSector.get(c.symbol) ?? 'Unknown'),
    }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));

  const sectors = [...new Set(constituents.map((c) => c.sector))].sort();
  const unclassified = constituents.filter((c) => c.sector === 'Unknown').length;

  const document = {
    index: '^GSPC',
    indexName: 'S&P 500',
    snapshotDate: new Date().toISOString().slice(0, 10),
    count: constituents.length,
    nominalIndexSize: 500,
    complete: constituents.length >= 490,
    disclaimer:
      `Fetched from ${result.provenance.source} on ${new Date().toISOString().slice(0, 10)}. ` +
      'Index membership changes several times a year; re-run `pnpm refresh:sp500` to update. ' +
      (unclassified > 0
        ? `${unclassified} names have no sector classification and are grouped as "Unknown".`
        : ''),
    source: result.provenance.source,
    sectors,
    constituents,
  };

  await fs.writeFile(TARGET, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

  console.log(`\nWrote ${constituents.length} constituents across ${sectors.length} sectors.`);
  if (unclassified > 0) console.log(`${unclassified} could not be classified into a sector.`);
  console.log(`${TARGET}`);
  console.log('\nRestart the app to pick up the new snapshot.');
}

main().catch((err) => {
  console.error('Refresh failed:', err);
  process.exit(1);
});
