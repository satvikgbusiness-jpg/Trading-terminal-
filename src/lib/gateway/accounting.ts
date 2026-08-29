/**
 * Position accounting, as pure functions.
 *
 * Kept free of database access so the long/short/flip arithmetic can be tested
 * exhaustively. Quantities are signed: positive is long, negative is short.
 */

export interface Position {
  /** Signed. Positive long, negative short, zero flat. */
  quantity: number;
  /** Weighted average entry price of the currently open quantity. */
  averagePrice: number;
  /** Cumulative realised profit and loss booked on this symbol. */
  realizedPnl: number;
}

export interface Fill {
  side: 'buy' | 'sell';
  /** Always positive. */
  quantity: number;
  price: number;
}

export interface FillOutcome {
  position: Position;
  /** Realised P&L booked by this fill alone. */
  realizedPnl: number;
  /** Change in cash. Negative when buying, positive when selling. */
  cashDelta: number;
  /** How much of the fill closed existing exposure. */
  closedQuantity: number;
  /** How much of the fill opened new exposure. */
  openedQuantity: number;
}

export const FLAT: Position = { quantity: 0, averagePrice: 0, realizedPnl: 0 };

/**
 * Apply a fill to a position.
 *
 * Three cases, and the third is the one that is usually wrong in a naive
 * implementation: a fill larger than an opposing position closes it, books the
 * P&L on the closed portion only, and opens a new position in the other
 * direction at the fill price. The re-opened side must not inherit the old
 * average, or every subsequent P&L figure is wrong.
 */
export function applyFill(position: Position, fill: Fill): FillOutcome {
  if (!Number.isFinite(fill.quantity) || fill.quantity <= 0) {
    throw new Error('Fill quantity must be a positive, finite number');
  }
  if (!Number.isFinite(fill.price) || fill.price <= 0) {
    throw new Error('Fill price must be a positive, finite number');
  }

  const signed = fill.side === 'buy' ? fill.quantity : -fill.quantity;
  const cashDelta = -signed * fill.price;
  const current = position.quantity;

  // 1. Opening from flat, or adding to the same side: blend the average.
  if (current === 0 || Math.sign(current) === Math.sign(signed)) {
    const totalQty = current + signed;
    const averagePrice =
      current === 0
        ? fill.price
        : (Math.abs(current) * position.averagePrice + fill.quantity * fill.price) / Math.abs(totalQty);

    return {
      position: { quantity: totalQty, averagePrice, realizedPnl: position.realizedPnl },
      realizedPnl: 0,
      cashDelta,
      closedQuantity: 0,
      openedQuantity: fill.quantity,
    };
  }

  // 2 and 3. Reducing, closing, or flipping.
  const closedQuantity = Math.min(fill.quantity, Math.abs(current));
  // A long books (exit - entry); a short books (entry - exit).
  const direction = Math.sign(current);
  const realizedPnl = closedQuantity * (fill.price - position.averagePrice) * direction;
  const remaining = fill.quantity - closedQuantity;
  const newQuantity = current + signed;

  if (remaining > 0) {
    // Flipped through zero: the new side starts fresh at the fill price.
    return {
      position: {
        quantity: newQuantity,
        averagePrice: fill.price,
        realizedPnl: position.realizedPnl + realizedPnl,
      },
      realizedPnl,
      cashDelta,
      closedQuantity,
      openedQuantity: remaining,
    };
  }

  // Reduced or fully closed: the average of what remains is unchanged.
  return {
    position: {
      quantity: newQuantity,
      // A flat position has no meaningful average; zero it so stale numbers
      // cannot leak into a later valuation.
      averagePrice: newQuantity === 0 ? 0 : position.averagePrice,
      realizedPnl: position.realizedPnl + realizedPnl,
    },
    realizedPnl,
    cashDelta,
    closedQuantity,
    openedQuantity: 0,
  };
}

/** Mark-to-market value of an open position at a given price. */
export function marketValue(position: Position, price: number): number {
  return position.quantity * price;
}

/** Unrealised P&L: what closing the position at `price` would book. */
export function unrealizedPnl(position: Position, price: number): number {
  if (position.quantity === 0) return 0;
  return (price - position.averagePrice) * position.quantity;
}

export interface PortfolioValuation {
  cash: number;
  /** Sum of position market values. Negative for a net short book. */
  positionsValue: number;
  /** cash + positionsValue. */
  equity: number;
  unrealizedPnl: number;
  realizedPnl: number;
  /** equity - startingCash. */
  totalPnl: number;
  totalPnlPercent: number;
  /** Symbols whose price could not be resolved, so are excluded from equity. */
  unpricedSymbols: string[];
}

/**
 * Value a portfolio.
 *
 * A position whose price is unavailable is reported in `unpricedSymbols` and
 * excluded from the totals rather than valued at zero or at its entry price.
 * Marking an unpriced position at cost would quietly show a flat P&L on a
 * position that may have moved; the UI shows the gap instead.
 */
export function valuePortfolio(
  cash: number,
  startingCash: number,
  positions: Array<{ symbol: string; position: Position }>,
  prices: Record<string, number | null>,
): PortfolioValuation {
  let positionsValue = 0;
  let unrealized = 0;
  let realized = 0;
  const unpricedSymbols: string[] = [];

  for (const { symbol, position } of positions) {
    realized += position.realizedPnl;
    if (position.quantity === 0) continue;

    const price = prices[symbol];
    if (price === null || price === undefined || !Number.isFinite(price)) {
      unpricedSymbols.push(symbol);
      continue;
    }
    positionsValue += marketValue(position, price);
    unrealized += unrealizedPnl(position, price);
  }

  const equity = cash + positionsValue;
  const totalPnl = equity - startingCash;
  return {
    cash,
    positionsValue,
    equity,
    unrealizedPnl: unrealized,
    realizedPnl: realized,
    totalPnl,
    totalPnlPercent: startingCash === 0 ? 0 : (totalPnl / startingCash) * 100,
    unpricedSymbols,
  };
}
