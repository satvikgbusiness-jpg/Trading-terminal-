import winkSentiment from 'wink-sentiment';
import { FINANCE_PHRASES, FINANCE_TERMS, INTENSIFIERS, NEGATIONS } from './finance-lexicon';

/**
 * Lexicon sentiment scoring for market headlines.
 *
 * No LLM and no network call: a headline is tokenised, each token is scored from
 * the finance lexicon (falling back to wink-sentiment's AFINN weights for
 * ordinary words), phrases are matched ahead of tokens, and negation and
 * intensifier modifiers are applied over a small window.
 *
 * This is a bag-of-words model. It has no idea who the subject of a sentence is,
 * so "Rival to Apple collapses" scores negative for Apple. That limitation is
 * documented in the README and is why news is one input among several rather
 * than a signal on its own.
 */

export type SentimentLabel = 'positive' | 'negative' | 'neutral';

export interface SentimentResult {
  /** Bounded to [-1, 1]. */
  score: number;
  label: SentimentLabel;
  /** Raw pre-normalisation sum, useful for debugging the lexicon. */
  raw: number;
  /** Terms that actually contributed, for the "why" tooltip. */
  hits: Array<{ term: string; weight: number }>;
}

/** Score above/below which a headline stops counting as neutral. */
export const SENTIMENT_THRESHOLD = 0.15;

/** Sum at which the normalised score reaches ~0.76. Tunes model sensitivity. */
const SATURATION = 4;

const NEGATION_WINDOW = 3;

interface Token {
  value: string;
  /** AFINN score from wink, when it has one. */
  base: number | null;
}

function tokenize(text: string): Token[] {
  const parsed = winkSentiment(text) as {
    tokenizedPhrase?: Array<{ value?: string; tag?: string; score?: number }>;
  };
  const out: Token[] = [];
  for (const t of parsed.tokenizedPhrase ?? []) {
    if (!t.value || t.tag === 'punctuation') continue;
    out.push({
      value: t.value.toLowerCase(),
      base: typeof t.score === 'number' ? t.score : null,
    });
  }
  return out;
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Replace known phrases with a placeholder and collect their weights, so the
 * token pass never double-counts the words a phrase already accounted for.
 */
function extractPhrases(text: string): { rest: string; hits: Array<{ term: string; weight: number }> } {
  let rest = ` ${normalizeText(text)} `;
  const hits: Array<{ term: string; weight: number }> = [];

  // Longest phrases first so "all-time high" wins over "high".
  const ordered = [...FINANCE_PHRASES].sort((a, b) => b[0].length - a[0].length);
  for (const [phrase, weight] of ordered) {
    const needle = ` ${phrase} `;
    let index = rest.indexOf(needle);
    while (index !== -1) {
      hits.push({ term: phrase, weight });
      rest = `${rest.slice(0, index)} ${rest.slice(index + needle.length - 1)}`;
      index = rest.indexOf(needle);
    }
  }
  return { rest: rest.trim(), hits };
}

/** Weight for a single token: finance lexicon first, AFINN as the fallback. */
function tokenWeight(token: Token): number | null {
  const override = FINANCE_TERMS[token.value];
  if (override !== undefined) return override;
  if (token.base !== null) return token.base;
  return null;
}

export function scoreText(text: string): SentimentResult {
  if (!text || !text.trim()) {
    return { score: 0, label: 'neutral', raw: 0, hits: [] };
  }

  const { rest, hits: phraseHits } = extractPhrases(text);
  const tokens = tokenize(rest);

  const hits: Array<{ term: string; weight: number }> = [...phraseHits];
  // Token contributions are kept with their position so a trailing intensifier
  // ("fell sharply") can scale the word it modifies after the fact.
  const contributions: Array<{ index: number; term: string; weight: number }> = [];

  let negateFor = 0;
  let pendingMultiplier = 1;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;

    if (NEGATIONS.has(token.value)) {
      negateFor = NEGATION_WINDOW;
      continue;
    }

    const intensity = INTENSIFIERS[token.value];
    if (intensity !== undefined) {
      const previous = contributions[contributions.length - 1];
      // English headlines put the adverb after the verb far more often than
      // before it, so look back first and only queue forward as a fallback.
      if (previous && i - previous.index <= 2) {
        previous.weight *= intensity;
        previous.term = `${previous.term} ${token.value}`;
      } else {
        pendingMultiplier = intensity;
      }
      if (negateFor > 0) negateFor -= 1;
      continue;
    }

    const weight = tokenWeight(token);
    if (weight === null || weight === 0) {
      if (negateFor > 0) negateFor -= 1;
      continue;
    }

    // Negation weakens as well as flips: "not strong" is not as bearish as "weak".
    const negated = negateFor > 0;
    const applied = (negated ? -weight * 0.7 : weight) * pendingMultiplier;
    contributions.push({
      index: i,
      term: negated ? `not ${token.value}` : token.value,
      weight: applied,
    });

    if (negateFor > 0) negateFor -= 1;
    pendingMultiplier = 1;
  }

  let raw = phraseHits.reduce((sum, h) => sum + h.weight, 0);
  for (const c of contributions) {
    raw += c.weight;
    hits.push({ term: c.term, weight: c.weight });
  }

  // tanh keeps the score inside [-1, 1] with diminishing returns, so a headline
  // stuffed with ten bullish words cannot outweigh ten separate stories.
  const score = Math.tanh(raw / SATURATION);
  return { score, label: labelFor(score), raw, hits };
}

export function labelFor(score: number): SentimentLabel {
  if (score > SENTIMENT_THRESHOLD) return 'positive';
  if (score < -SENTIMENT_THRESHOLD) return 'negative';
  return 'neutral';
}

/**
 * Score a news item. The headline carries the signal; the summary is included at
 * a lower weight because it is often boilerplate.
 */
export function scoreHeadline(headline: string, summary?: string | null): SentimentResult {
  const head = scoreText(headline);
  if (!summary) return head;

  const body = scoreText(summary);
  const raw = head.raw + body.raw * 0.35;
  const score = Math.tanh(raw / SATURATION);
  return {
    score,
    label: labelFor(score),
    raw,
    hits: [...head.hits, ...body.hits.map((h) => ({ term: h.term, weight: h.weight * 0.35 }))],
  };
}

export interface AggregateInput {
  score: number;
  publishedAt: number;
}

export interface AggregateResult {
  /** Recency-weighted mean, shrunk toward zero on thin evidence. [-1, 1]. */
  score: number;
  label: SentimentLabel;
  /** Mean before shrinkage — what the headlines say on their own terms. */
  weightedMean: number;
  /** Sum of recency weights: "how many recent headlines' worth" of evidence. */
  effectiveCount: number;
  counts: { positive: number; negative: number; neutral: number; total: number };
  /** Newest contributing item, so the UI can say how fresh the read is. */
  newestAt: number | null;
}

export interface AggregateOptions {
  /** Weight halves every this many hours. */
  halfLifeHours?: number;
  /** Items older than this are dropped entirely. */
  windowHours?: number;
  /** Shrinkage strength: higher demands more headlines before a strong read. */
  priorStrength?: number;
  now?: number;
}

/**
 * Aggregate headline scores with exponential recency decay.
 *
 * Two deliberate choices:
 *  - weights halve every `halfLifeHours`, so this morning's news dominates last
 *    week's;
 *  - the mean is shrunk toward zero by `effectiveCount / (effectiveCount + k)`,
 *    so a single stray headline cannot produce a "strongly bearish" read. Two
 *    fresh headlines get about half the weight of eight.
 */
export function aggregateSentiment(
  items: AggregateInput[],
  options: AggregateOptions = {},
): AggregateResult {
  const {
    halfLifeHours = 24,
    windowHours = 24 * 7,
    priorStrength = 2,
    now = Date.now(),
  } = options;

  const counts = { positive: 0, negative: 0, neutral: 0, total: 0 };
  let weightSum = 0;
  let weightedSum = 0;
  let newestAt: number | null = null;

  for (const item of items) {
    const ageHours = (now - item.publishedAt) / 3_600_000;
    if (ageHours > windowHours) continue;
    // Items dated in the future (feed clock skew) are treated as "now".
    const effectiveAge = Math.max(0, ageHours);
    const weight = Math.pow(0.5, effectiveAge / halfLifeHours);

    weightSum += weight;
    weightedSum += weight * item.score;
    counts.total += 1;
    counts[labelFor(item.score)] += 1;
    if (newestAt === null || item.publishedAt > newestAt) newestAt = item.publishedAt;
  }

  if (weightSum === 0) {
    return {
      score: 0,
      label: 'neutral',
      weightedMean: 0,
      effectiveCount: 0,
      counts,
      newestAt: null,
    };
  }

  const weightedMean = weightedSum / weightSum;
  const shrunk = weightedMean * (weightSum / (weightSum + priorStrength));
  return {
    score: shrunk,
    label: labelFor(shrunk),
    weightedMean,
    effectiveCount: weightSum,
    counts,
    newestAt,
  };
}
