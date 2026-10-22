import type { Database } from './db';
import { sum } from './db';
import { config } from './config';
import type { LevPool } from './pool';
import type { PackProvider, Solana } from './ports';
import type { SettingsStore } from './settings';
import type { Collector } from './collector';
import { loadCalibration } from './calibration';
import { offer, type Offer } from '../shared/calibration';
import { LEVELS } from '../shared/leverage';
import { MACHINES, machineDef } from '../shared/machines';
import { APP_NAME } from '../shared/brand';
import type { ConfigView, LeaderboardView, MachineView, OfferView, Period, PoolView, SettlementView } from '../shared/types';

const usd = (micros: number | string) => Number(micros) / 1_000_000;

export const offerView = (o: Offer): OfferView => {
  const { capMicros, maxLossMicros, unlockAtMicros, ...rest } = o;
  return { ...rest, capUsd: usd(capMicros), maxLossUsd: usd(maxLossMicros), unlockAtUsd: usd(unlockAtMicros) };
};

export async function poolView(db: Database, pool: LevPool): Promise<PoolView> {
  const h = await pool.health();
  const counts = (await db.query<{ outcome: string; n: number }>('SELECT outcome, COUNT(*)::int AS n FROM settlements GROUP BY outcome')).rows;
  const n = (outcome: string) => counts.find(c => c.outcome === outcome)?.n ?? 0;
  // Publicly, only the pool's share of each creator-fee transfer.
  const splits = (await db.query<{ signature: string; amount_micros: string; cycle: string | null; received_at: string }>('SELECT signature, COALESCE(pool_micros, amount_micros)::text AS amount_micros, cycle, received_at::text FROM fee_splits ORDER BY received_at DESC LIMIT 20')).rows;
  return {
    balanceUsd: usd(h.balanceMicros), reservedUsd: usd(h.reservedMicros), freeUsd: usd(h.freeMicros), targetUsd: usd(h.targetMicros), healthBps: h.healthBps, pauseReason: h.pauseReason,
    totals: {
      bonusesUsd: -usd(await sum(db, "bucket='pool' AND kind='bonus'")), floorsUsd: -usd(await sum(db, "bucket='pool' AND kind='floor'")),
      sellbackUsd: usd(await sum(db, "bucket='pool' AND kind='sellback'")), feeSplitsUsd: usd(await sum(db, "bucket='pool' AND kind='fee-split'")),
      packs: n('win') + n('push') + n('loss'), wins: n('win'), pushes: n('push'), losses: n('loss'),
    },
    feeSplits: splits.map(s => ({ signature: s.signature, amountUsd: usd(s.amount_micros), cycle: s.cycle, receivedAt: Number(s.received_at) })),
  };
}

export async function machinesView(db: Database, pool: LevPool, packs: PackProvider, settings: SettingsStore, collector: Collector): Promise<MachineView[]> {
  const [configs, rows, free, open] = [await collector.configs(), await loadCalibration(db), await pool.free(), await packs.openMachines().catch(() => new Set<string>())];
  const s = settings.current, now = Date.now();
  return MACHINES.flatMap(def => {
    const c = configs.find(x => x.code === def.code);
    if (!c) return [];
    const own = rows.filter(r => r.code === def.code);
    const offers = LEVELS.flatMap(level => {
      const row = own.find(r => r.level === level);
      if (!row) return [];
      const o = offer(row, { priceMicros: c.priceUsd * 1_000_000, freeMicros: free, minValueMicros: c.tierRanges.common.start * 1_000_000, now, settings: s });
      const off = !s.levels[level] ? 'Turned off by the team.' : s.disabledMachines.includes(def.code) ? 'This machine is turned off by the team.' : !open.has(def.code) ? 'Collector Crypt is not selling from this machine right now.' : null;
      return [offerView(off ? { ...o, available: false, reason: off } : o)];
    });
    return [{ code: def.code, name: def.name, priceUsd: c.priceUsd, buybackPct: c.buybackPct, image: c.image ?? null, video: c.video ?? null, open: open.has(def.code), disabled: s.disabledMachines.includes(def.code),
      calibratedAt: own[0]?.computedAt ?? null, pulls: own[0]?.n ?? 0, offers }];
  });
}

export async function configView(db: Database, solana: Solana, pool: LevPool, packs: PackProvider, settings: SettingsStore, collector: Collector): Promise<ConfigView> {
  const s = settings.current;
  return {
    appName: APP_NAME, practice: !config.live, cluster: config.SOLANA_CLUSTER, opsAddress: solana.opsAddress, poolAddress: solana.poolAddress,
    machines: await machinesView(db, pool, packs, settings, collector), pool: await poolView(db, pool),
    rules: {
      cooldownLosses: s.cooldownLosses, cooldownMinutes: s.cooldownMinutes, capBps: s.capBps, edgeBps: s.edgeBps, minEdgeBps: s.minEdgeBps,
      minCapMultiple: s.minCapMultiple, pauseThresholdUsd: s.pauseThresholdUsd, targetReserveUsd: s.targetReserveUsd, calibrationWindowDays: s.calibrationWindowDays, ruinProbability: s.ruinProbability,
    },
  };
}

/** Wallets show shortened in the public log. */
const shortWallet = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;

const settlementRow = (r: any, packs: PackProvider, fullWallet = false): SettlementView => ({
  orderId: r.order_id, wallet: fullWallet ? r.wallet : shortWallet(r.wallet), code: r.code, machineName: machineDef(r.code)?.name ?? r.code, level: r.level,
  multiplierBps: r.multiplier_bps, priceUsd: usd(r.price_micros), valueUsd: usd(r.value_micros), outcome: r.outcome,
  bonusUsd: usd(r.bonus_micros), floorUsd: usd(r.floor_micros), sellbackUsd: usd(r.sellback_micros),
  card: r.card, settledAt: Number(r.settled_at), links: r.links, vrfUrl: r.memo ? packs.vrfUrl(r.memo) : null,
});

export async function settlementsView(db: Database, packs: PackProvider, options: { wallet?: string; limit?: number; before?: number } = {}): Promise<SettlementView[]> {
  const params: unknown[] = [Math.min(200, options.limit ?? 50)], where: string[] = [];
  if (options.wallet) { params.push(options.wallet); where.push(`wallet=$${params.length}`); }
  if (options.before) { params.push(options.before); where.push(`settled_at < $${params.length}`); }
  const rows = (await db.query<any>(`SELECT * FROM settlements ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY settled_at DESC LIMIT $1`, params)).rows;
  return rows.map(r => settlementRow(r, packs, !!options.wallet));
}

const PERIOD_MS: Record<Period, number> = { '24h': 86_400_000, '7d': 7 * 86_400_000, all: Number.POSITIVE_INFINITY };

/** Public stats on our platform's packs, for the leaderboard and home page. Every settlement carries its full transaction proof. */
export async function leaderboardView(db: Database, packs: PackProvider, collector: Collector, period: Period): Promise<LeaderboardView> {
  const since = Number.isFinite(PERIOD_MS[period]) ? Date.now() - PERIOD_MS[period] : 0;
  const n = (v: string | number | null) => Number(v ?? 0);
  const byOutcome = (await db.query<any>(`SELECT outcome, COUNT(*)::int AS n, COALESCE(SUM(price_micros),0)::text AS volume, COALESCE(SUM(bonus_micros),0)::text AS bonus,
      COALESCE(SUM(floor_micros),0)::text AS floor, COALESCE(SUM(sellback_micros),0)::text AS sellback, COALESCE(SUM(value_micros),0)::text AS value,
      COALESCE(MAX(bonus_micros),0)::text AS max_bonus, COALESCE(MAX(value_micros),0)::text AS max_value
    FROM settlements WHERE settled_at >= $1 GROUP BY outcome`, [since])).rows;
  const sum = (key: string, only?: string) => byOutcome.filter(r => !only || r.outcome === only).reduce((s, r) => s + n(r[key]), 0);
  const count = (outcome: string) => byOutcome.find(r => r.outcome === outcome)?.n ?? 0;
  const top = async (order: string, where = '') => (await db.query<any>(`SELECT * FROM settlements WHERE settled_at >= $1 ${where} ORDER BY ${order} DESC, settled_at DESC LIMIT 10`, [since])).rows.map(r => settlementRow(r, packs));
  const configs = await collector.configs();
  const perMachine = (await db.query<any>(`SELECT code, COUNT(*)::int AS packs, COUNT(*) FILTER (WHERE outcome='win')::int AS wins, COUNT(*) FILTER (WHERE outcome='push')::int AS pushes,
      COUNT(*) FILTER (WHERE outcome='loss')::int AS losses, COALESCE(SUM(price_micros),0)::text AS volume, COALESCE(SUM(bonus_micros),0)::text AS bonus,
      COALESCE(SUM(sellback_micros),0)::text AS sellback, COALESCE(SUM(floor_micros),0)::text AS floor
    FROM settlements WHERE settled_at >= $1 GROUP BY code`, [since])).rows;
  return {
    period,
    totals: {
      packs: count('win') + count('push') + count('loss'), wins: count('win'), pushes: count('push'), losses: count('loss'),
      volumeUsd: usd(sum('volume')), bonusesUsd: usd(sum('bonus')), floorsUsd: usd(sum('floor')), sellbackUsd: usd(sum('sellback')),
      returnedUsd: usd(sum('bonus') + sum('floor') + sum('value', 'win') + sum('value', 'push')),
      biggestBonusUsd: usd(Math.max(0, ...byOutcome.map(r => n(r.max_bonus)))), biggestPullUsd: usd(Math.max(0, ...byOutcome.map(r => n(r.max_value)))),
    },
    topBonuses: await top('bonus_micros', "AND outcome='win'"),
    topPulls: await top('value_micros'),
    machines: MACHINES.map(def => {
      const r = perMachine.find(x => x.code === def.code), volume = n(r?.volume);
      return { code: def.code, name: def.name, image: configs.find(c => c.code === def.code)?.image ?? null, packs: r?.packs ?? 0, wins: r?.wins ?? 0, pushes: r?.pushes ?? 0, losses: r?.losses ?? 0,
        volumeUsd: usd(volume), bonusesUsd: usd(n(r?.bonus)), sellbackUsd: usd(n(r?.sellback)), floorsUsd: usd(n(r?.floor)),
        realizedEdge: volume > 0 ? (n(r?.sellback) - n(r?.floor) - n(r?.bonus)) / volume : null };
    }),
  };
}
