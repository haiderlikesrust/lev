/**
 * Shorts: a bet that the next pull on a machine comes out under the pack price. No pack is bought for a
 * short; it rides the next pull anyone opens on that machine on Collector Crypt.
 *
 * Per short (P stake = the pack price, V the next pull's insured value, S the short multiplier):
 *   win   r < 0.95         stake back + S·(P − V), capped at what was reserved for it
 *   push  0.95 ≤ r < 1.05  stake back
 *   loss  r ≥ 1.05         the stake goes to the pool
 * Outcomes are from the player's side (like long packs), so a short's 'win' is a pull that missed.
 *
 * The pool never buys a pack here, so CC's own cut stays out of it: the player's return is exactly
 * minus the pool's edge. The pool's worst case on one short is S·(P − lowest card), never more than a stake or so.
 */
import { MULTIPLIER_STEP_BPS, ONE_X_BPS, PUSH_HIGH_BPS, PUSH_LOW_BPS, classify, lcb95Normal, ruinBankrollMicros, type Outcome } from './leverage';
import type { Offer, OfferContext } from './calibration';

export type Side = 'long' | 'short';
export const SIDES: Side[] = ['long', 'short'];

export function shortOutcome(priceMicros: number, valueMicros: number): Outcome {
  const pull = classify(priceMicros, valueMicros);
  return pull === 'loss' ? 'win' : pull === 'win' ? 'loss' : 'push';
}

/** A winning short's profit on top of the stake: (price − value) × S, capped. Zero unless the pull missed. */
export function shortPayoutMicros(priceMicros: number, valueMicros: number, shortBps: number, capMicros: number) {
  if (shortOutcome(priceMicros, valueMicros) !== 'win' || shortBps <= 0) return 0;
  const raw = (BigInt(priceMicros) - BigInt(valueMicros)) * BigInt(shortBps) / 10_000n;
  return Number(raw < BigInt(capMicros) ? raw : BigInt(capMicros));
}

/** The most one short can win: the pull is the machine's cheapest card. This is what the pool reserves. */
export const shortMaxPayoutMicros = (priceMicros: number, minValueMicros: number, shortBps: number) =>
  Number(BigInt(Math.max(0, priceMicros - minValueMicros)) * BigInt(shortBps) / 10_000n);

// ── Calibration (floating point, in units of the pack price) ─────────────────

/** The pool's profit on one short, in pack prices: it keeps the stake on a hit and pays S·(1 − r) on a miss. */
export function shortPoolPnl(r: number, s: number) {
  if (r < PUSH_LOW_BPS / 10_000) return -s * (1 - r);
  if (r >= PUSH_HIGH_BPS / 10_000) return 1;
  return 0;
}

/** Pool EV(S) = H − S·D and Var(S) = H + S²·D2 − EV², where H is the hit rate and D how far misses fall short. */
export function decomposeShort(ratios: readonly number[]) {
  let miss = 0, push = 0, hit = 0, d = 0, d2 = 0;
  for (const r of ratios) {
    if (r < PUSH_LOW_BPS / 10_000) { miss++; d += 1 - r; d2 += (1 - r) ** 2; }
    else if (r >= PUSH_HIGH_BPS / 10_000) hit++;
    else push++;
  }
  const n = ratios.length || 1;
  return { n: ratios.length, H: hit / n, D: d / n, D2: d2 / n, pMiss: miss / n, pPush: push / n, pHit: hit / n };
}
export type ShortDecomposition = ReturnType<typeof decomposeShort>;

export const shortPoolEv = (d: Pick<ShortDecomposition, 'H' | 'D'>, s: number) => d.H - s * d.D;
export const shortPoolSd = (d: Pick<ShortDecomposition, 'H' | 'D' | 'D2'>, s: number) => Math.sqrt(Math.max(0, d.H + s * s * d.D2 - shortPoolEv(d, s) ** 2));

/** The S that leaves the pool `edge` per short, rounded down to the 0.05x grid; 0 when no S can. */
export function fairShortBps(d: Pick<ShortDecomposition, 'H' | 'D'>, edge: number) {
  if (d.D <= 0 || d.H <= edge) return 0;
  return Math.floor(ONE_X_BPS * (d.H - edge) / d.D / MULTIPLIER_STEP_BPS) * MULTIPLIER_STEP_BPS;
}

/** One machine's short pricing, stored in the `calibration` table with level 'short'. */
export type ShortCalibrationRow = {
  code: string; n: number; fromMs: number; toMs: number; computedAt: number;
  H: number; D: number; D2: number; pMiss: number; pPush: number; pHit: number;
  /**
   * Fair S per target edge, and whether the data supports it (the pool's 95% lower bound at that S is ≥ 0).
   * A short's payouts are bounded, so the normal approximation is sound here.
   */
  fair: { edgeBps: number; bps: number; safe: boolean }[];
};

export function calibrateShort(code: string, ratios: readonly number[], window: { fromMs: number; toMs: number }, options: { edgesBps: number[]; now?: number }): ShortCalibrationRow | null {
  if (!ratios.length) return null;
  const d = decomposeShort(ratios);
  const fair = options.edgesBps.map(edgeBps => {
    const bps = fairShortBps(d, edgeBps / 10_000), s = bps / ONE_X_BPS;
    return { edgeBps, bps, safe: bps > 0 && lcb95Normal(shortPoolEv(d, s), shortPoolSd(d, s), d.n) >= 0 };
  });
  return { code, n: d.n, fromMs: window.fromMs, toMs: window.toMs, computedAt: options.now ?? Date.now(), H: d.H, D: d.D, D2: d.D2, pMiss: d.pMiss, pPush: d.pPush, pHit: d.pHit, fair };
}

const usd = (micros: number) => `$${Math.ceil(micros / 1_000_000).toLocaleString('en-US')}`;

/**
 * What a short on one machine can be offered at right now, or why not. Same rules as long packs: only at a
 * fair S (the lower edge once the data supports it), never a quietly worse one. It opens once the pool covers
 * its bankroll and one short's top payout fits under the per-pull cap.
 */
export function shortOffer(row: ShortCalibrationRow, ctx: OfferContext): Offer {
  const s = ctx.settings;
  const fairAt = (edgeBps: number) => row.fair.find(f => f.edgeBps === edgeBps);
  const low = fairAt(s.minEdgeBps), high = fairAt(s.edgeBps);
  const priced = low?.safe ? low : high?.safe ? high : null;
  const shortBps = priced?.bps ?? high?.bps ?? 0, edgeBps = priced?.edgeBps ?? s.edgeBps;
  // Rounding S down only adds to the pool's edge.
  const edge = Math.max(edgeBps / 10_000, shortPoolEv(row, shortBps / ONE_X_BPS)), sd = shortPoolSd(row, shortBps / ONE_X_BPS);
  const capMicros = shortMaxPayoutMicros(ctx.priceMicros, ctx.minValueMicros, shortBps);
  const unlockAtMicros = Math.max(ruinBankrollMicros(sd, edge, ctx.priceMicros, s.ruinProbability), Math.ceil(capMicros * 10_000 / s.capBps));
  const reason =
    ctx.now - row.computedAt > s.calibrationMaxAgeHours * 3_600_000 ? 'Paused until the odds are re-checked.'
    : row.n < s.minSamples ? `Collecting pull data (${row.n} of ${s.minSamples}).`
    : !priced || !Number.isFinite(unlockAtMicros) ? 'Collecting more pulls before this can be priced fairly.'
    : ctx.freeMicros < unlockAtMicros ? `Unlocks when the pool reaches ${usd(unlockAtMicros)}.`
    : null;
  return {
    side: 'short', level: 'full', available: reason === null, reason, multiplierBps: shortBps, floorBps: 0, capMicros, edgeBps,
    poolEdge: edge, playerReturn: -edge, normalReturn: 0,
    // From the player's side: a short wins when the pull misses.
    pLoss: row.pHit, pPush: row.pPush, pWin: row.pMiss,
    maxLossMicros: ctx.priceMicros,
    unlockAtMicros: Number.isFinite(unlockAtMicros) ? unlockAtMicros : Number.MAX_SAFE_INTEGER,
  };
}
