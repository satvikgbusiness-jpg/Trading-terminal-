/**
 * Finance-domain sentiment lexicon.
 *
 * The general-purpose AFINN lexicon that ships with wink-sentiment is trained on
 * ordinary English and misreads market copy badly: "beat" scores -1 (the
 * physical sense) when "beat estimates" is the single most bullish thing a
 * headline can say, "fine" scores +2 when a regulatory fine is bad news, and
 * "plunge", "surge" and "downgrade" do not appear at all.
 *
 * These weights overlay AFINN — a term listed here replaces the base score for
 * that token. The scale matches AFINN's roughly -5..+5 so the two mix cleanly.
 * The vocabulary follows the Loughran-McDonald convention of scoring words by
 * their financial-disclosure sense rather than their everyday one.
 */

export const FINANCE_TERMS: Record<string, number> = {
  // --- direction of price / results -------------------------------------
  surge: 2.5, surges: 2.5, surged: 2.5, surging: 2.5,
  soar: 2.5, soars: 2.5, soared: 2.5, soaring: 2.5,
  rally: 2, rallies: 2, rallied: 2, rallying: 2,
  jump: 1.8, jumps: 1.8, jumped: 1.8, jumping: 1.8,
  climb: 1.5, climbs: 1.5, climbed: 1.5,
  gain: 1.5, gains: 1.5, gained: 1.5,
  rise: 1.2, rises: 1.2, rose: 1.2, rising: 1.2,
  rebound: 1.8, rebounds: 1.8, rebounded: 1.8,
  recover: 1.5, recovers: 1.5, recovered: 1.5, recovery: 1.5,
  advance: 1.2, advances: 1.2, advanced: 1.2,
  outperform: 2.2, outperforms: 2.2, outperformed: 2.2, outperformance: 2.2,
  accelerate: 1.5, accelerating: 1.5, accelerated: 1.5,

  plunge: -2.5, plunges: -2.5, plunged: -2.5, plunging: -2.5,
  slump: -2.2, slumps: -2.2, slumped: -2.2, slumping: -2.2,
  tumble: -2.2, tumbles: -2.2, tumbled: -2.2, tumbling: -2.2,
  sink: -2, sinks: -2, sank: -2, sinking: -2,
  slide: -1.8, slides: -1.8, slid: -1.8, sliding: -1.8,
  drop: -1.5, drops: -1.5, dropped: -1.5,
  fall: -1.5, falls: -1.5, fell: -1.5, falling: -1.5,
  decline: -1.5, declines: -1.5, declined: -1.5, declining: -1.5,
  crash: -3, crashes: -3, crashed: -3,
  selloff: -2, 'sell-off': -2, selloffs: -2,
  slip: -1.2, slips: -1.2, slipped: -1.2,
  underperform: -2.2, underperforms: -2.2, underperformed: -2.2,
  sputter: -1.5, stall: -1.5, stalls: -1.5, stalled: -1.5,

  // --- results vs expectations ------------------------------------------
  // AFINN reads "beat" as violence; in a market headline it is the opposite.
  beat: 2.5, beats: 2.5, beating: 2.5,
  top: 1.5, tops: 2, topped: 2, topping: 2,
  exceed: 2, exceeds: 2, exceeded: 2, exceeding: 2,
  miss: -2.2, misses: -2.2, missed: -2.2, missing: -1.5,
  shortfall: -2.2, shortfalls: -2.2,
  disappoint: -2.2, disappoints: -2.2, disappointing: -2.2, disappointed: -2.2,

  // --- analyst actions ---------------------------------------------------
  upgrade: 2.2, upgrades: 2.2, upgraded: 2.2,
  downgrade: -2.2, downgrades: -2.2, downgraded: -2.2,
  overweight: 1.5, underweight: -1.5,
  bullish: 2.2, bearish: -2.2,

  // --- guidance and capital returns -------------------------------------
  guidance: 0, // direction comes from the verb beside it
  raise: 1.5, raises: 1.5, raised: 1.5, raising: 1.2,
  boost: 1.8, boosts: 1.8, boosted: 1.8,
  hike: 0.5, hikes: 0.5, hiked: 0.5,
  cut: -1.5, cuts: -1.5, cutting: -1.5,
  slash: -2.5, slashes: -2.5, slashed: -2.5,
  lower: -1.2, lowers: -1.2, lowered: -1.2,
  trim: -1, trims: -1, trimmed: -1,
  buyback: 1.8, buybacks: 1.8, repurchase: 1.5, repurchases: 1.5,
  dividend: 0.8, dividends: 0.8,

  // --- fundamentals ------------------------------------------------------
  profit: 1.5, profits: 1.5, profitable: 2, profitability: 1.2,
  growth: 1.5, growing: 1.2, grew: 1.2,
  revenue: 0, revenues: 0, earnings: 0, // neutral nouns; the verb carries sign
  margin: 0, margins: 0,
  loss: -1.8, losses: -1.8, lossmaking: -2.5,
  deficit: -1.8, deficits: -1.8,
  impairment: -2, impairments: -2,
  writedown: -2.2, 'write-down': -2.2, writedowns: -2.2, writeoff: -2.2, 'write-off': -2.2,
  strong: 1.8, stronger: 1.8, robust: 1.8, resilient: 1.5, solid: 1.5,
  weak: -1.8, weaker: -1.8, weakness: -1.8, sluggish: -1.8, soft: -1.2, softer: -1.2,
  headwind: -1.5, headwinds: -1.5, tailwind: 1.5, tailwinds: 1.5,
  demand: 0, oversupply: -1.5, glut: -1.8, shortage: -1.2,

  // --- corporate and legal events ---------------------------------------
  // "fine"/"fined" is a penalty in this domain; AFINN scores it +2.
  fine: -1, fined: -2.5, fines: -2,
  penalty: -2, penalties: -2,
  lawsuit: -2, lawsuits: -2, sue: -1.8, sued: -1.8, sues: -1.8,
  litigation: -1.5, 'class-action': -2,
  probe: -1.8, probes: -1.8, investigation: -1.8, investigating: -1.5, investigated: -1.5,
  subpoena: -2.2, subpoenaed: -2.2,
  fraud: -3, fraudulent: -3, misconduct: -2.5, scandal: -2.8,
  bankruptcy: -3.5, bankrupt: -3.5, insolvency: -3.5, insolvent: -3.5,
  default: -2.5, defaults: -2.5, defaulted: -2.5, restructuring: -1.5,
  delist: -2.5, delisted: -2.5, delisting: -2.5,
  recall: -2, recalls: -2, recalled: -1.5,
  layoff: -2, layoffs: -2, redundancies: -2,
  resign: -1.5, resigns: -1.5, resigned: -1.5, ouster: -2, ousted: -2,
  halt: -1.8, halts: -1.8, halted: -1.8, suspend: -1.5, suspends: -1.5, suspended: -1.5,
  outage: -1.5, breach: -2, breaches: -2, hacked: -2.2, hack: -2,
  sanction: -2, sanctions: -2, sanctioned: -2,
  antitrust: -1.5, monopoly: -1.2,
  strike: -1.2, strikes: -1.2, walkout: -1.5, dispute: -1.2,
  delay: -1.2, delays: -1.2, delayed: -1.2,
  warn: -2, warns: -2, warned: -2, warning: -2,

  approval: 2, approved: 2, approves: 2, clearance: 1.5, cleared: 1.2,
  breakthrough: 2.5, milestone: 1.5, patent: 0.8,
  partnership: 1.5, partnerships: 1.5, alliance: 1.2,
  acquisition: 0.8, acquires: 0.8, merger: 0.8,
  award: 1.5, awarded: 1.5, wins: 1.8, won: 1.5, secures: 1.5, secured: 1.2,
  expansion: 1.5, expands: 1.5, expanding: 1.2,
  launch: 1, launches: 1, launched: 1,

  // --- macro -------------------------------------------------------------
  recession: -2.5, downturn: -2.2, slowdown: -1.8, contraction: -1.8,
  inflation: -0.8, deflation: -1.2, stagflation: -2.2,
  stimulus: 1.2, easing: 1, tightening: -1,
  volatility: -0.8, uncertainty: -1.5, turmoil: -2.2, crisis: -2.8,
  optimism: 2, pessimism: -2, confidence: 1.2, caution: -1, cautious: -1,

  // --- AFINN senses that invert or vanish in market copy ------------------
  outstanding: 0,   // "shares outstanding", not "excellent"
  short: 0,         // "short interest", not "brief"
  bear: 0, bull: 0, // animals in AFINN; regimes here (see phrases below)
  charge: -1, charges: -1.5, charged: -1.5, // a charge against earnings
  interest: 0,      // "interest rate", not enthusiasm
  block: 0, blocked: -1.2,
  free: 0,          // "free cash flow"
  care: 0, want: 0, big: 0, great: 0.8,
  stock: 0, stocks: 0, share: 0, shares: 0,
  no: 0, not: 0,    // handled as negation, not as sentiment
};

/**
 * Multi-word phrases, matched against the normalised text before tokens are
 * scored. A phrase's weight replaces every token it covers, which is how
 * "record high" avoids being scored as the neutral words "record" and "high".
 */
export const FINANCE_PHRASES: Array<[string, number]> = [
  ['record high', 2.5],
  ['record highs', 2.5],
  ['all-time high', 2.8],
  ['all time high', 2.8],
  ['record profit', 2.5],
  ['record revenue', 2.2],
  ['beats estimates', 2.8],
  ['beat estimates', 2.8],
  ['beats expectations', 2.8],
  ['beat expectations', 2.8],
  ['tops estimates', 2.8],
  ['above estimates', 2.2],
  ['above expectations', 2.2],
  ['raises guidance', 2.8],
  ['raised guidance', 2.8],
  ['lifts guidance', 2.8],
  ['raises outlook', 2.5],
  ['price target raised', 2.2],
  ['buy rating', 1.8],
  ['share buyback', 1.8],
  ['dividend increase', 1.8],
  ['stock split', 0.8],
  ['52-week high', 1.5],
  ['better than expected', 2.5],
  ['stronger than expected', 2.5],

  ['record low', -2.2],
  ['profit warning', -3],
  ['cuts guidance', -2.8],
  ['cut guidance', -2.8],
  ['lowers guidance', -2.8],
  ['slashes guidance', -3],
  ['cuts outlook', -2.5],
  ['misses estimates', -2.8],
  ['missed estimates', -2.8],
  ['misses expectations', -2.8],
  ['below estimates', -2.2],
  ['below expectations', -2.2],
  ['worse than expected', -2.5],
  ['weaker than expected', -2.5],
  ['price target cut', -2.2],
  ['sell rating', -1.8],
  ['short seller', -1.8],
  ['class action', -2.2],
  ['going concern', -2.8],
  ['chapter 11', -3.5],
  ['job cuts', -1.8],
  ['dividend cut', -2.8],
  ['52-week low', -1.5],
  ['bear market', -2.5],
  ['bull market', 2.5],
  ['sell off', -2],
  ['profit taking', -0.6],

  // Explicitly neutral: direction depends on whose book you are on.
  ['rate cut', 0],
  ['rate hike', 0],
  ['interest rate', 0],
  ['free cash flow', 0],
  ['market cap', 0],
  ['shares outstanding', 0],
  ['short interest', 0],
];

/** Words that flip the polarity of what follows them. */
export const NEGATIONS = new Set([
  'not', 'no', 'never', 'none', 'nor', 'without', 'cannot', "can't", "won't",
  "doesn't", "didn't", "isn't", "wasn't", "aren't", "weren't", "hasn't", "haven't",
  'fails', 'fail', 'failed', 'failing', 'unable', 'denies', 'denied', 'deny',
  'lacks', 'lack', 'lacking', 'halts', 'avoids', 'avoided', 'unlikely',
]);

/** Multipliers applied to the next scored token. */
export const INTENSIFIERS: Record<string, number> = {
  very: 1.4, sharply: 1.5, steeply: 1.5, massively: 1.6, hugely: 1.5,
  dramatically: 1.5, significantly: 1.3, substantially: 1.3, deeply: 1.4,
  heavily: 1.3, extremely: 1.5, record: 1.3, sharp: 1.4,
  slightly: 0.6, marginally: 0.5, modestly: 0.6, somewhat: 0.6, slight: 0.6,
  narrowly: 0.7, mildly: 0.6,
};
