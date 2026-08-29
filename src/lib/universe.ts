import sp500 from '../../data/sp500.json';
import { CRYPTO_BASES, FOREX_MAJORS, INDEXES, type Asset } from './symbols';

export interface Sp500Snapshot {
  index: string;
  indexName: string;
  snapshotDate: string;
  count: number;
  nominalIndexSize: number;
  complete: boolean;
  disclaimer: string;
  source: string;
  sectors: string[];
  constituents: Array<{ symbol: string; name: string; sector: string }>;
}

export const SP500: Sp500Snapshot = sp500 as Sp500Snapshot;

/** How much of the real index the bundled file covers, for the UI caveat. */
export const SP500_COVERAGE = {
  listed: SP500.count,
  nominal: SP500.nominalIndexSize,
  complete: SP500.complete,
  snapshotDate: SP500.snapshotDate,
  label: `${SP500.count} of ~${SP500.nominalIndexSize} constituents (static snapshot, ${SP500.snapshotDate})`,
};

const BY_SECTOR = new Map<string, Array<{ symbol: string; name: string; sector: string }>>();
for (const c of SP500.constituents) {
  const list = BY_SECTOR.get(c.sector) ?? [];
  list.push(c);
  BY_SECTOR.set(c.sector, list);
}

export function sectorsWithConstituents(): Array<{
  sector: string;
  constituents: Array<{ symbol: string; name: string; sector: string }>;
}> {
  return [...BY_SECTOR.entries()]
    .map(([sector, constituents]) => ({ sector, constituents }))
    .sort((a, b) => b.constituents.length - a.constituents.length);
}

const NAME_BY_SYMBOL = new Map(SP500.constituents.map((c) => [c.symbol, c.name]));
const SECTOR_BY_SYMBOL = new Map(SP500.constituents.map((c) => [c.symbol, c.sector]));

export function equityName(symbol: string): string | null {
  return NAME_BY_SYMBOL.get(symbol) ?? null;
}

export function equitySector(symbol: string): string | null {
  return SECTOR_BY_SYMBOL.get(symbol) ?? null;
}

/**
 * Everything the terminal can name without touching the network: index tiles,
 * the bundled S&P snapshot, the crypto table and the FX majors. The command
 * palette searches this first so typing a ticker is instant and costs no
 * rate budget.
 */
export function localUniverse(): Asset[] {
  const out: Asset[] = [];

  for (const index of INDEXES) {
    out.push({
      symbol: index.symbol,
      assetClass: 'index',
      name: index.name,
      currency: index.currency,
      continuous: false,
    });
  }
  for (const c of SP500.constituents) {
    out.push({ symbol: c.symbol, assetClass: 'equity', name: c.name, currency: 'USD', continuous: false });
  }
  for (const [base, meta] of Object.entries(CRYPTO_BASES)) {
    out.push({
      symbol: `${base}-USD`,
      assetClass: 'crypto',
      name: meta.name,
      currency: 'USD',
      continuous: true,
    });
  }
  for (const fx of FOREX_MAJORS) {
    out.push({
      symbol: fx.symbol,
      assetClass: 'forex',
      name: fx.name,
      currency: fx.symbol.split('/')[1] ?? 'USD',
      continuous: false,
    });
  }
  return out;
}

const UNIVERSE = localUniverse();

/** Rank: exact symbol, symbol prefix, symbol substring, then name substring. */
export function searchLocal(query: string, limit = 20): Asset[] {
  const q = query.trim().toUpperCase();
  if (!q) return [];

  const scored: Array<{ asset: Asset; score: number }> = [];
  for (const asset of UNIVERSE) {
    const symbol = asset.symbol.toUpperCase();
    const name = asset.name.toUpperCase();
    let score = -1;
    if (symbol === q) score = 0;
    else if (symbol.startsWith(q)) score = 1;
    else if (symbol.replace(/[-/^]/g, '').startsWith(q)) score = 2;
    else if (symbol.includes(q)) score = 3;
    else if (name.startsWith(q)) score = 4;
    else if (name.includes(q)) score = 5;
    if (score >= 0) scored.push({ asset, score });
  }

  scored.sort((a, b) => a.score - b.score || a.asset.symbol.localeCompare(b.asset.symbol));
  return scored.slice(0, limit).map((s) => s.asset);
}
