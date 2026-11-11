import {
  CAP_GRID, LEVELS, LEVEL_FLOOR_BPS, MAX_MULTIPLIER_BPS, ONE_X_BPS, bootstrap, decompose, lcb95Normal, moments, playerReturn, poolEv, poolSd,
  roundDownMultiplierBps, ruinBankrollMicros, safeMultiplierBps, solveK, type Level,
} from './leverage';
import type { Side } from './short';

export type { Level, Side };

/** One machine × level, as computed by the daily calibration and stored in the `calibration` table. */
export type CalibrationRow = {
  code: string; level: Level; n: number; fromMs: number; toMs: number; computedAt: number;
  buyback: number; floor: number; normalReturn: number; pLoss: number; pPush: number; pWin: number;
  /** Uncapped decomposition: pool EV(k) = A − k·W; Var(k) = va − 2k·caw + k²·vw (pack prices). */
  A: number; W: number; va: number; vw: number; caw: number;
  /**
   * Fair multipliers per target edge and cap (cap in pack prices, null = none), each rounded down to the
   * 0.05x grid, and whether the data supports it: pool EV's 95% lower bound at that multiple is ≥ 0.
   * `mean` and `sd` are the pool's EV and standard deviation per pack at that multiple and cap (pack prices);
   * rows calibrated before caps under 10× lack them.
   */
  fair: { edgeBps: number; capRatio: number | null; bps: number; safe: boolean; mean?: number; sd?: number }[];
  /** Largest multiplier whose bootstrapped LCB95 pool EV is ≥ 0 (uncapped, so conservative). */
  safeBps: number;
};

export type CalibrationOptions = { edgesBps: number[]; resamples?: number; seed?: number; now?: number };

/** Calibrates one machine from its recent pulls (`ratios` = value / price), for every level. */
export function calibrateMachine(code: string, ratios: readonly number[], buyback: number, window: { fromMs: number; toMs: number }, options: CalibrationOptions): CalibrationRow[] {
  if (!ratios.length) return [];
  const boot = bootstrap(ratios, buyback, options.resamples ?? 1_000, options.seed);
  return LEVELS.map(level => {
    const floor = LEVEL_FLOOR_BPS[level] / 10_000, d = decompose(ratios, buyback, floor), safeBps = safeMultiplierBps(boot, floor);
    const fair = options.edgesBps.flatMap(edgeBps => CAP_GRID.map(capRatio => {
      const cap = capRatio ?? Number.POSITIVE_INFINITY;
      const bps = roundDownMultiplierBps(Math.round(ONE_X_BPS * (1 + solveK(ratios, buyback, floor, edgeBps / 10_000, cap))));
      const at = moments(ratios, { buyback, floor, k: (bps - ONE_X_BPS) / ONE_X_BPS, capRatio: cap });
      const safe = bps > ONE_X_BPS && (capRatio === null ? bps <= safeBps : lcb95Normal(at.mean, at.sd, d.n) >= 0);
      return { edgeBps, capRatio, bps, safe, mean: at.mean, sd: at.sd };
    }));
    return {
      code, level, n: d.n, fromMs: window.fromMs, toMs: window.toMs, computedAt: options.now ?? Date.now(),
      buyback, floor, normalReturn: d.normalReturn, pLoss: d.pLoss, pPush: d.pPush, pWin: d.pWin,
      A: d.A, W: d.W, va: d.va, vw: d.vw, caw: d.caw, fair, safeBps,
    };
  });
}

export type OfferContext = {
  priceMicros: number;
  /** Free leverage-pool balance (balance − reservations). */
  freeMicros: number;
  /** Lowest card value the machine pays (its common tier's start), for the worst-case loss. */
  minValueMicros: number;
  now: number;
  settings: {
    capBps: number; minCapMultiple: number; edgeBps: number; minEdgeBps: number;
    ruinProbability: number; calibrationMaxAgeHours: number; minSamples: number;
  };
};

export type Offer = {
  side: Side; level: Level; available: boolean; reason: string | null;
  multiplierBps: number; floorBps: number; capMicros: number; edgeBps: number;
  /** Per pack, as a fraction of the price, valued at CC's sellback price. */
  poolEdge: number; playerReturn: number; normalReturn: number;
  pLoss: number; pPush: number; pWin: number;
  /** Worst case for the player, in micros. */
  maxLossMicros: number;
  /** Free pool balance this level needs before it opens. */
  unlockAtMicros: number;
};

const usd = (micros: number) => `$${Math.ceil(micros / 1_000_000).toLocaleString('en-US')}`;

/** A top bonus up to the pack's own price may take a quarter of the free pool; a bigger one only `capBps` of it. */
const PRICE_CAP_SHARE_BPS = 2_500;

/** One way to offer a level: a bonus cap and pool edge at their fair multiple, and the free pool they need. */
type CapTerms = { capRatio: number | null; bps: number; edgeBps: number; edge: number; capMicros: number; needMicros: number };

/**
 * Every way the calibration priced this level: each bonus cap at each target edge the data supports, at its fair
 * multiple. Each needs a free pool that both carries its ups and downs (under `ruinProbability`) and fits the cap
 * in one pack's share. A cap so tight that its fair multiple would pass the solver's ceiling is left out: the
 * multiple shown there would quietly widen the pool's edge.
 */
function capTerms(row: CalibrationRow, ctx: OfferContext, share: number): CapTerms[] {
  const s = ctx.settings, price = ctx.priceMicros, largest = Math.max(0, ...row.fair.map(f => f.capRatio ?? 0));
  return row.fair.flatMap(f => {
    if (!f.safe || f.bps >= MAX_MULTIPLIER_BPS || (f.edgeBps !== s.minEdgeBps && f.edgeBps !== s.edgeBps)) return [];
    if (f.capRatio !== null && f.capRatio < s.minCapMultiple) return [];
    const k = (f.bps - ONE_X_BPS) / ONE_X_BPS;
    // Rounding down only adds to the pool's edge. Rows from before capped figures were stored use the uncapped ones,
    // which only overstate the risk.
    const edge = Math.max(f.edgeBps / 10_000, f.mean ?? poolEv(row, k)), sd = f.sd ?? poolSd(row, k);
    // A finite cap is exactly that many pack prices. With none, the pack's share of the pool caps the bonus, and the
    // share must pass the largest tabulated cap for the uncapped multiple to be the fair one.
    const minShare = f.capRatio === null ? largest * price + 1 : f.capRatio * price;
    const shareBps = minShare <= price ? Math.max(s.capBps, PRICE_CAP_SHARE_BPS) : s.capBps;
    const needMicros = Math.max(ruinBankrollMicros(sd, edge, price, s.ruinProbability), Math.ceil(minShare * 10_000 / shareBps));
    return [{ capRatio: f.capRatio, bps: f.bps, edgeBps: f.edgeBps, edge, capMicros: f.capRatio === null ? Math.max(share, minShare) : minShare, needMicros }];
  });
}

/**
 * What a machine × level can be offered at right now, or why not. Pure, so the UI and server agree.
 *
 * A level is only ever offered at a fair multiple: the one leaving the pool `minEdgeBps` once the data
 * supports it (bootstrapped LCB95 ≥ 0), else the one leaving `edgeBps`. If the data supports neither, the
 * level waits for more pulls rather than quietly widening the pool's edge.
 *
 * The bonus cap is the loosest one the free pool can carry, at the lowest edge that carries it. A small pool opens a
 * level with a tight cap (as little as the pack price) at the launch edge; as the pool grows, the cap and the top
 * bonus grow, the multiple eases, and the lower edge takes over. Every pack in progress reserves its cap, so what is
 * left decides what else can open.
 */
export function offer(row: CalibrationRow, ctx: OfferContext): Offer {
  const s = ctx.settings, free = Math.max(0, ctx.freeMicros), share = Math.floor(free * s.capBps / 10_000);
  const terms = capTerms(row, ctx, share), size = (t: CapTerms) => t.capRatio ?? Number.MAX_VALUE;
  const open = terms.filter(t => free >= t.needMicros).sort((a, b) => size(b) - size(a) || a.edgeBps - b.edgeBps)[0];
  // Until something fits, show the terms the level opens with, so "unlocks at $X" holds once the pool reaches $X.
  const first = [...terms].sort((a, b) => a.needMicros - b.needMicros || size(b) - size(a) || a.edgeBps - b.edgeBps)[0];
  const shown = open ?? first;
  // With nothing priced fairly yet, preview the launch-edge multiple at the loosest cap: the lowest it would be.
  const preview = row.fair.filter(f => f.edgeBps === s.edgeBps && (f.capRatio ?? Infinity) >= s.minCapMultiple && f.bps < MAX_MULTIPLIER_BPS)
    .sort((a, b) => a.bps - b.bps)[0];
  const multiplierBps = shown?.bps ?? preview?.bps ?? ONE_X_BPS, edgeBps = shown?.edgeBps ?? s.edgeBps, edge = shown?.edge ?? s.edgeBps / 10_000;
  const unlockAtMicros = first?.needMicros ?? Number.POSITIVE_INFINITY;
  const base: Offer = {
    side: 'long', level: row.level, available: false, reason: null, multiplierBps, floorBps: Math.round(row.floor * 10_000), capMicros: shown?.capMicros ?? 0, edgeBps,
    poolEdge: edge, playerReturn: playerReturn(row.normalReturn, edge), normalReturn: row.normalReturn,
    pLoss: row.pLoss, pPush: row.pPush, pWin: row.pWin,
    maxLossMicros: ctx.priceMicros - Math.floor(row.floor * row.buyback * ctx.minValueMicros),
    unlockAtMicros: Number.isFinite(unlockAtMicros) ? unlockAtMicros : Number.MAX_SAFE_INTEGER,
  };
  const reason =
    ctx.now - row.computedAt > s.calibrationMaxAgeHours * 3_600_000 ? 'Paused until the odds are re-checked.'
    : row.n < s.minSamples ? `Collecting pull data (${row.n} of ${s.minSamples}).`
    : !Number.isFinite(unlockAtMicros) ? 'Collecting more pulls before this can be priced fairly.'
    : !open ? `Unlocks when the pool reaches ${usd(unlockAtMicros)}.`
    : null;
  return { ...base, available: reason === null, reason };
}
