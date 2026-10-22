import { PublicKey } from '@solana/web3.js';
import { config } from './config';
import { audit, migrate, openDatabase, record, Serial, type Database } from './db';
import { Jobs } from './jobs';
import { Chain, connection } from './chain';
import { loadSigner } from './signer';
import { LivePacks, LiveSolana } from './live';
import { MockPacks, MockSolana } from './mock';
import { CollectorCrypt } from './cc/client';
import { purchaseStore, saleStore } from './cc/store';
import { SettingsStore } from './settings';
import { LevPool } from './pool';
import { Limits } from './limits';
import { Collector } from './collector';
import { Orders } from './orders';
import { loadCalibration, runCalibration } from './calibration';
import { redact } from './redact';
import type { PackProvider, Solana } from './ports';

export type Services = {
  db: Database; jobs: Jobs; solana: Solana; packs: PackProvider; settings: SettingsStore; pool: LevPool; limits: Limits;
  collector: Collector; orders: Orders; serial: Serial;
  /** Practice mode only: the in-memory chain, for the practice helpers. */
  practice: MockSolana | null;
};

/** Wires everything together. `database` lets tests use an in-memory PGlite. */
export async function createServices(options: { database?: Database; practice?: { solana?: MockSolana; packs?: MockPacks } } = {}): Promise<Services> {
  const db = options.database ?? await openDatabase();
  await migrate(db);
  const jobs = new Jobs(db), settings = new SettingsStore(db);
  await settings.load();
  let solana: Solana, packs: PackProvider, practice: MockSolana | null = null;
  if (config.live) {
    const rpc = connection();
    const ops = new Chain(jobs, loadSigner('LEV_OPS_PRIVATE_KEY', config.LEV_OPS_PRIVATE_KEY), rpc, 'LEV_OPS');
    const poolChain = new Chain(jobs, loadSigner('LEV_POOL_PRIVATE_KEY', config.LEV_POOL_PRIVATE_KEY), rpc, 'LEV_POOL');
    if (ops.address && ops.address === poolChain.address) throw new Error('LEV_OPS and LEV_POOL must be different wallets.');
    new PublicKey(config.COLLECTOR_CRYPT_PAYMENT_WALLET);
    solana = new LiveSolana(ops, poolChain, rpc);
    packs = new LivePacks(new CollectorCrypt(config.COLLECTOR_CRYPT_BASE_URL, config.COLLECTOR_CRYPT_API_KEY), ops, poolChain, purchaseStore(jobs), saleStore(jobs));
  } else {
    practice = options.practice?.solana ?? new MockSolana();
    const mock = options.practice?.packs ?? new MockPacks(practice);
    if (config.practiceLiveData) mock.liveData = new CollectorCrypt(config.COLLECTOR_CRYPT_BASE_URL, config.COLLECTOR_CRYPT_API_KEY);
    solana = practice; packs = mock;
  }
  const pool = new LevPool(db, solana, settings), limits = new Limits(db, settings), collector = new Collector(db, packs);
  const orders = new Orders(db, jobs, solana, packs, pool, limits, settings, collector);
  return { db, jobs, solana, packs, settings, pool, limits, collector, orders, serial: new Serial(), practice };
}

/** First run: machine configs, then pull data (the saved sample in practice mode), then a calibration. */
export async function bootstrap(s: Services) {
  await s.collector.refreshMachines().catch(error => console.error('[collector] machines:', redact((error as Error).message)));
  if (!config.live && !config.practiceLiveData) await s.collector.seedFromSample();
  else await s.collector.poll().catch(() => 0);
  const rows = await loadCalibration(s.db);
  if (!rows.length || Date.now() - Math.min(...rows.map(r => r.computedAt)) > 24 * 3_600_000) await runCalibration(s.db, s.collector, s.settings.current);
}

/** Indexes Pullback's fee-split transfers into LEV_POOL. */
export async function indexFeeSplits(s: Services) {
  const last = (await s.db.query<{ signature: string }>('SELECT signature FROM fee_splits ORDER BY received_at DESC LIMIT 1')).rows[0]?.signature ?? null;
  for (const split of await s.solana.feeSplits(last)) {
    await s.db.query('INSERT INTO fee_splits(signature,amount_micros,cycle,from_wallet,received_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(signature) DO NOTHING', [split.signature, split.amountMicros, split.cycle, split.from, split.receivedAt]);
    await record(s.db, { id: `fee-split:${split.signature}`, bucket: 'pool', kind: 'fee-split', micros: split.amountMicros, signature: split.signature, ref: split.cycle });
    s.pool.invalidate();
  }
}

const KEY = Symbol.for('crypt-leverage.services');
type Global = typeof globalThis & { [KEY]?: Promise<Services>; [key: symbol]: unknown };

/** One coordinator per server process (Next.js dev reloads modules, so it lives on globalThis). */
export function services(): Promise<Services> {
  const g = globalThis as Global;
  g[KEY] ??= createServices().then(async s => { await bootstrap(s); return s; }).catch(error => { delete g[KEY]; throw error; });
  return g[KEY]!;
}

const WORKER = Symbol.for('crypt-leverage.worker');

/**
 * The background worker: advances packs, collects CC pulls, recalibrates daily and indexes fee splits.
 * It runs inside the server process (like Pullback's coordinator), so there is exactly one owner of the
 * database and of every money-moving step. Each loop skips a tick while its previous run is still going.
 */
export async function startWorker() {
  const g = globalThis as Global;
  if (!config.workerEnabled || g[WORKER]) return;
  g[WORKER] = true;
  const s = await services();
  const loop = (name: string, everyMs: number, fn: () => Promise<unknown>, serial = false) => {
    let busy = false;
    const tick = async () => {
      if (busy) return; busy = true;
      try { await (serial ? s.serial.run(fn) : fn()); }
      catch (error) { console.error(`[worker:${name}]`, redact((error as Error).message)); await audit(s.db, 'worker-error', { loop: name, error: redact((error as Error).message) }).catch(() => {}); }
      finally { busy = false; }
    };
    setInterval(tick, everyMs).unref?.();
    void tick();
  };
  loop('orders', config.live ? 3_000 : 1_500, () => s.orders.step(), true);
  loop('pulls', 120_000, () => s.collector.poll());
  loop('machines', 600_000, () => s.collector.refreshMachines());
  loop('calibration', 3_600_000, async () => {
    const rows = await loadCalibration(s.db);
    if (!rows.length || Date.now() - Math.min(...rows.map(r => r.computedAt)) > 24 * 3_600_000) await runCalibration(s.db, s.collector, s.settings.current);
  });
  if (config.live) loop('fee-splits', 300_000, () => indexFeeSplits(s));
  console.log(`[worker] started (${config.live ? 'mainnet' : 'practice mode'})`);
}
