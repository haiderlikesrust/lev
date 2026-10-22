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
import type { ConfigView, MachineView, OfferView, PoolView, SettlementView } from '../shared/types';

const usd = (micros: number | string) => Number(micros) / 1_000_000;

export const offerView = (o: Offer): OfferView => {
  const { capMicros, maxLossMicros, unlockAtMicros, ...rest } = o;
  return { ...rest, capUsd: usd(capMicros), maxLossUsd: usd(maxLossMicros), unlockAtUsd: usd(unlockAtMicros) };
};

export async function poolView(db: Database, pool: LevPool): Promise<PoolView> {
  const h = await pool.health();
  const counts = (await db.query<{ outcome: string; n: number }>('SELECT outcome, COUNT(*)::int AS n FROM settlements GROUP BY outcome')).rows;
  const n = (outcome: string) => counts.find(c => c.outcome === outcome)?.n ?? 0;
  const splits = (await db.query<{ signature: string; amount_micros: string; cycle: string | null; received_at: string }>('SELECT signature, amount_micros::text, cycle, received_at::text FROM fee_splits ORDER BY received_at DESC LIMIT 20')).rows;
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
    return [{ code: def.code, name: def.name, priceUsd: c.priceUsd, buybackPct: c.buybackPct, open: open.has(def.code), disabled: s.disabledMachines.includes(def.code),
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

export async function settlementsView(db: Database, packs: PackProvider, options: { wallet?: string; limit?: number; before?: number } = {}): Promise<SettlementView[]> {
  const params: unknown[] = [Math.min(200, options.limit ?? 50)], where: string[] = [];
  if (options.wallet) { params.push(options.wallet); where.push(`wallet=$${params.length}`); }
  if (options.before) { params.push(options.before); where.push(`settled_at < $${params.length}`); }
  const rows = (await db.query<any>(`SELECT * FROM settlements ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY settled_at DESC LIMIT $1`, params)).rows;
  return rows.map(r => ({
    orderId: r.order_id, wallet: options.wallet ? r.wallet : shortWallet(r.wallet), code: r.code, machineName: machineDef(r.code)?.name ?? r.code, level: r.level,
    multiplierBps: r.multiplier_bps, priceUsd: usd(r.price_micros), valueUsd: usd(r.value_micros), outcome: r.outcome,
    bonusUsd: usd(r.bonus_micros), floorUsd: usd(r.floor_micros), sellbackUsd: usd(r.sellback_micros),
    card: r.card, settledAt: Number(r.settled_at), links: r.links, vrfUrl: r.memo ? packs.vrfUrl(r.memo) : null,
  }));
}
