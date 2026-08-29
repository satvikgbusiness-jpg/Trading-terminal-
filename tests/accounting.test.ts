import { describe, expect, it } from 'vitest';
import { applyFill, FLAT, marketValue, unrealizedPnl, valuePortfolio, type Position } from '@/lib/gateway/accounting';

const buy = (quantity: number, price: number) => ({ side: 'buy' as const, quantity, price });
const sell = (quantity: number, price: number) => ({ side: 'sell' as const, quantity, price });

describe('applyFill - opening and adding', () => {
  it('opens a long from flat at the fill price', () => {
    const out = applyFill(FLAT, buy(10, 100));
    expect(out.position).toEqual({ quantity: 10, averagePrice: 100, realizedPnl: 0 });
    expect(out.cashDelta).toBe(-1000);
    expect(out.realizedPnl).toBe(0);
    expect(out.openedQuantity).toBe(10);
  });

  it('opens a short from flat and credits cash', () => {
    const out = applyFill(FLAT, sell(10, 100));
    expect(out.position).toEqual({ quantity: -10, averagePrice: 100, realizedPnl: 0 });
    expect(out.cashDelta).toBe(1000);
  });

  it('blends the average when adding to a long', () => {
    const after = applyFill({ quantity: 10, averagePrice: 100, realizedPnl: 0 }, buy(10, 120));
    expect(after.position.quantity).toBe(20);
    expect(after.position.averagePrice).toBeCloseTo(110, 10);
    expect(after.realizedPnl).toBe(0);
  });

  it('blends the average when adding to a short', () => {
    const after = applyFill({ quantity: -10, averagePrice: 100, realizedPnl: 0 }, sell(30, 140));
    expect(after.position.quantity).toBe(-40);
    expect(after.position.averagePrice).toBeCloseTo((10 * 100 + 30 * 140) / 40, 10);
  });
});

describe('applyFill - reducing and closing', () => {
  it('books profit on a partial close of a long and keeps the average', () => {
    const out = applyFill({ quantity: 10, averagePrice: 100, realizedPnl: 0 }, sell(4, 130));
    expect(out.realizedPnl).toBeCloseTo(4 * 30, 10);
    expect(out.position.quantity).toBe(6);
    expect(out.position.averagePrice).toBe(100);
    expect(out.position.realizedPnl).toBeCloseTo(120, 10);
    expect(out.closedQuantity).toBe(4);
    expect(out.openedQuantity).toBe(0);
  });

  it('books profit on a short when price falls', () => {
    const out = applyFill({ quantity: -10, averagePrice: 100, realizedPnl: 0 }, buy(10, 80));
    expect(out.realizedPnl).toBeCloseTo(200, 10); // sold at 100, bought back at 80
    expect(out.position.quantity).toBe(0);
  });

  it('books a loss on a short when price rises', () => {
    const out = applyFill({ quantity: -10, averagePrice: 100, realizedPnl: 0 }, buy(10, 130));
    expect(out.realizedPnl).toBeCloseTo(-300, 10);
  });

  it('zeroes the average price once flat, so no stale entry price survives', () => {
    const out = applyFill({ quantity: 5, averagePrice: 100, realizedPnl: 0 }, sell(5, 90));
    expect(out.position.quantity).toBe(0);
    expect(out.position.averagePrice).toBe(0);
    expect(out.position.realizedPnl).toBeCloseTo(-50, 10);
  });
});

describe('applyFill - flipping through zero', () => {
  it('closes the long, books its P&L, and re-opens short at the fill price', () => {
    // Long 10 @ 100. Sell 25 @ 130: closes 10 (+300), opens short 15 @ 130.
    const out = applyFill({ quantity: 10, averagePrice: 100, realizedPnl: 0 }, sell(25, 130));
    expect(out.realizedPnl).toBeCloseTo(300, 10);
    expect(out.closedQuantity).toBe(10);
    expect(out.openedQuantity).toBe(15);
    expect(out.position.quantity).toBe(-15);
    // The new short must start at the fill price, not inherit the old average.
    expect(out.position.averagePrice).toBe(130);
    expect(out.cashDelta).toBeCloseTo(25 * 130, 10);
  });

  it('flips from short to long the same way', () => {
    const out = applyFill({ quantity: -8, averagePrice: 50, realizedPnl: 0 }, buy(20, 40));
    expect(out.realizedPnl).toBeCloseTo(8 * 10, 10); // short 8 from 50 to 40
    expect(out.position.quantity).toBe(12);
    expect(out.position.averagePrice).toBe(40);
  });

  it('does not double-count P&L across a flip and a subsequent close', () => {
    let p: Position = FLAT;
    let cash = 0;
    for (const fill of [buy(10, 100), sell(25, 130), buy(15, 120)]) {
      const out = applyFill(p, fill);
      p = out.position;
      cash += out.cashDelta;
    }
    // Long 10 @100 -> sell 25 @130 (+300, short 15 @130) -> buy 15 @120 (+150).
    expect(p.quantity).toBe(0);
    expect(p.realizedPnl).toBeCloseTo(450, 10);
    // With no open position, cash must equal total realised P&L exactly.
    expect(cash).toBeCloseTo(p.realizedPnl, 10);
  });
});

describe('applyFill - invariants', () => {
  it('keeps cash consistent with realised P&L over a random round trip', () => {
    // Any sequence that returns to flat must leave cash equal to realised P&L.
    let p: Position = FLAT;
    let cash = 0;
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

    const fills = Array.from({ length: 40 }, () => {
      const side = rand() > 0.5 ? 'buy' : 'sell';
      return { side, quantity: Math.ceil(rand() * 9), price: 80 + Math.round(rand() * 40) } as const;
    });
    for (const f of fills) {
      const out = applyFill(p, f);
      p = out.position;
      cash += out.cashDelta;
    }
    // Flatten whatever is left at a known price and compare.
    if (p.quantity !== 0) {
      const closing = applyFill(p, p.quantity > 0 ? sell(Math.abs(p.quantity), 100) : buy(Math.abs(p.quantity), 100));
      cash += closing.cashDelta;
      p = closing.position;
    }
    expect(p.quantity).toBe(0);
    expect(cash).toBeCloseTo(p.realizedPnl, 6);
  });

  it('rejects non-positive or non-finite quantities and prices', () => {
    expect(() => applyFill(FLAT, buy(0, 100))).toThrow(/positive/);
    expect(() => applyFill(FLAT, buy(-5, 100))).toThrow(/positive/);
    expect(() => applyFill(FLAT, buy(5, 0))).toThrow(/positive/);
    expect(() => applyFill(FLAT, buy(Number.NaN, 100))).toThrow(/finite/);
    expect(() => applyFill(FLAT, buy(5, Number.POSITIVE_INFINITY))).toThrow(/finite/);
  });
});

describe('valuation', () => {
  it('values longs and shorts with the right sign', () => {
    expect(marketValue({ quantity: 10, averagePrice: 100, realizedPnl: 0 }, 120)).toBe(1200);
    expect(marketValue({ quantity: -10, averagePrice: 100, realizedPnl: 0 }, 120)).toBe(-1200);
    expect(unrealizedPnl({ quantity: 10, averagePrice: 100, realizedPnl: 0 }, 120)).toBe(200);
    expect(unrealizedPnl({ quantity: -10, averagePrice: 100, realizedPnl: 0 }, 120)).toBe(-200);
    expect(unrealizedPnl(FLAT, 120)).toBe(0);
  });

  it('excludes unpriced positions from equity and names them', () => {
    const v = valuePortfolio(
      5_000,
      10_000,
      [
        { symbol: 'AAPL', position: { quantity: 10, averagePrice: 100, realizedPnl: 50 } },
        { symbol: 'ZZZZ', position: { quantity: 5, averagePrice: 20, realizedPnl: 0 } },
      ],
      { AAPL: 120, ZZZZ: null },
    );
    expect(v.positionsValue).toBe(1200);
    expect(v.equity).toBe(6200);
    expect(v.unpricedSymbols).toEqual(['ZZZZ']);
    // The unpriced name must not be silently marked at cost.
    expect(v.unrealizedPnl).toBe(200);
  });

  it('computes total P&L against starting cash', () => {
    const v = valuePortfolio(12_000, 10_000, [], {});
    expect(v.totalPnl).toBe(2000);
    expect(v.totalPnlPercent).toBeCloseTo(20, 10);
  });

  it('does not divide by zero on a zero-funded account', () => {
    expect(valuePortfolio(0, 0, [], {}).totalPnlPercent).toBe(0);
  });
});
