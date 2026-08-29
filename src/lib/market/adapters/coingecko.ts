import type { Asset, AssetClass } from '@/lib/symbols';
import { CRYPTO_BASES } from '@/lib/symbols';
import { fetchFromProvider } from '../http';
import { env } from '../providers';
import { GranularityError, resampleChecked } from '../resample';
import {
  FeedError,
  type AdapterCapabilities,
  type Candle,
  type CandleRequest,
  type CandleSeries,
  type Constituent,
  type MarketDataAdapter,
  type Quote,
} from '../types';

const PUBLIC_BASE = 'https://api.coingecko.com/api/v3';
const PRO_BASE = 'https://pro-api.coingecko.com/api/v3';

interface SimplePrice {
  [id: string]: {
    usd?: number;
    usd_24h_change?: number;
    usd_24h_vol?: number;
    last_updated_at?: number;
    [k: string]: number | undefined;
  };
}

interface MarketRow {
  id?: string; symbol?: string; name?: string; current_price?: number;
  price_change_percentage_24h?: number; high_24h?: number; low_24h?: number;
  market_cap?: number; total_volume?: number; last_updated?: string;
}

/**
 * Windows the public `/ohlc` endpoint accepts, widest first.
 *
 * CoinGecko chooses its own bar granularity from the `days` value and has
 * changed the thresholds before, so this list deliberately carries no claim
 * about what each window returns. The adapter asks for the widest window that
 * fits, then measures the bars that actually came back and rejects the response
 * if they are coarser than what the caller asked for. Validating the response
 * beats trusting a table that can silently go out of date.
 */
const OHLC_WINDOWS = [365, 180, 90, 30, 14, 7, 1] as const;

/**
 * Widest span, in days, for which `/ohlc` still returns bars fine enough to
 * aggregate into daily ones.
 *
 * Measured live rather than assumed: `days=365` comes back 4 days apart and
 * `days=90` likewise, so the granularity check rejects both and the step-down
 * lands on `days=30`. A 400-day chart therefore used to render 31 bars. Past
 * this span the adapter switches feeds instead of quietly serving a month.
 */
const MAX_OHLC_DAILY_SPAN = 30;

/** `/market_chart` refuses anything beyond a year without a key (HTTP 401). */
const PUBLIC_MARKET_CHART_MAX_DAYS = 365;

export class CoinGeckoAdapter implements MarketDataAdapter {
  readonly id = 'coingecko';
  readonly label = 'CoinGecko';
  /** Public crypto prices update roughly every minute. */
  readonly delayMinutes = 1;
  readonly classes: readonly AssetClass[] = ['crypto'];
  readonly capabilities: AdapterCapabilities = {
    quote: true,
    candles: true,
    search: true,
    constituents: false,
    news: false,
  };

  /** The public API needs no key; a demo/pro key just raises the limits. */
  isConfigured(): boolean {
    return true;
  }

  supports(asset: Asset): boolean {
    return asset.assetClass === 'crypto';
  }

  private base(): string {
    return env.coingeckoKey() && process.env.COINGECKO_PLAN === 'pro' ? PRO_BASE : PUBLIC_BASE;
  }

  private headers(): Record<string, string> {
    const key = env.coingeckoKey();
    if (!key) return {};
    return process.env.COINGECKO_PLAN === 'pro'
      ? { 'x-cg-pro-api-key': key }
      : { 'x-cg-demo-api-key': key };
  }

  private coinId(asset: Asset): string {
    const base = asset.symbol.split('-')[0]!;
    const known = CRYPTO_BASES[base];
    if (!known) {
      throw new FeedError('not_found', `No CoinGecko id mapped for ${base}`, this.label);
    }
    return known.coingeckoId;
  }

  private vsCurrency(asset: Asset): string {
    return (asset.symbol.split('-')[1] ?? 'USD').toLowerCase();
  }

  async getQuote(asset: Asset): Promise<Quote> {
    const id = this.coinId(asset);
    const vs = this.vsCurrency(asset);
    const url =
      `${this.base()}/simple/price?ids=${id}&vs_currencies=${vs}` +
      `&include_24hr_change=true&include_24hr_vol=true&include_last_updated_at=true`;

    const raw = await fetchFromProvider<SimplePrice>(this.id, url, {
      headers: this.headers(),
      dedupeKey: `cg:price:${id}:${vs}`,
    });

    const row = raw[id];
    const price = row?.[vs];
    if (typeof price !== 'number' || !Number.isFinite(price)) {
      throw new FeedError('not_found', `CoinGecko has no ${vs.toUpperCase()} price for ${id}`, this.label);
    }

    const changePct = row?.[`${vs}_24h_change`] ?? null;
    // 24h change is a percentage; derive the absolute move and the reference
    // price from it rather than leaving the header blank.
    const previousClose =
      typeof changePct === 'number' && Number.isFinite(changePct) && changePct !== -100
        ? price / (1 + changePct / 100)
        : null;

    return {
      symbol: asset.symbol,
      price,
      previousClose,
      change: previousClose === null ? null : price - previousClose,
      changePercent: typeof changePct === 'number' ? changePct : null,
      dayOpen: null,
      dayHigh: null,
      dayLow: null,
      timestamp: row?.last_updated_at ? row.last_updated_at * 1000 : Date.now(),
    };
  }

  async getCandles(asset: Asset, req: CandleRequest): Promise<CandleSeries> {
    const id = this.coinId(asset);
    const vs = this.vsCurrency(asset);
    const spanDays = Math.max(1, Math.ceil((req.to - req.from) / 86_400));
    const daily = req.resolution === 'D' || req.resolution === 'W';

    // `/ohlc` carries a true high and low but only reaches back a month at daily
    // granularity. Past that, `/market_chart` is the only keyless feed with the
    // history the chart and the Outlook warm-up actually need, and it publishes
    // one price per period rather than a bar -- so the series says hasRange:
    // false and the UI draws a line instead of inventing a candle body.
    if (daily && spanDays > MAX_OHLC_DAILY_SPAN) {
      try {
        return await this.marketChartCandles(asset, req, spanDays);
      } catch (err) {
        // Fall through to `/ohlc`: a short real-range series beats nothing.
        if (!(err instanceof FeedError)) throw err;
      }
    }

    // Widest window that does not exceed the request, then narrower ones. A
    // narrower window returns finer bars, so if the widest is too coarse for the
    // requested resolution the next one down may still work.
    const fitting = OHLC_WINDOWS.filter((days) => days <= spanDays);
    // A request narrower than the smallest window still gets the smallest window.
    const candidates: number[] = fitting.length > 0 ? [...fitting] : [1];

    let lastGranularityError: GranularityError | null = null;

    for (const days of candidates) {
      const url = `${this.base()}/coins/${id}/ohlc?vs_currency=${vs}&days=${days}`;
      const raw = await fetchFromProvider<Array<[number, number, number, number, number]>>(this.id, url, {
        headers: this.headers(),
        dedupeKey: `cg:ohlc:${id}:${vs}:${days}`,
      });

      if (!Array.isArray(raw) || raw.length === 0) continue;

      const native: Candle[] = raw
        .filter((row) => Array.isArray(row) && row.length >= 5 && row.every((n) => Number.isFinite(n)))
        .map(([ms, o, h, l, c]) => ({ t: Math.floor(ms / 1000), o, h, l, c, v: null }));

      if (native.length === 0) continue;

      let bars: Candle[];
      try {
        bars = resampleChecked(native, req.resolution);
      } catch (err) {
        if (err instanceof GranularityError) {
          // This window came back too coarse. Try a narrower one rather than
          // passing coarse bars off as fine ones.
          lastGranularityError = err;
          continue;
        }
        throw err;
      }

      const inWindow = bars.filter((b) => b.t >= req.from && b.t <= req.to);
      if (inWindow.length === 0) continue;

      // Deliberately returns whatever coverage the feed could supply rather than
      // failing outright: a 30-bar crypto chart is far more useful than none, and
      // the Outlook reports for itself which components lacked enough history.
      return { bars: inWindow, resolution: req.resolution, hasRange: true, hasVolume: false };
    }

    throw new FeedError(
      'unsupported',
      lastGranularityError
        ? `CoinGecko's public OHLC feed could not supply ${req.resolution} bars for ${asset.symbol}: ` +
          `${lastGranularityError.message} Set COINGECKO_API_KEY with COINGECKO_PLAN=pro for longer history.`
        : `CoinGecko returned no usable OHLC for ${id}`,
      this.label,
    );
  }

  /**
   * Long daily history from `/market_chart`.
   *
   * The endpoint returns sampled prices, not bars: one price per period, with no
   * high or low. Each bucket's close is the last price sampled inside it and
   * o/h/l are set equal to it, which is what `hasRange: false` tells the chart
   * and the indicators. Volume is dropped rather than reused -- `total_volumes`
   * is a rolling 24-hour figure, not the volume of the bar it sits beside.
   */
  private async marketChartCandles(
    asset: Asset,
    req: CandleRequest,
    spanDays: number,
  ): Promise<CandleSeries> {
    const id = this.coinId(asset);
    const vs = this.vsCurrency(asset);
    const pro = this.base() === PRO_BASE;
    const days = pro ? spanDays : Math.min(spanDays, PUBLIC_MARKET_CHART_MAX_DAYS);

    const raw = await fetchFromProvider<{ prices?: Array<[number, number]> }>(
      this.id,
      `${this.base()}/coins/${id}/market_chart?vs_currency=${vs}&days=${days}`,
      { headers: this.headers(), dedupeKey: `cg:chart:${id}:${vs}:${days}` },
    );

    const points: Candle[] = (raw?.prices ?? [])
      .filter((row) => Array.isArray(row) && row.length >= 2 && row.every((n) => Number.isFinite(n)))
      .map(([ms, price]) => ({ t: Math.floor(ms / 1000), o: price, h: price, l: price, c: price, v: null }));

    if (points.length === 0) {
      throw new FeedError('not_found', `CoinGecko returned no price history for ${id}`, this.label);
    }

    // Flatten each bucket to its close. Where two samples land in the same
    // bucket -- the day the last sample is "now" -- rolling them up would leave
    // a high and a low built from two arbitrary snapshots, which is a range the
    // feed never reported and the series has already declared it does not have.
    const bars = resampleChecked(points, req.resolution)
      .filter((b) => b.t >= req.from && b.t <= req.to)
      .map((b) => ({ ...b, o: b.c, h: b.c, l: b.c }));
    if (bars.length === 0) {
      throw new FeedError(
        'not_found',
        `CoinGecko returned no ${req.resolution} prices for ${asset.symbol} in the requested window`,
        this.label,
      );
    }
    return { bars, resolution: req.resolution, hasRange: false, hasVolume: false };
  }

  async searchSymbols(query: string): Promise<Asset[]> {
    const q = query.trim().toUpperCase();
    return Object.entries(CRYPTO_BASES)
      .filter(([base, meta]) => base.includes(q) || meta.name.toUpperCase().includes(q))
      .map(([base, meta]) => ({
        symbol: `${base}-USD`,
        assetClass: 'crypto' as const,
        name: meta.name,
        currency: 'USD',
        continuous: true,
      }))
      .slice(0, 25);
  }

  /** Top-N by market cap — the crypto analogue of an index constituent list. */
  async getTopByMarketCap(limit = 20): Promise<Constituent[]> {
    const url =
      `${this.base()}/coins/markets?vs_currency=usd&order=market_cap_desc` +
      `&per_page=${Math.min(limit, 250)}&page=1&sparkline=false`;
    const raw = await fetchFromProvider<MarketRow[]>(this.id, url, {
      headers: this.headers(),
      dedupeKey: `cg:markets:${limit}`,
    });
    if (!Array.isArray(raw)) {
      throw new FeedError('bad_response', 'CoinGecko /coins/markets returned a non-array', this.label);
    }
    return raw
      .filter((r) => r.symbol && r.name)
      .map((r) => ({
        symbol: `${r.symbol!.toUpperCase()}-USD`,
        name: r.name!,
        sector: 'Crypto',
      }));
  }

  /** Market rows keep price + cap together, which the overview grid needs. */
  async getMarkets(limit = 20): Promise<Array<{ symbol: string; name: string; price: number; changePercent: number | null; marketCap: number | null; volume: number | null; timestamp: number }>> {
    const url =
      `${this.base()}/coins/markets?vs_currency=usd&order=market_cap_desc` +
      `&per_page=${Math.min(limit, 250)}&page=1&sparkline=false&price_change_percentage=24h`;
    const raw = await fetchFromProvider<MarketRow[]>(this.id, url, {
      headers: this.headers(),
      dedupeKey: `cg:marketsfull:${limit}`,
    });
    if (!Array.isArray(raw)) {
      throw new FeedError('bad_response', 'CoinGecko /coins/markets returned a non-array', this.label);
    }
    return raw
      .filter((r) => r.symbol && typeof r.current_price === 'number')
      .map((r) => ({
        symbol: `${r.symbol!.toUpperCase()}-USD`,
        name: r.name ?? r.symbol!.toUpperCase(),
        price: r.current_price!,
        changePercent: typeof r.price_change_percentage_24h === 'number' ? r.price_change_percentage_24h : null,
        marketCap: typeof r.market_cap === 'number' ? r.market_cap : null,
        volume: typeof r.total_volume === 'number' ? r.total_volume : null,
        timestamp: r.last_updated ? Date.parse(r.last_updated) || Date.now() : Date.now(),
      }));
  }
}
