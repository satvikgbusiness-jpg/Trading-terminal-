/**
 * Canonical symbol model.
 *
 * Every asset in the terminal is addressed by a single canonical string so that
 * watchlists, cache keys, DB rows and URLs all agree. Provider-specific encodings
 * live inside the adapters and never leak out.
 *
 *   equity  AAPL              plain ticker
 *   index   ^GSPC             caret prefix
 *   crypto  BTC-USD           BASE-QUOTE
 *   forex   EUR/USD           BASE/QUOTE
 */

export type AssetClass = 'equity' | 'index' | 'crypto' | 'forex';

export interface Asset {
  /** Canonical symbol, e.g. "AAPL", "^GSPC", "BTC-USD", "EUR/USD". */
  symbol: string;
  assetClass: AssetClass;
  /** Human-readable name. Falls back to the symbol when unknown. */
  name: string;
  /** Base currency the instrument is priced in. */
  currency: string;
  /** True for instruments that trade continuously (crypto). */
  continuous: boolean;
}

export const INDEXES: Array<Asset & { region: string }> = [
  { symbol: '^GSPC', assetClass: 'index', name: 'S&P 500', currency: 'USD', continuous: false, region: 'US' },
  { symbol: '^IXIC', assetClass: 'index', name: 'Nasdaq Composite', currency: 'USD', continuous: false, region: 'US' },
  { symbol: '^DJI', assetClass: 'index', name: 'Dow Jones Industrial Average', currency: 'USD', continuous: false, region: 'US' },
  { symbol: '^FTSE', assetClass: 'index', name: 'FTSE 100', currency: 'GBP', continuous: false, region: 'UK' },
  { symbol: '^GDAXI', assetClass: 'index', name: 'DAX', currency: 'EUR', continuous: false, region: 'DE' },
  { symbol: '^N225', assetClass: 'index', name: 'Nikkei 225', currency: 'JPY', continuous: false, region: 'JP' },
];

/**
 * Crypto base assets the terminal knows by name. The adapter can serve any pair
 * CoinGecko lists; this table only supplies display names and id mapping.
 */
export const CRYPTO_BASES: Record<string, { name: string; coingeckoId: string }> = {
  BTC: { name: 'Bitcoin', coingeckoId: 'bitcoin' },
  ETH: { name: 'Ethereum', coingeckoId: 'ethereum' },
  USDT: { name: 'Tether', coingeckoId: 'tether' },
  BNB: { name: 'BNB', coingeckoId: 'binancecoin' },
  SOL: { name: 'Solana', coingeckoId: 'solana' },
  USDC: { name: 'USD Coin', coingeckoId: 'usd-coin' },
  XRP: { name: 'XRP', coingeckoId: 'ripple' },
  ADA: { name: 'Cardano', coingeckoId: 'cardano' },
  DOGE: { name: 'Dogecoin', coingeckoId: 'dogecoin' },
  TRX: { name: 'TRON', coingeckoId: 'tron' },
  AVAX: { name: 'Avalanche', coingeckoId: 'avalanche-2' },
  LINK: { name: 'Chainlink', coingeckoId: 'chainlink' },
  DOT: { name: 'Polkadot', coingeckoId: 'polkadot' },
  MATIC: { name: 'Polygon', coingeckoId: 'matic-network' },
  TON: { name: 'Toncoin', coingeckoId: 'the-open-network' },
  SHIB: { name: 'Shiba Inu', coingeckoId: 'shiba-inu' },
  LTC: { name: 'Litecoin', coingeckoId: 'litecoin' },
  BCH: { name: 'Bitcoin Cash', coingeckoId: 'bitcoin-cash' },
  UNI: { name: 'Uniswap', coingeckoId: 'uniswap' },
  ATOM: { name: 'Cosmos', coingeckoId: 'cosmos' },
  XLM: { name: 'Stellar', coingeckoId: 'stellar' },
  ETC: { name: 'Ethereum Classic', coingeckoId: 'ethereum-classic' },
  NEAR: { name: 'NEAR Protocol', coingeckoId: 'near' },
  APT: { name: 'Aptos', coingeckoId: 'aptos' },
  ARB: { name: 'Arbitrum', coingeckoId: 'arbitrum' },
};

/** The FX majors. */
export const FOREX_MAJORS: Array<{ symbol: string; name: string }> = [
  { symbol: 'EUR/USD', name: 'Euro / US Dollar' },
  { symbol: 'GBP/USD', name: 'British Pound / US Dollar' },
  { symbol: 'USD/JPY', name: 'US Dollar / Japanese Yen' },
  { symbol: 'USD/CHF', name: 'US Dollar / Swiss Franc' },
  { symbol: 'AUD/USD', name: 'Australian Dollar / US Dollar' },
  { symbol: 'USD/CAD', name: 'US Dollar / Canadian Dollar' },
  { symbol: 'NZD/USD', name: 'New Zealand Dollar / US Dollar' },
  { symbol: 'EUR/GBP', name: 'Euro / British Pound' },
  { symbol: 'EUR/JPY', name: 'Euro / Japanese Yen' },
  { symbol: 'GBP/JPY', name: 'British Pound / Japanese Yen' },
];

const INDEX_BY_SYMBOL = new Map(INDEXES.map((i) => [i.symbol, i]));
const FOREX_BY_SYMBOL = new Map(FOREX_MAJORS.map((f) => [f.symbol, f]));

/** Symbols are uppercased and whitespace-trimmed; nothing else is rewritten. */
export function normalizeSymbol(raw: string): string {
  return raw.trim().toUpperCase();
}

export class UnknownSymbolError extends Error {
  constructor(public readonly symbol: string) {
    super(`Unrecognised symbol: ${symbol}`);
    this.name = 'UnknownSymbolError';
  }
}

const EQUITY_RE = /^[A-Z][A-Z0-9]{0,5}(\.[A-Z])?$/;
const FOREX_RE = /^([A-Z]{3})\/([A-Z]{3})$/;
const CRYPTO_RE = /^([A-Z0-9]{2,10})-([A-Z]{3,4})$/;

/**
 * Classify a canonical symbol into an Asset. Pure and total: throws rather than
 * guessing when the shape matches nothing we serve.
 */
export function resolveAsset(raw: string): Asset {
  const symbol = normalizeSymbol(raw);

  const index = INDEX_BY_SYMBOL.get(symbol);
  if (index) return { ...index };

  const fx = symbol.match(FOREX_RE);
  if (fx) {
    const known = FOREX_BY_SYMBOL.get(symbol);
    return {
      symbol,
      assetClass: 'forex',
      name: known?.name ?? `${fx[1]} / ${fx[2]}`,
      currency: fx[2]!,
      continuous: false,
    };
  }

  const crypto = symbol.match(CRYPTO_RE);
  if (crypto) {
    const base = crypto[1]!;
    return {
      symbol,
      assetClass: 'crypto',
      name: CRYPTO_BASES[base]?.name ?? base,
      currency: crypto[2]!,
      continuous: true,
    };
  }

  if (symbol.startsWith('^')) {
    return { symbol, assetClass: 'index', name: symbol, currency: 'USD', continuous: false };
  }

  if (EQUITY_RE.test(symbol)) {
    return { symbol, assetClass: 'equity', name: symbol, currency: 'USD', continuous: false };
  }

  throw new UnknownSymbolError(symbol);
}

/** Non-throwing variant for user input paths. */
export function tryResolveAsset(raw: string): Asset | null {
  try {
    return resolveAsset(raw);
  } catch {
    return null;
  }
}

/** URL-safe encoding for symbols containing "/" or "^". */
export function encodeSymbol(symbol: string): string {
  return encodeURIComponent(symbol);
}

export function decodeSymbol(encoded: string): string {
  return normalizeSymbol(decodeURIComponent(encoded));
}
