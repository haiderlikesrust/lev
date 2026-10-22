/**
 * Pure leverage-pack math, shared by the server, the calibration script and the UI.
 * Money is USDC micros (integers); pull values in calibration are ratios r = value / pack price.
 *
 * Per pack (P price, V insured value, b machine buyback, k = M − 1, φ loss floor, C bonus cap):
 *   loss  r < 0.95         pool sells the card for b·V and passes φ of that to the player
 *   push  0.95 ≤ r < 1.05  player gets the card
 *   win   r ≥ 1.05         player gets the card + min(k·(V − P), C)
 */

export type Outcome = 'loss' | 'push' | 'win';
export type Level = 'half' | 'full';
export const LEVELS: Level[] = ['half', 'full'];
export const LEVEL_NAME: Record<Level, string> = { half: 'Half risk', full: 'Full risk' };
/** Share of the sellback a losing player gets back. */
export const LEVEL_FLOOR_BPS: Record<Level, number> = { half: 5_000, full: 0 };

export const PUSH_LOW_BPS = 9_500;
export const PUSH_HIGH_BPS = 10_500;
export const ONE_X_BPS = 10_000;
/** Multipliers move in 0.05x steps and are always rounded down. */
export const MULTIPLIER_STEP_BPS = 500;

export function classify(priceMicros: number, valueMicros: number): Outcome {
  const p = BigInt(priceMicros), v = BigInt(valueMicros);
  if (v * 10_000n < p * BigInt(PUSH_LOW_BPS)) return 'loss';
  if (v * 10_000n >= p * BigInt(PUSH_HIGH_BPS)) return 'win';
  return 'push';
}

/** The win bonus: (value − price) × (M − 1), capped. Zero unless the pull is a win. */
export function bonusMicros(priceMicros: number, valueMicros: number, multiplierBps: number, capMicros: number) {
  if (classify(priceMicros, valueMicros) !== 'win' || multiplierBps <= ONE_X_BPS) return 0;
  const raw = (BigInt(valueMicros) - BigInt(priceMicros)) * BigInt(multiplierBps - ONE_X_BPS) / 10_000n;
  return Number(raw < BigInt(capMicros) ? raw : BigInt(capMicros));
}

/** A losing player's share of the sellback CC paid the pool. */
export const floorRefundMicros = (sellbackMicros: number, floorBps: number) => Number(BigInt(sellbackMicros) * BigInt(floorBps) / 10_000n);

export const roundDownMultiplierBps = (bps: number) => Math.floor(bps / MULTIPLIER_STEP_BPS) * MULTIPLIER_STEP_BPS;
export const formatMultiplier = (bps: number) => `${(bps / ONE_X_BPS).toFixed(2)}x`;

// ── Calibration (floating point, in units of the pack price) ─────────────────

export type PoolTerms = {
  /** Machine buyback, 0..1 (CC's `instantBuyback` / 100). */
  buyback: number;
  /** Loss floor φ, 0..1. */
  floor: number;
  /** Bonus factor k = M − 1. */
  k: number;
  /** Bonus cap in pack prices; Infinity for none. */
  capRatio: number;
};

/** The pool's profit on one pull, in pack prices. */
export function poolPnl(r: number, t: PoolTerms) {
  if (r < PUSH_LOW_BPS / 10_000) return (1 - t.floor) * t.buyback * r;
  if (r >= PUSH_HIGH_BPS / 10_000) return -Math.min(t.k * (r - 1), t.capRatio);
  return 0;
}

export function moments(ratios: readonly number[], t: PoolTerms) {
  let s1 = 0, s2 = 0;
  for (const r of ratios) { const x = poolPnl(r, t); s1 += x; s2 += x * x; }
  const n = ratios.length, mean = s1 / n;
  return { mean, sd: Math.sqrt(Math.max(0, s2 / n - mean * mean)) };
}

/**
 * The uncapped decomposition: pool EV(k) = A − k·W, Var(k) = va − 2k·caw + k²·vw.
 * `a` is the pool's take on losses, `w` how far wins beat the price.
 */
export function decompose(ratios: readonly number[], buyback: number, floor: number) {
  let sa = 0, sw = 0, saa = 0, sww = 0, saw = 0, loss = 0, push = 0, win = 0, sr = 0;
  for (const r of ratios) {
    let a = 0, w = 0;
    sr += r;
    if (r < PUSH_LOW_BPS / 10_000) { a = (1 - floor) * buyback * r; loss++; }
    else if (r >= PUSH_HIGH_BPS / 10_000) { w = r - 1; win++; }
    else push++;
    sa += a; sw += w; saa += a * a; sww += w * w; saw += a * w;
  }
  const n = ratios.length, A = sa / n, W = sw / n;
  return {
    n, A, W, va: saa / n - A * A, vw: sww / n - W * W, caw: saw / n - A * W,
    pLoss: loss / n, pPush: push / n, pWin: win / n,
    /** Selling every card straight back, the normal-open return per pack (cash basis). */
    normalReturn: buyback * sr / n - 1,
  };
}
export type Decomposition = ReturnType<typeof decompose>;

export const poolEv = (d: Pick<Decomposition, 'A' | 'W'>, k: number) => d.A - k * d.W;
export const poolSd = (d: Pick<Decomposition, 'va' | 'vw' | 'caw'>, k: number) => Math.sqrt(Math.max(0, d.va - 2 * k * d.caw + k * k * d.vw));
/**
 * Valued at CC's sellback price, the pool and the player split exactly what a normal open returns,
 * so the player's return is the normal-open return minus the pool's edge.
 */
export const playerReturn = (normalReturn: number, poolEdge: number) => normalReturn - poolEdge;

/** Closed form, no cap: the k that leaves the pool exactly `edge` per pack. */
export const closedFormK = (d: Pick<Decomposition, 'A' | 'W'>, edge: number) => d.W > 0 ? Math.max(0, (d.A - edge) / d.W) : 0;

const K_MAX = 5;
/** The k that leaves the pool `edge` per pack, with the cap applied (numeric). 0 when even k = 0 can't reach it. */
export function solveK(ratios: readonly number[], buyback: number, floor: number, edge: number, capRatio = Infinity) {
  const at = (k: number) => moments(ratios, { buyback, floor, k, capRatio }).mean;
  if (at(0) < edge) return 0;
  if (at(K_MAX) >= edge) return K_MAX;
  let lo = 0, hi = K_MAX;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (at(mid) >= edge) lo = mid; else hi = mid; }
  return lo;
}

/** Deterministic PRNG (xorshift32) so calibration runs are reproducible. */
export function rng(seed = 0x9e3779b9) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4_294_967_296; };
}

/**
 * Bootstrap of the uncapped decomposition: per resample, the mean pool take on losses at φ = 0 (A0)
 * and the mean win excess (W). EV at any (φ, k) for resample j is (1 − φ)·A0_j − k·W_j.
 */
export function bootstrap(ratios: readonly number[], buyback: number, resamples = 1_000, seed?: number) {
  const n = ratios.length, a = new Float64Array(n), w = new Float64Array(n), next = rng(seed);
  for (let i = 0; i < n; i++) {
    const r = ratios[i];
    if (r < PUSH_LOW_BPS / 10_000) a[i] = buyback * r; else if (r >= PUSH_HIGH_BPS / 10_000) w[i] = r - 1;
  }
  const A0 = new Float64Array(resamples), W = new Float64Array(resamples);
  for (let j = 0; j < resamples; j++) {
    let sa = 0, sw = 0;
    for (let i = 0; i < n; i++) { const pick = (next() * n) | 0; sa += a[pick]; sw += w[pick]; }
    A0[j] = sa / n; W[j] = sw / n;
  }
  return { A0, W };
}
export type Bootstrap = ReturnType<typeof bootstrap>;

/** 5th percentile of the bootstrapped pool EV at (φ, k): the pool's 95% lower confidence bound. */
export function lcb95(boot: Bootstrap, floor: number, k: number) {
  const evs = Array.from(boot.A0, (a0, j) => (1 - floor) * a0 - k * boot.W[j]).sort((x, y) => x - y);
  return evs[Math.floor(0.05 * evs.length)];
}

/** The largest multiplier on the 0.05x grid whose bootstrapped LCB95 pool EV is still ≥ 0. */
export function safeMultiplierBps(boot: Bootstrap, floor: number, maxBps = 50_000) {
  let best = ONE_X_BPS;
  for (let m = ONE_X_BPS + MULTIPLIER_STEP_BPS; m <= maxBps; m += MULTIPLIER_STEP_BPS) {
    if (lcb95(boot, floor, (m - ONE_X_BPS) / ONE_X_BPS) >= 0) best = m; else break;
  }
  return best;
}

/**
 * Bankroll for a `ruinProbability` chance of ever losing it, for a random walk with drift `edge`
 * and per-pack standard deviation `sd` (both in pack prices): B = sd²·ln(1/p) / (2·edge) · price.
 */
export function ruinBankrollMicros(sd: number, edge: number, priceMicros: number, ruinProbability = 0.01) {
  if (edge <= 0) return Number.POSITIVE_INFINITY;
  return Math.ceil(sd * sd * Math.log(1 / ruinProbability) / (2 * edge) * priceMicros);
}

/** Cap ratios (in pack prices) the calibration tabulates fair multipliers at; null is no cap. */
export const CAP_GRID: (number | null)[] = [10, 20, 50, 100, null];

/**
 * The fair multiplier at the smallest tabulated cap that is at least the real one. A looser cap pays
 * winners more, so its fair multiplier is lower: this never quotes above the true fair value.
 */
export function fairAtCap<T extends { capRatio: number | null }>(table: T[], capRatio: number): T | undefined {
  const size = (c: number | null) => c ?? Number.POSITIVE_INFINITY;
  return table.filter(t => size(t.capRatio) >= capRatio).sort((a, b) => size(a.capRatio) - size(b.capRatio))[0];
}

/** Normal-approximation 95% lower bound. Sound for capped payouts, whose tail is cut off; uncapped ones use the bootstrap. */
export const lcb95Normal = (mean: number, sd: number, n: number) => mean - 1.645 * sd / Math.sqrt(Math.max(1, n));
