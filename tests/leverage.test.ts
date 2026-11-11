import { describe, expect, it } from 'vitest';
import {
  MAX_MULTIPLIER_BPS, bonusMicros, bootstrap, classify, closedFormK, decompose, floorRefundMicros, moments, playerReturn,
  poolEv, rng, roundDownMultiplierBps, ruinBankrollMicros, safeMultiplierBps, solveK,
} from '@/lib/shared/leverage';
import { calibrateMachine, offer, type OfferContext } from '@/lib/shared/calibration';
import { calibrationStale } from '@/lib/server/calibration';
import { calibrateShort, decomposeShort, fairShortBps, shortMaxPayoutMicros, shortOffer, shortOutcome, shortPayoutMicros, shortPoolEv, shortPoolPnl } from '@/lib/shared/short';

const M = 1_000_000;

/** A loss-heavy pull distribution with a fat right tail, roughly shaped like CC's machines. */
function sample(n: number, seed = 7) {
  const next = rng(seed);
  return Array.from({ length: n }, () => {
    const u = next();
    if (u < 0.7) return 0.45 + 0.5 * next();
    if (u < 0.8) return 0.95 + 0.1 * next();
    if (u < 0.97) return 1.05 + 1.5 * next();
    return 3 + 12 * next() ** 2;
  });
}

describe('settlement math', () => {
  it('classifies at the 0.95 / 1.05 boundaries', () => {
    expect(classify(100 * M, 94_999_999)).toBe('loss');
    expect(classify(100 * M, 95 * M)).toBe('push');
    expect(classify(100 * M, 104_999_999)).toBe('push');
    expect(classify(100 * M, 105 * M)).toBe('win');
  });

  it('pays (value − price) × (M − 1) on wins only, capped', () => {
    expect(bonusMicros(100 * M, 300 * M, 15_000, 1_000 * M)).toBe(100 * M);
    expect(bonusMicros(100 * M, 300 * M, 15_000, 40 * M)).toBe(40 * M);
    expect(bonusMicros(100 * M, 104 * M, 30_000, 1_000 * M)).toBe(0);
    expect(bonusMicros(100 * M, 60 * M, 30_000, 1_000 * M)).toBe(0);
    expect(bonusMicros(100 * M, 300 * M, 10_000, 1_000 * M)).toBe(0);
  });

  it('gives a losing half-risk player half the sellback', () => {
    expect(floorRefundMicros(51 * M, 5_000)).toBe(25_500_000);
    expect(floorRefundMicros(51 * M, 0)).toBe(0);
  });

  it('rounds multipliers down to 0.05x', () => {
    expect(roundDownMultiplierBps(21_499)).toBe(21_000);
    expect(roundDownMultiplierBps(21_500)).toBe(21_500);
  });
});

describe('calibration math', () => {
  const ratios = sample(20_000), b = 0.9;

  it('player return = normal-open return − pool edge, pull by pull', () => {
    for (const floor of [0, 0.5]) {
      for (const k of [0.4, 1.2, 1.9]) {
        const d = decompose(ratios, b, floor);
        // The player's cash outcome per pull, selling any card straight back.
        const direct = ratios.reduce((s, r) => s + (r < 0.95 ? floor * b * r : r >= 1.05 ? b * r + k * (r - 1) : b * r), 0) / ratios.length - 1;
        expect(direct).toBeCloseTo(playerReturn(d.normalReturn, poolEv(d, k)), 10);
        expect(poolEv(d, k)).toBeCloseTo(moments(ratios, { buyback: b, floor, k, capRatio: Infinity }).mean, 10);
      }
    }
  });

  it('numeric solve matches the closed form without a cap', () => {
    for (const floor of [0, 0.5]) for (const edge of [0.03, 0.05]) {
      expect(solveK(ratios, b, floor, edge)).toBeCloseTo(closedFormK(decompose(ratios, b, floor), edge), 6);
    }
  });

  it('a cap raises the fair multiplier and the half floor lowers it', () => {
    const uncapped = solveK(ratios, b, 0, 0.05), capped = solveK(ratios, b, 0, 0.05, 5), half = solveK(ratios, b, 0.5, 0.05);
    expect(capped).toBeGreaterThan(uncapped);
    expect(half).toBeLessThan(uncapped);
    expect(moments(ratios, { buyback: b, floor: 0, k: capped, capRatio: 5 }).mean).toBeCloseTo(0.05, 6);
  });

  it('the bootstrap safety limit tightens on small samples', () => {
    const big = safeMultiplierBps(bootstrap(ratios, b, 400, 1), 0), small = safeMultiplierBps(bootstrap(ratios.slice(0, 150), b, 400, 1), 0);
    const fair = Math.round(10_000 * (1 + solveK(ratios, b, 0, 0)));
    expect(big).toBeLessThanOrEqual(fair);
    expect(big).toBeGreaterThan(small);
  });

  it('needs a bigger bankroll for more variance or a thinner edge', () => {
    expect(ruinBankrollMicros(2, 0.05, 100 * M)).toBeGreaterThan(ruinBankrollMicros(1, 0.05, 100 * M));
    expect(ruinBankrollMicros(1, 0.03, 100 * M)).toBeGreaterThan(ruinBankrollMicros(1, 0.05, 100 * M));
    expect(ruinBankrollMicros(1, 0, 100 * M)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('offers', () => {
  const rows = calibrateMachine('pokemon_100', sample(20_000, 3), 0.9, { fromMs: 0, toMs: 1 }, { edgesBps: [300, 500], resamples: 300, seed: 2, now: 1_000 });
  const full = rows.find(r => r.level === 'full')!, half = rows.find(r => r.level === 'half')!;
  const settings = { capBps: 1_000, minCapMultiple: 10, edgeBps: 500, minEdgeBps: 300, ruinProbability: 0.01, calibrationMaxAgeHours: 48, minSamples: 200 };
  const ctx = (freeUsd: number, now = 2_000): OfferContext => ({ priceMicros: 100 * M, freeMicros: freeUsd * M, minValueMicros: 50 * M, now, settings });

  it('offers a lower multiple with the half floor, and the same normal-open return', () => {
    const f = offer(full, ctx(10_000_000)), h = offer(half, ctx(10_000_000));
    expect(f.available && h.available).toBe(true);
    expect(h.multiplierBps).toBeLessThan(f.multiplierBps);
    expect(f.normalReturn).toBe(h.normalReturn);
    expect(f.poolEdge).toBeGreaterThanOrEqual(0.03 - 1e-9);
    expect(f.playerReturn).toBeCloseTo(f.normalReturn - f.poolEdge, 12);
  });

  it('stays locked until the pool covers its bankroll and a 10x-price cap', () => {
    const small = offer(full, ctx(500));
    expect(small.available).toBe(false);
    expect(small.reason).toMatch(/Unlocks when the pool reaches/);
    expect(small.unlockAtMicros).toBeGreaterThanOrEqual(10 * 100 * M / 0.1);
    expect(offer(full, ctx(small.unlockAtMicros / M)).available).toBe(true);
  });

  describe('with caps from 2x the price', () => {
    const smart = { ...settings, minCapMultiple: 2 };
    const at = (row: typeof half, freeUsd: number) => offer(row, { ...ctx(freeUsd), settings: smart });
    const ratios = sample(20_000, 3);

    it('opens on a far smaller pool, with a tight cap that grows with the pool', () => {
      const opening = at(half, 0);
      expect(opening.unlockAtMicros).toBeLessThan(offer(half, ctx(0)).unlockAtMicros / 3);
      const small = at(half, opening.unlockAtMicros / M), big = at(half, 10_000_000);
      expect(small.available && big.available).toBe(true);
      expect(small.capMicros).toBe(2 * 100 * M);
      expect(big.capMicros).toBeGreaterThan(small.capMicros);
      expect(at(half, opening.unlockAtMicros / M - 1).available).toBe(false);
    });

    it('prices each cap fairly: the pool keeps its edge at the cap it offers', () => {
      for (const row of [half, full]) for (const freeUsd of [1_000, 3_000, 8_000, 30_000, 10_000_000]) {
        const o = at(row, freeUsd);
        if (!o.available) continue;
        const pnl = moments(ratios, { buyback: 0.9, floor: row.floor, k: (o.multiplierBps - 10_000) / 10_000, capRatio: o.capMicros / (100 * M) });
        expect(pnl.mean).toBeGreaterThanOrEqual(o.edgeBps / 10_000 - 1e-9);
        expect(o.poolEdge).toBeCloseTo(pnl.mean, 9);
        expect(o.capMicros).toBeLessThanOrEqual(freeUsd * M * smart.capBps / 10_000);
      }
    });

    it('skips a cap so tight that its fair multiple would hit the ceiling', () => {
      const tight = { ...full, fair: full.fair.map(f => f.capRatio === 2 ? { ...f, bps: MAX_MULTIPLIER_BPS } : f) };
      const opening = at(tight, 0);
      expect(opening.capMicros).toBeGreaterThan(2 * 100 * M);
      expect(opening.multiplierBps).toBeLessThan(MAX_MULTIPLIER_BPS);
    });

    it('keeps rows calibrated before the small caps on their old terms, and recalibrates them', () => {
      const old = { ...half, fair: half.fair.filter(f => f.capRatio === null || f.capRatio >= 10).map(f => ({ edgeBps: f.edgeBps, capRatio: f.capRatio, bps: f.bps, safe: f.safe })) };
      expect(at(old, 0).unlockAtMicros).toBeGreaterThanOrEqual(10 * 100 * M / 0.1);
      expect(calibrationStale([old], 2_000)).toBe(true);
      expect(calibrationStale([half, full], 2_000)).toBe(false);
      expect(calibrationStale([half, full], 1_000 + 25 * 3_600_000)).toBe(true);
    });
  });

  describe('on a small pool', () => {
    // A $25 pack priced at 1x and 2x caps at both edges: the pool's EV and SD per pack, in pack prices.
    const row = { ...half, fair: [
      { edgeBps: 300, capRatio: 1, bps: 19_000, safe: true, mean: 0.031, sd: 0.36 },
      { edgeBps: 500, capRatio: 1, bps: 17_500, safe: true, mean: 0.05, sd: 0.36 },
      { edgeBps: 300, capRatio: 2, bps: 16_500, safe: true, mean: 0.035, sd: 0.41 },
      { edgeBps: 500, capRatio: 2, bps: 15_500, safe: true, mean: 0.05, sd: 0.41 },
    ] };
    const small = { ...settings, minCapMultiple: 1, ruinProbability: 0.05 };
    const at = (freeUsd: number) => offer(row, { priceMicros: 25 * M, freeMicros: freeUsd * M, minValueMicros: 13 * M, now: 2_000, settings: small });

    it('opens on four times the pack price, with a top bonus of the price, at the launch edge', () => {
      expect(at(99).reason).toBe('Unlocks when the pool reaches $100.');
      const o = at(100);
      expect(o.available).toBe(true);
      expect([o.capMicros, o.multiplierBps, o.edgeBps]).toEqual([25 * M, 17_500, 500]);
    });

    it('moves to the lower edge, then to a bigger top bonus, as the pool grows', () => {
      const mid = at(160), big = at(500);
      expect([mid.capMicros, mid.multiplierBps, mid.edgeBps]).toEqual([25 * M, 19_000, 300]);
      expect([big.capMicros, big.multiplierBps, big.edgeBps]).toEqual([50 * M, 16_500, 300]);
    });
  });

  it('waits for more pulls instead of widening the pool edge on thin data', () => {
    const thin = calibrateMachine('pokemon_100', sample(250, 11), 0.9, { fromMs: 0, toMs: 1 }, { edgesBps: [300, 500], resamples: 300, seed: 2, now: 1_000 }).find(r => r.level === 'full')!;
    const o = offer(thin, ctx(10_000_000));
    if (!o.available) expect(o.reason).toMatch(/Collecting more pulls/);
    else expect(o.poolEdge).toBeLessThanOrEqual(0.05 + 0.02);
  });

  it('pauses on stale calibration and shows the worst case', () => {
    expect(offer(full, ctx(10_000_000, 1_000 + 49 * 3_600_000)).reason).toMatch(/re-checked/);
    expect(offer(full, ctx(10_000_000)).maxLossMicros).toBe(100 * M);
    expect(offer(half, ctx(10_000_000)).maxLossMicros).toBe(100 * M - Math.floor(0.5 * 0.9 * 50 * M));
  });
});

describe('shorts', () => {
  it('wins when the pull misses, pays (price − value) × S on top of the stake, capped', () => {
    expect(shortOutcome(25 * M, 20 * M)).toBe('win');
    expect(shortOutcome(25 * M, 25 * M)).toBe('push');
    expect(shortOutcome(25 * M, 30 * M)).toBe('loss');
    expect(shortPayoutMicros(25 * M, 20 * M, 20_000, 100 * M)).toBe(10 * M);
    expect(shortPayoutMicros(25 * M, 20 * M, 20_000, 4 * M)).toBe(4 * M);
    expect(shortPayoutMicros(25 * M, 24 * M, 20_000, 100 * M)).toBe(0);
    expect(shortPayoutMicros(25 * M, 500 * M, 20_000, 100 * M)).toBe(0);
    expect(shortMaxPayoutMicros(25 * M, 13 * M, 20_000)).toBe(24 * M);
  });

  it('fair S leaves the pool its edge, and the player gets exactly minus that edge', () => {
    const ratios = sample(50_000, 5), d = decomposeShort(ratios), bps = fairShortBps(d, 0.05), s = bps / 10_000;
    expect(bps % 500).toBe(0);
    const poolMean = ratios.reduce((a, r) => a + shortPoolPnl(r, s), 0) / ratios.length;
    expect(poolMean).toBeCloseTo(shortPoolEv(d, s), 12);
    expect(poolMean).toBeGreaterThanOrEqual(0.05 - 1e-12);
    expect(shortPoolEv(d, s + 0.05)).toBeLessThan(0.05);
    // The player's side of every pull is the pool's, negated: no pack is bought, so nothing else is in it.
    const playerMean = ratios.reduce((a, r) => a + (r < 0.95 ? s * (1 - r) : r >= 1.05 ? -1 : 0), 0) / ratios.length;
    expect(playerMean).toBeCloseTo(-poolMean, 12);
  });

  it('the pool can never lose more than S × (1 − lowest pull) on one short', () => {
    const ratios = sample(5_000, 9), s = fairShortBps(decomposeShort(ratios), 0.05) / 10_000, low = Math.min(...ratios);
    expect(Math.min(...ratios.map(r => shortPoolPnl(r, s)))).toBeGreaterThanOrEqual(-s * (1 - low) - 1e-12);
  });

  it('opens once the pool covers its bankroll and top payout, and needs far less pool than a long', () => {
    const ratios = sample(20_000, 3), row = calibrateShort('pokemon_100', ratios, { fromMs: 0, toMs: 1 }, { edgesBps: [300, 500], now: 1_000 })!;
    const settings = { capBps: 1_000, minCapMultiple: 10, edgeBps: 500, minEdgeBps: 300, ruinProbability: 0.01, calibrationMaxAgeHours: 48, minSamples: 200 };
    const ctx = (freeUsd: number): OfferContext => ({ priceMicros: 100 * M, freeMicros: freeUsd * M, minValueMicros: 50 * M, now: 2_000, settings });
    const big = shortOffer(row, ctx(10_000_000));
    expect(big.available).toBe(true);
    expect(big.side).toBe('short');
    expect(big.playerReturn).toBeCloseTo(-big.poolEdge, 12);
    expect(big.maxLossMicros).toBe(100 * M);
    expect(big.capMicros).toBe(shortMaxPayoutMicros(100 * M, 50 * M, big.multiplierBps));
    expect(big.pWin).toBeCloseTo(row.pMiss, 12);
    const small = shortOffer(row, ctx(100));
    expect(small.reason).toMatch(/Unlocks when the pool reaches/);
    expect(shortOffer(row, ctx(small.unlockAtMicros / M)).available).toBe(true);
    const long = offer(calibrateMachine('pokemon_100', ratios, 0.9, { fromMs: 0, toMs: 1 }, { edgesBps: [300, 500], resamples: 300, seed: 2, now: 1_000 }).find(r => r.level === 'full')!, ctx(10_000_000));
    expect(small.unlockAtMicros).toBeLessThan(long.unlockAtMicros);
  });

  it('waits for more pulls on thin data', () => {
    const row = calibrateShort('pokemon_100', sample(60, 4), { fromMs: 0, toMs: 1 }, { edgesBps: [300, 500], now: 1_000 })!;
    const o = shortOffer(row, { priceMicros: 100 * M, freeMicros: 10_000_000 * M, minValueMicros: 50 * M, now: 2_000, settings: { capBps: 1_000, minCapMultiple: 10, edgeBps: 500, minEdgeBps: 300, ruinProbability: 0.01, calibrationMaxAgeHours: 48, minSamples: 200 } });
    expect(o.available).toBe(false);
    expect(o.reason).toMatch(/Collecting/);
  });
});
