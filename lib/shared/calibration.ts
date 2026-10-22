import {
  CAP_GRID, LEVELS, LEVEL_FLOOR_BPS, ONE_X_BPS, bootstrap, decompose, fairAtCap, lcb95Normal, moments, playerReturn, poolEv, poolSd,
  roundDownMultiplierBps, ruinBankrollMicros, safeMultiplierBps, solveK, type Level,
} from './leverage';

export type { Level };

/** One machine × level, as computed by the daily calibration and stored in the `calibration` table. */
export type CalibrationRow = {
  code: string; level: Level; n: number; fromMs: number; toMs: number; computedAt: number;
  buyback: number; floor: number; normalReturn: number; pLoss: number; pPush: number; pWin: number;
  /** Uncapped decomposition: pool EV(k) = A − k·W; Var(k) = va − 2k·caw + k²·vw (pack prices). */
  A: number; W: number; va: number; vw: number; caw: number;
  /**
   * Fair multipliers per target edge and cap (cap in pack prices, null = none), each rounded down to the
   * 0.05x grid, and whether the data supports it: pool EV's 95% lower bound at that multiple is ≥ 0.
   */
  fair: { edgeBps: number; capRatio: number | null; bps: number; safe: boolean }[];
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
      return { edgeBps, capRatio, bps, safe };
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
  level: Level; available: boolean; reason: string | null;
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

/**
 * What a machine × level can be offered at right now, or why not. Pure, so the UI and server agree.
 *
 * A level is only ever offered at a fair multiple: the one leaving the pool `minEdgeBps` once the data
 * supports it (bootstrapped LCB95 ≥ 0), else the one leaving `edgeBps`. If the data supports neither, the
 * level waits for more pulls rather than quietly widening the pool's edge.
 */
export function offer(row: CalibrationRow, ctx: OfferContext): Offer {
  const s = ctx.settings, k = (bps: number) => (bps - ONE_X_BPS) / ONE_X_BPS;
  const capMicros = Math.floor(Math.max(0, ctx.freeMicros) * s.capBps / 10_000);
  // Below the unlock size, price as if the pool were exactly there: a bigger pool loosens the cap, which only
  // lowers the fair multiple and its bankroll, so "unlocks at $X" holds once the pool reaches $X.
  const capRatio = Math.max(capMicros / ctx.priceMicros, s.minCapMultiple);
  const fairAt = (edgeBps: number) => fairAtCap(row.fair.filter(f => f.edgeBps === edgeBps), capRatio);
  const low = fairAt(s.minEdgeBps), high = fairAt(s.edgeBps);
  const priced = low?.safe ? low : high?.safe ? high : null;
  const multiplierBps = priced?.bps ?? high?.bps ?? ONE_X_BPS, edgeBps = priced?.edgeBps ?? s.edgeBps;
  // The cap and rounding down only add to the pool's edge; the uncapped figure is a floor under it.
  const edge = Math.max(edgeBps / 10_000, poolEv(row, k(multiplierBps))), sd = poolSd(row, k(multiplierBps));
  const bankroll = ruinBankrollMicros(sd, edge, ctx.priceMicros, s.ruinProbability);
  const unlockAtMicros = Math.max(bankroll, Math.ceil(s.minCapMultiple * ctx.priceMicros * 10_000 / s.capBps));
  const base: Offer = {
    level: row.level, available: false, reason: null, multiplierBps, floorBps: Math.round(row.floor * 10_000), capMicros, edgeBps,
    poolEdge: edge, playerReturn: playerReturn(row.normalReturn, edge), normalReturn: row.normalReturn,
    pLoss: row.pLoss, pPush: row.pPush, pWin: row.pWin,
    maxLossMicros: ctx.priceMicros - Math.floor(row.floor * row.buyback * ctx.minValueMicros),
    unlockAtMicros: Number.isFinite(unlockAtMicros) ? unlockAtMicros : Number.MAX_SAFE_INTEGER,
  };
  const reason =
    ctx.now - row.computedAt > s.calibrationMaxAgeHours * 3_600_000 ? 'Paused until the odds are re-checked.'
    : row.n < s.minSamples ? `Collecting pull data (${row.n} of ${s.minSamples}).`
    : !priced || !Number.isFinite(unlockAtMicros) ? 'Collecting more pulls before this can be priced fairly.'
    : ctx.freeMicros < unlockAtMicros ? `Unlocks when the pool reaches ${usd(unlockAtMicros)}.`
    : null;
  return { ...base, available: reason === null, reason };
}
