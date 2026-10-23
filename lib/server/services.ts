import { PublicKey } from '@solana/web3.js';
import { config } from './config';
import { atomic, audit, migrate, openDatabase, record, Serial, type Database } from './db';
import { Burns } from './burns';
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
import { loadCalibration, loadShortCalibration, runCalibration } from './calibration';
import { httpError, redact } from './redact';
import type { PackProvider, Solana } from './ports';

export type Services = {
  db: Database; jobs: Jobs; solana: Solana; packs: PackProvider; settings: SettingsStore; pool: LevPool; limits: Limits;
  collector: Collector; orders: Orders; burns: Burns; serial: Serial;
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
  // Practice pulls arrive every few seconds and nobody can see them early, so practice shorts settle fast.
  if (!config.live) orders.shortTiming = { guardMs: 2_000, lagMs: 1_500, pollMs: 1_500 };
  return { db, jobs, solana, packs, settings, pool, limits, collector, orders, burns: new Burns(db, solana, settings, pool), serial: new Serial(), practice };
}

/** First run: machine configs, then pull data (the saved sample in practice mode), then a calibration. */
export async function bootstrap(s: Services) {
  await s.collector.refreshMachines().catch(error => console.error('[collector] machines:', redact((error as Error).message)));
  if (!config.live && !config.practiceLiveData) await s.collector.seedFromSample();
  else await s.collector.poll().catch(() => 0);
  const rows = await loadCalibration(s.db);
  if (!rows.length || !(await loadShortCalibration(s.db)).length || Date.now() - Math.min(...rows.map(r => r.computedAt)) > 24 * 3_600_000) await runCalibration(s.db, s.collector, s.settings.current);
}

/**
 * Indexes creator-fee USDC arriving in LEV_POOL and splits it on arrival: `feePoolShareBps` becomes pool
 * money, the rest is held (still in LEV_POOL) for the owner's manual buyback and never funds bonuses.
 */
export async function indexFeeSplits(s: Services) {
  const last = (await s.db.query<{ signature: string }>('SELECT signature FROM fee_splits ORDER BY received_at DESC LIMIT 1')).rows[0]?.signature ?? null;
  for (const split of await s.solana.feeSplits(last)) {
    const poolMicros = Math.floor(split.amountMicros * s.settings.current.feePoolShareBps / 10_000), heldMicros = split.amountMicros - poolMicros;
    await atomic(s.db, async () => {
      await s.db.query('INSERT INTO fee_splits(signature,amount_micros,pool_micros,cycle,from_wallet,received_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(signature) DO NOTHING', [split.signature, split.amountMicros, poolMicros, split.cycle, split.from, split.receivedAt]);
      await record(s.db, { id: `fee-split:${split.signature}`, bucket: 'pool', kind: 'fee-split', micros: poolMicros, signature: split.signature, ref: split.cycle });
      if (heldMicros > 0) await record(s.db, { id: `fee-held:${split.signature}`, bucket: 'burn', kind: 'fee-held', micros: heldMicros, signature: split.signature, ref: split.cycle });
    });
    s.pool.invalidate();
  }
}

/**
 * One coordinator per server process (Next.js dev reloads modules, so it lives on globalThis).
 * During an update the new server is a `standby` until the old one stops and releases the database lock.
 */
type Coordinator = {
  state: 'connecting' | 'standby' | 'starting' | 'active' | 'stopping' | 'failed';
  services: Promise<Services> | null;
  active: Services | null;
  /** The first-run work; in the background when the database already has data. */
  ready: Promise<void>;
  worker: boolean;
  timers: NodeJS.Timeout[];
  ticks: Set<Promise<void>>;
  /** API requests in progress, which a shutdown lets finish. */
  requests: number;
};

const KEY = Symbol.for('crypt-leverage.coordinator');
type Global = typeof globalThis & { [KEY]?: Coordinator };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function coordinator(): Coordinator {
  return (globalThis as Global)[KEY] ??= { state: 'connecting', services: null, active: null, ready: Promise.resolve(), worker: false, timers: [], ticks: new Set(), requests: 0 };
}

export const coordinatorState = () => coordinator().state;

export function services(): Promise<Services> {
  const c = coordinator();
  if (c.state === 'stopping') return Promise.reject(httpError(503, 'The server is restarting. Try again in a moment.'));
  c.services ??= start(c).catch(error => {
    c.services = null; c.state = 'failed';
    console.error('[coordinator] failed to start:', redact((error as Error).message));
    throw error;
  });
  return c.services;
}

async function start(c: Coordinator) {
  c.state = 'connecting';
  const database = await openDatabase(undefined, undefined, () => { c.state = 'standby'; console.log('[coordinator] standby: waiting for the running server to hand over the database'); });
  try {
    c.state = 'starting';
    const s = await createServices({ database });
    // A new database needs pull data and a calibration before it can quote. One that has them (every
    // update after the first deploy) serves at once and refreshes in the background.
    const warm = (await loadCalibration(s.db)).length > 0;
    const boot = bootstrap(s);
    if (!warm) await boot;
    c.ready = boot.catch(error => console.error('[coordinator] bootstrap:', redact((error as Error).message)));
    c.active = s; c.state = 'active';
    console.log('[coordinator] active');
    if (config.workerEnabled) void c.ready.then(() => startWorker(c, s));
    return s;
  } catch (error) { await database.close().catch(() => {}); throw error; }
}

/** For API requests: waits for the coordinator (seconds while a standby takes over) and counts the request so a shutdown lets it finish. */
export async function withServices<T>(fn: (s: Services) => Promise<T>, waitMs = 25_000): Promise<T> {
  const c = coordinator();
  c.requests++;
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(httpError(503, 'The server is starting up. Try again in a moment.')), waitMs); });
    return await fn(await Promise.race([services(), timeout]));
  } finally { clearTimeout(timer); c.requests--; }
}

/**
 * Stops for an update: no new worker steps, then running steps and requests get up to `graceMs` to
 * finish (every money step also resumes from the database), then the database closes so Postgres
 * releases the lock and the new server takes over at once.
 */
export async function stopCoordinator(graceMs = 8_000) {
  const c = coordinator();
  if (c.state === 'stopping') return;
  const s = c.active;
  c.state = 'stopping';
  for (const timer of c.timers) clearInterval(timer);
  // A standby, or a server still starting, owns nothing yet; exiting drops its connection.
  if (!s) return;
  const drained = (async () => {
    await Promise.all(c.ticks);
    await s.serial.idle();
    while (c.requests > 0) await sleep(50);
  })();
  await Promise.race([drained, sleep(graceMs)]);
  await s.db.close().catch(() => {});
}

/** The Docker image sets NEXT_MANUAL_SIG_HANDLE, so stopping is ours: finish, hand the database over, exit. */
export function stopOnSignals() {
  if (!process.env.NEXT_MANUAL_SIG_HANDLE) return;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void stopCoordinator().finally(() => process.exit(0)); });
}

/**
 * The background worker: advances packs, collects CC pulls, recalibrates daily and indexes fee splits.
 * It runs inside the server process (like Pullback's coordinator), so there is exactly one owner of the
 * database and of every money-moving step. Each loop skips a tick while its previous run is still going.
 * It starts when the coordinator becomes active.
 */
function startWorker(c: Coordinator, s: Services) {
  if (c.worker || c.state === 'stopping') return;
  c.worker = true;
  const loop = (name: string, everyMs: number, fn: () => Promise<unknown>, serial = false) => {
    let busy = false;
    const tick = async () => {
      if (busy || c.state === 'stopping') return; busy = true;
      try { await (serial ? s.serial.run(fn) : fn()); }
      catch (error) { console.error(`[worker:${name}]`, redact((error as Error).message)); await audit(s.db, 'worker-error', { loop: name, error: redact((error as Error).message) }).catch(() => {}); }
      finally { busy = false; }
    };
    const run = () => { const t = tick(); c.ticks.add(t); void t.finally(() => c.ticks.delete(t)); };
    const timer = setInterval(run, everyMs);
    timer.unref?.();
    c.timers.push(timer);
    run();
  };
  loop('orders', config.live ? 3_000 : 1_500, () => s.orders.step(), true);
  loop('burns', 10_000, () => s.burns.step(), true);
  loop('pulls', 120_000, () => s.collector.poll());
  loop('machines', 600_000, () => s.collector.refreshMachines());
  loop('calibration', 3_600_000, async () => {
    const rows = await loadCalibration(s.db);
    if (!rows.length || Date.now() - Math.min(...rows.map(r => r.computedAt)) > 24 * 3_600_000) await runCalibration(s.db, s.collector, s.settings.current);
  });
  if (config.live) loop('fee-splits', 300_000, () => indexFeeSplits(s));
  console.log(`[worker] started (${config.live ? 'mainnet' : 'practice mode'})`);
}
