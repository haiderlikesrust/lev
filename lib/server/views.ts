import type { Database } from './db';
import { sum } from './db';
import { config } from './config';
import type { LevPool } from './pool';
import type { PackProvider, Solana } from './ports';
import type { SettingsStore } from './settings';
import type { Collector } from './collector';
import { loadCalibration, loadShortCalibration } from './calibration';
import { offer, type Offer } from '../shared/calibration';
import { LEVELS } from '../shared/leverage';
import { shortOffer } from '../shared/short';
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
  const counts = (await db.query<{ side: string; outcome: string; n: number }>('SELECT side, outcome, COUNT(*)::int AS n FROM settlements GROUP BY side, outcome')).rows;
  const n = (outcome: string) => counts.find(c => c.side === 'long' && c.outcome === outcome)?.n ?? 0;
  // Publicly, only the pool's share of each creator-fee transfer.
  const splits = (await db.query<{ signature: string; amount_micros: string; cycle: string | null; received_at: string }>('SELECT signature, COALESCE(pool_micros, amount_micros)::text AS amount_micros, cycle, received_at::text FROM fee_splits ORDER BY received_at DESC LIMIT 20')).rows;
  return {
    balanceUsd: usd(h.balanceMicros), reservedUsd: usd(h.reservedMicros), freeUsd: usd(h.freeMicros), targetUsd: usd(h.targetMicros), healthBps: h.healthBps, pauseReason: h.pauseReason,
    totals: {
      bonusesUsd: -usd(await sum(db, "bucket='pool' AND kind='bonus'")), floorsUsd: -usd(await sum(db, "bucket='pool' AND kind='floor'")),
      sellbackUsd: usd(await sum(db, "bucket='pool' AND kind='sellback'")), feeSplitsUsd: usd(await sum(db, "bucket='pool' AND kind='fee-split'")),
      packs: n('win') + n('push') + n('loss'), wins: n('win'), pushes: n('push'), losses: n('loss'),
      shortPayoutsUsd: -usd(await sum(db, "bucket='pool' AND kind='short-payout'")), shortStakesUsd: usd(await sum(db, "bucket='pool' AND kind='short-stake'")),
      shorts: counts.filter(c => c.side === 'short').reduce((t, c) => t + c.n, 0),
    },
    feeSplits: splits.map(s => ({ signature: s.signature, amountUsd: usd(s.amount_micros), cycle: s.cycle, receivedAt: Number(s.received_at) })),
  };
}

export async function machinesView(db: Database, pool: LevPool, packs: PackProvider, settings: SettingsStore, collector: Collector): Promise<MachineView[]> {
  const [configs, rows, shorts, free, open] = [await collector.configs(), await loadCalibration(db), await loadShortCalibration(db), await pool.free(), await packs.openMachines().catch(() => new Set<string>())];
  const s = settings.current, now = Date.now();
  return MACHINES.flatMap(def => {
    const c = configs.find(x => x.code === def.code);
    if (!c) return [];
    const own = rows.filter(r => r.code === def.code);
    const ctx = { priceMicros: c.priceUsd * 1_000_000, freeMicros: free, minValueMicros: c.tierRanges.common.start * 1_000_000, now, settings: s };
    const closed = s.disabledMachines.includes(def.code) ? 'This machine is turned off by the team.' : !open.has(def.code) ? 'Collector Crypt is not selling from this machine right now.' : null;
    const offers = LEVELS.flatMap(level => {
      const row = own.find(r => r.level === level);
      if (!row) return [];
      const o = offer(row, ctx), off = !s.levels[level] ? 'Turned off by the team.' : closed;
      return [offerView(off ? { ...o, available: false, reason: off } : o)];
    });
    const shortRow = shorts.find(r => r.code === def.code), so = shortRow ? shortOffer(shortRow, ctx) : null, shortOff = !s.shortsEnabled ? 'Turned off by the team.' : closed;
    return [{ code: def.code, name: def.name, priceUsd: c.priceUsd, buybackPct: c.buybackPct, image: c.image ?? null, video: c.video ?? null, open: open.has(def.code), disabled: s.disabledMachines.includes(def.code),
      calibratedAt: own[0]?.computedAt ?? null, pulls: own[0]?.n ?? 0, offers, short: so ? offerView(shortOff ? { ...so, available: false, reason: shortOff } : so) : null }];
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
      shortsEnabled: s.shortsEnabled, shortGuardSeconds: s.shortGuardSeconds, shortWaitMinutes: s.shortWaitMinutes,
    },
  };
}

/** Wallets show shortened in the public log. */
const shortWallet = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;

const settlementRow = (r: any, packs: PackProvider, fullWallet = false): SettlementView => ({
  orderId: r.order_id, wallet: fullWallet ? r.wallet : shortWallet(r.wallet), code: r.code, machineName: machineDef(r.code)?.name ?? r.code, side: r.side ?? 'long', level: r.level,
  multiplierBps: r.multiplier_bps, priceUsd: usd(r.price_micros), valueUsd: usd(r.value_micros), outcome: r.outcome,
  bonusUsd: usd(r.bonus_micros), floorUsd: usd(r.floor_micros), sellbackUsd: usd(r.sellback_micros),
  card: r.card, settledAt: Number(r.settled_at), links: r.links, vrfUrl: r.memo ? packs.vrfUrl(r.memo) : null, pull: r.pull ?? null,
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
  // Outcomes are from the player's side for both packs and shorts; a short's bonus_micros is its payout.
  const groups = (await db.query<any>(`SELECT side, outcome, COUNT(*)::int AS n, COALESCE(SUM(price_micros),0)::text AS volume, COALESCE(SUM(bonus_micros),0)::text AS bonus,
      COALESCE(SUM(floor_micros),0)::text AS floor, COALESCE(SUM(sellback_micros),0)::text AS sellback, COALESCE(SUM(value_micros),0)::text AS value,
      COALESCE(MAX(bonus_micros),0)::text AS max_bonus, COALESCE(MAX(value_micros),0)::text AS max_value
    FROM settlements WHERE settled_at >= $1 GROUP BY side, outcome`, [since])).rows;
  const where = (side?: string, outcomes?: string[]) => (r: any) => (!side || r.side === side) && (!outcomes || outcomes.includes(r.outcome));
  const sum = (key: string, only = where()) => groups.filter(only).reduce((s, r) => s + n(r[key]), 0);
  const count = (only = where()) => groups.filter(only).reduce((s, r) => s + r.n, 0);
  const kept = ['win', 'push'];
  const top = async (order: string, filter = '') => (await db.query<any>(`SELECT * FROM settlements WHERE settled_at >= $1 ${filter} ORDER BY ${order} DESC, settled_at DESC LIMIT 10`, [since])).rows.map(r => settlementRow(r, packs));
  const configs = await collector.configs();
  const perMachine = (await db.query<any>(`SELECT code, COUNT(*) FILTER (WHERE side='long')::int AS packs, COUNT(*) FILTER (WHERE side='short')::int AS shorts,
      COUNT(*) FILTER (WHERE outcome='win')::int AS wins, COUNT(*) FILTER (WHERE outcome='push')::int AS pushes, COUNT(*) FILTER (WHERE outcome='loss')::int AS losses,
      COALESCE(SUM(price_micros),0)::text AS volume, COALESCE(SUM(bonus_micros) FILTER (WHERE side='long'),0)::text AS bonus,
      COALESCE(SUM(bonus_micros) FILTER (WHERE side='short'),0)::text AS short_payouts, COALESCE(SUM(price_micros) FILTER (WHERE side='short' AND outcome='loss'),0)::text AS short_stakes,
      COALESCE(SUM(sellback_micros),0)::text AS sellback, COALESCE(SUM(floor_micros),0)::text AS floor
    FROM settlements WHERE settled_at >= $1 GROUP BY code`, [since])).rows;
  return {
    period,
    totals: {
      packs: count(where('long')), shorts: count(where('short')), wins: count(where(undefined, ['win'])), pushes: count(where(undefined, ['push'])), losses: count(where(undefined, ['loss'])),
      volumeUsd: usd(sum('volume')), bonusesUsd: usd(sum('bonus', where('long'))), shortPayoutsUsd: usd(sum('bonus', where('short'))),
      floorsUsd: usd(sum('floor')), sellbackUsd: usd(sum('sellback')), shortStakesUsd: usd(sum('volume', where('short', ['loss']))),
      // Packs: bonuses, floors and the cards players kept. Shorts: stakes back and payouts.
      returnedUsd: usd(sum('bonus') + sum('floor') + sum('value', where('long', kept)) + sum('volume', where('short', kept))),
      biggestBonusUsd: usd(Math.max(0, ...groups.map(r => n(r.max_bonus)))), biggestPullUsd: usd(Math.max(0, ...groups.filter(where('long')).map(r => n(r.max_value)))),
    },
    topBonuses: await top('bonus_micros', "AND outcome='win'"),
    topPulls: await top('value_micros', "AND side='long'"),
    machines: MACHINES.map(def => {
      const r = perMachine.find(x => x.code === def.code), volume = n(r?.volume);
      const poolResult = n(r?.sellback) - n(r?.floor) - n(r?.bonus) + n(r?.short_stakes) - n(r?.short_payouts);
      return { code: def.code, name: def.name, image: configs.find(c => c.code === def.code)?.image ?? null, packs: r?.packs ?? 0, shorts: r?.shorts ?? 0,
        wins: r?.wins ?? 0, pushes: r?.pushes ?? 0, losses: r?.losses ?? 0, volumeUsd: usd(volume), bonusesUsd: usd(n(r?.bonus)), shortPayoutsUsd: usd(n(r?.short_payouts)),
        sellbackUsd: usd(n(r?.sellback)), floorsUsd: usd(n(r?.floor)), realizedEdge: volume > 0 ? poolResult / volume : null };
    }),
  };
}
