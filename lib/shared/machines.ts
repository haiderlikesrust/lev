/** Collector Crypt machines offered with leverage, by CC machine code. */
export type MachineDef = { code: string; name: string; priceUsd: number };

export const MACHINES: MachineDef[] = [
  { code: 'pokemon_25', name: 'Starter', priceUsd: 25 },
  { code: 'pokemon_50', name: 'Elite', priceUsd: 50 },
  { code: 'pokemon_100', name: 'Bronze', priceUsd: 100 },
  { code: 'pokemon_250', name: 'Legendary', priceUsd: 250 },
  { code: 'pokemon_500', name: 'Hyper', priceUsd: 500 },
  { code: 'pokemon_1000', name: 'Grail', priceUsd: 1000 },
];

export const machineDef = (code: string | null | undefined) => MACHINES.find(m => m.code === code) ?? null;

export type Tier = 'common' | 'uncommon' | 'rare' | 'epic';
export const TIERS: Tier[] = ['common', 'uncommon', 'rare', 'epic'];
/** CC's `prize_tier`: 1 Epic, 2 Rare, 3 Uncommon, 4 Common. */
export const tierOf = (prizeTier: number | null | undefined): Tier | null => ({ 1: 'epic', 2: 'rare', 3: 'uncommon', 4: 'common' } as Record<number, Tier>)[prizeTier ?? 0] ?? null;

/** A machine as CC's `GET /api/machines` describes it (the fields we use). */
export type MachineConfig = {
  code: string; name: string; priceUsd: number;
  /** % of insured value CC pays on instant buyback. */
  buybackPct: number;
  odds: Record<Tier, number>;
  tierRanges: Record<Tier, { start: number; end: number }>;
  /** CC's own expected insured value per pack; null until CC computes it. */
  ev: number | null;
  public: boolean;
};
