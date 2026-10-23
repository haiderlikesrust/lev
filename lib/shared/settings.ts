import { z } from 'zod';
import type { Level } from './leverage';

/**
 * Owner-editable settings. Player limits default to off (0 = no limit), like Pullback; the pool is
 * protected by the per-pack cap, the unlock rule and the auto-pause instead.
 * TODO: every number here is a launch default to confirm (edge, cap, pause threshold, target, cool-down).
 */
export type Settings = {
  paused: boolean;
  /** Pool edge per pack at launch, and the lower edge a machine moves to once its data supports it (bps of the pack price). */
  edgeBps: number; minEdgeBps: number;
  /** Largest bonus on one pack, as bps of the free pool, locked when the order is made. */
  capBps: number;
  /** A level opens only once that cap is at least this many pack prices. */
  minCapMultiple: number;
  /** A level opens only once the pool covers its bankroll for this chance of ruin. */
  ruinProbability: number;
  calibrationWindowDays: number; calibrationMaxAgeHours: number; minSamples: number;
  /** New packs stop when the free pool drops below this; packs in progress still settle. */
  pauseThresholdUsd: number;
  /** The pool size the health meter reads as 100%. */
  targetReserveUsd: number;
  perWalletDailyPacks: number; perWalletDailyUsd: number; globalDailyUsd: number;
  /** After this many losses in a row, a wallet waits `cooldownMinutes`. */
  cooldownLosses: number; cooldownMinutes: number;
  levels: Record<Level, boolean>;
  /** Shorts: bets that the next pull on a machine misses. */
  shortsEnabled: boolean;
  /**
   * A short rides the first pull CC stamps at least this long after its payment confirmed, so nobody can short a
   * pull they have already seen. TODO: confirm on devnet how late CC stamps `created_at` after a reveal.
   */
  shortGuardSeconds: number;
  /** A short with no pull after this long is refunded in full (a quiet machine, or CC's feed is down). */
  shortWaitMinutes: number;
  disabledMachines: string[];
  /** Share of incoming creator-fee USDC that is pool money; the rest is held for the owner's buyback. */
  feePoolShareBps: number;
  /** Slippage ceiling for the buyback swap. */
  buybackSlippageBps: number;
};

export const DEFAULT_SETTINGS: Settings = {
  paused: false,
  edgeBps: 500, minEdgeBps: 300,
  capBps: 1_000, minCapMultiple: 10, ruinProbability: 0.01,
  calibrationWindowDays: 30, calibrationMaxAgeHours: 48, minSamples: 200,
  pauseThresholdUsd: 1_000, targetReserveUsd: 50_000,
  perWalletDailyPacks: 0, perWalletDailyUsd: 0, globalDailyUsd: 0,
  cooldownLosses: 5, cooldownMinutes: 10,
  levels: { half: true, full: true },
  shortsEnabled: true, shortGuardSeconds: 30, shortWaitMinutes: 60,
  disabledMachines: [],
  feePoolShareBps: 8_500, buybackSlippageBps: 100,
};

const nonNegative = z.number().finite().min(0);
export const settingsSchema = z.object({
  paused: z.boolean(),
  edgeBps: z.number().int().min(100).max(2_000), minEdgeBps: z.number().int().min(100).max(2_000),
  capBps: z.number().int().min(10).max(5_000), minCapMultiple: z.number().min(1).max(1_000), ruinProbability: z.number().min(0.0001).max(0.2),
  calibrationWindowDays: z.number().int().min(1).max(365), calibrationMaxAgeHours: z.number().min(1).max(24 * 14), minSamples: z.number().int().min(50).max(100_000),
  pauseThresholdUsd: nonNegative, targetReserveUsd: z.number().finite().positive(),
  perWalletDailyPacks: z.number().int().min(0), perWalletDailyUsd: nonNegative, globalDailyUsd: nonNegative,
  cooldownLosses: z.number().int().min(0).max(100), cooldownMinutes: z.number().min(0).max(24 * 60),
  levels: z.object({ half: z.boolean(), full: z.boolean() }),
  shortsEnabled: z.boolean(), shortGuardSeconds: z.number().min(0).max(600), shortWaitMinutes: z.number().min(1).max(24 * 60),
  disabledMachines: z.array(z.string().max(64)).max(64),
  feePoolShareBps: z.number().int().min(0).max(10_000), buybackSlippageBps: z.number().int().min(10).max(1_000),
}).refine(s => s.minEdgeBps <= s.edgeBps, { message: 'The lower edge cannot be above the launch edge.' });
