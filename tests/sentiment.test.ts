import { describe, expect, it } from 'vitest';
import { aggregateSentiment, scoreHeadline, scoreText } from '@/lib/analysis/sentiment';

describe('scoreText', () => {
  it('scores an unambiguously bullish headline positive', () => {
    const r = scoreText('Apple shares surge to record high on blowout earnings beat');
    expect(r.score).toBeGreaterThan(0.5);
    expect(r.label).toBe('positive');
  });

  it('scores an unambiguously bearish headline negative', () => {
    const r = scoreText('Company slashes guidance amid collapsing demand; shares plunge');
    expect(r.score).toBeLessThan(-0.5);
    expect(r.label).toBe('negative');
  });

  it('leaves procedural copy neutral', () => {
    const r = scoreText('The company will hold its annual meeting on Tuesday');
    expect(r.label).toBe('neutral');
  });

  it('stays bounded in [-1, 1] however many loaded words appear', () => {
    const piled = 'surge soar rally jump beat upgrade record profit growth breakthrough wins '.repeat(5);
    expect(scoreText(piled).score).toBeLessThanOrEqual(1);
    expect(scoreText(piled).score).toBeGreaterThan(0.9);
    const dumped = 'plunge crash fraud bankruptcy default lawsuit probe scandal '.repeat(5);
    expect(scoreText(dumped).score).toBeGreaterThanOrEqual(-1);
    expect(scoreText(dumped).score).toBeLessThan(-0.9);
  });

  it('returns neutral for empty input rather than NaN', () => {
    expect(scoreText('').score).toBe(0);
    expect(scoreText('   ').label).toBe('neutral');
  });
});

describe('finance-specific overrides of AFINN', () => {
  it('reads a regulatory fine as bad news (AFINN scores "fine" +2)', () => {
    expect(scoreText('Regulators fine bank over compliance failures').score).toBeLessThan(0);
    expect(scoreText('Bank fined $2bn by regulator').score).toBeLessThan(0);
  });

  it('reads "beat" as beating estimates (AFINN scores "beat" -1)', () => {
    expect(scoreText('Nvidia beats estimates').score).toBeGreaterThan(0.4);
    expect(scoreText('Earnings beat expectations').score).toBeGreaterThan(0.4);
  });

  it('recognises price verbs AFINN does not carry at all', () => {
    expect(scoreText('Shares plunge').score).toBeLessThan(-0.3);
    expect(scoreText('Shares surge').score).toBeGreaterThan(0.3);
    expect(scoreText('Analyst downgrade weighs on stock').score).toBeLessThan(-0.3);
  });

  it('treats a central bank rate cut as directionally neutral', () => {
    // "cut" alone is bearish, but "rate cut" is not a fact about one company.
    expect(Math.abs(scoreText('Fed announces rate cut').score)).toBeLessThan(0.15);
  });

  it('does not read "shares outstanding" or "free cash flow" as sentiment', () => {
    expect(Math.abs(scoreText('Shares outstanding were unchanged').score)).toBeLessThan(0.15);
    expect(Math.abs(scoreText('Free cash flow reported in the filing').score)).toBeLessThan(0.15);
  });
});

describe('phrases and modifiers', () => {
  it('prefers the longest matching phrase', () => {
    // "all-time high" must outweigh the bare word "high".
    expect(scoreText('Index hits all-time high').score).toBeGreaterThan(0.4);
  });

  it('scores a profit warning far worse than the word "profit" is good', () => {
    expect(scoreText('Retailer issues profit warning').score).toBeLessThan(-0.4);
  });

  it('flips polarity after a negation', () => {
    const plain = scoreText('Retailer expects a strong holiday quarter');
    const negated = scoreText('Retailer does not expect a strong holiday quarter');
    expect(plain.score).toBeGreaterThan(0);
    expect(negated.score).toBeLessThan(0);
    // Negation weakens as well as flips.
    expect(Math.abs(negated.score)).toBeLessThan(Math.abs(plain.score));
  });

  it('amplifies with intensifiers and damps with diminishers', () => {
    const base = scoreText('Shares fell');
    const sharp = scoreText('Shares fell sharply');
    const slight = scoreText('Shares fell slightly');
    expect(sharp.score).toBeLessThan(base.score);
    expect(slight.score).toBeGreaterThan(base.score);
  });

  it('weights the summary below the headline', () => {
    const headlineOnly = scoreHeadline('Company reports results');
    const withBody = scoreHeadline('Company reports results', 'Revenue beats estimates and guidance was raised');
    expect(withBody.score).toBeGreaterThan(headlineOnly.score);
    // ...but a bullish body cannot outrank an explicit bullish headline.
    const bullishHeadline = scoreHeadline('Revenue beats estimates and guidance was raised');
    expect(withBody.score).toBeLessThan(bullishHeadline.score);
  });
});

describe('aggregateSentiment', () => {
  const HOUR = 3_600_000;
  const now = Date.UTC(2026, 0, 15, 12, 0, 0);

  it('is neutral with no items', () => {
    const r = aggregateSentiment([], { now });
    expect(r).toMatchObject({ score: 0, label: 'neutral', effectiveCount: 0, newestAt: null });
  });

  it('weights recent headlines above old ones', () => {
    const recentBull = aggregateSentiment(
      [
        { score: 1, publishedAt: now - 1 * HOUR },
        { score: -1, publishedAt: now - 72 * HOUR },
      ],
      { now, halfLifeHours: 24 },
    );
    expect(recentBull.weightedMean).toBeGreaterThan(0.5);
  });

  it('drops items outside the window entirely', () => {
    const r = aggregateSentiment([{ score: 1, publishedAt: now - 30 * 24 * HOUR }], {
      now,
      windowHours: 24 * 7,
    });
    expect(r.counts.total).toBe(0);
    expect(r.score).toBe(0);
  });

  it('shrinks a single headline toward neutral but lets a chorus through', () => {
    const one = aggregateSentiment([{ score: 1, publishedAt: now }], { now, priorStrength: 2 });
    const many = aggregateSentiment(
      Array.from({ length: 10 }, () => ({ score: 1, publishedAt: now })),
      { now, priorStrength: 2 },
    );
    expect(one.weightedMean).toBeCloseTo(1, 6);
    expect(one.score).toBeCloseTo(1 / 3, 6); // 1 * (1 / (1 + 2))
    expect(many.score).toBeGreaterThan(0.8);
    expect(many.score).toBeLessThan(1);
  });

  it('counts labels and reports the newest timestamp', () => {
    const r = aggregateSentiment(
      [
        { score: 0.9, publishedAt: now - HOUR },
        { score: -0.8, publishedAt: now - 2 * HOUR },
        { score: 0.01, publishedAt: now - 3 * HOUR },
      ],
      { now },
    );
    expect(r.counts).toEqual({ positive: 1, negative: 1, neutral: 1, total: 3 });
    expect(r.newestAt).toBe(now - HOUR);
  });

  it('does not over-weight a headline dated in the future by feed clock skew', () => {
    const skewed = aggregateSentiment([{ score: 1, publishedAt: now + 48 * HOUR }], { now });
    const current = aggregateSentiment([{ score: 1, publishedAt: now }], { now });
    expect(skewed.score).toBeCloseTo(current.score, 10);
  });
});
