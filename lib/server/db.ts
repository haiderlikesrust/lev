import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { mkdir } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from './config';

export interface Database {
  query<T = Record<string, any>>(sql: string, params?: any[]): Promise<{ rows: T[]; command?: string }>;
  close(): Promise<void>;
  /** Runs `fn` in a transaction that unrelated queries cannot slip into (see `gated`). */
  transaction?<T>(fn: () => Promise<T>): Promise<T>;
}

const inTransaction = new AsyncLocalStorage<true>();

/**
 * Everything shares one connection, and BEGIN…COMMIT on a shared connection would absorb any query
 * sent meanwhile by unrelated work (a sign-in, a feed read), which a ROLLBACK would then undo.
 * While a transaction is open, queries from outside it wait at this gate; queries inside it pass.
 */
function gated(raw: Database): Database {
  let gate: Promise<void> = Promise.resolve();
  return {
    query: async (sql, params) => { if (!inTransaction.getStore()) await gate; return raw.query(sql, params); },
    close: () => raw.close(),
    transaction: async fn => {
      let release!: () => void;
      const previous = gate; gate = new Promise(resolve => { release = resolve; });
      await previous;
      try {
        return await inTransaction.run(true, async () => {
          await raw.query('BEGIN');
          try {
            const result = await fn();
            // Postgres answers COMMIT on an aborted transaction with ROLLBACK and no error.
            if ((await raw.query('COMMIT')).command === 'ROLLBACK') throw new Error('The database rolled this transaction back.');
            return result;
          } catch (error) { await raw.query('ROLLBACK').catch(() => {}); throw error; }
        });
      } finally { release(); }
    },
  };
}

export async function openDatabase(url = config.DATABASE_URL, directory = config.PGLITE_DIR): Promise<Database> {
  if (url) {
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 8000, query_timeout: 15000 });
    let connected = false;
    client.on('error', () => { connected = false; });
    await client.connect();
    // One durable coordinator owns every financial transition.
    const lock = await client.query('SELECT pg_try_advisory_lock(713531924) AS acquired');
    if (!lock.rows[0].acquired) { await client.end(); throw new Error('Another coordinator is already running.'); }
    connected = true;
    // A pool can silently reconnect without owning the advisory lock. Stop instead; restart reconciles.
    return gated({
      query: async <T>(sql: string, params?: any[]) => {
        if (!connected) throw new Error('Database coordinator connection lost. Restart to reconcile.');
        const result = await client.query(sql, params);
        return { rows: result.rows as T[], command: result.command };
      },
      close: async () => { connected = false; await client.end(); },
    });
  }
  if (directory !== 'memory://') await mkdir(directory, { recursive: true });
  const database = new PGlite(directory);
  await database.waitReady;
  return gated({ query: async (sql, params) => database.query(sql, params), close: () => database.close() });
}

export async function migrate(db: Database) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS wallets (wallet TEXT PRIMARY KEY, activated_at BIGINT NOT NULL, last_seen_at BIGINT)`,
    `CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, wallet TEXT NOT NULL, message TEXT NOT NULL, expires_at BIGINT NOT NULL, consumed BOOLEAN NOT NULL DEFAULT FALSE)`,
    `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, wallet TEXT NOT NULL REFERENCES wallets(wallet), expires_at BIGINT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), data JSONB NOT NULL)`,
    // One leverage pack. Terms (price, multiplier, floor, cap) are locked when the order is created.
    `CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, wallet TEXT NOT NULL, status TEXT NOT NULL, code TEXT NOT NULL, level TEXT NOT NULL,
       price_micros BIGINT NOT NULL, multiplier_bps INTEGER NOT NULL, floor_bps INTEGER NOT NULL, cap_micros BIGINT NOT NULL,
       payment_signature TEXT UNIQUE, data JSONB NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, error TEXT)`,
    `CREATE INDEX IF NOT EXISTS orders_open ON orders(status) WHERE status NOT IN ('complete','refunded','expired')`,
    `CREATE INDEX IF NOT EXISTS orders_wallet ON orders(wallet, created_at DESC)`,
    // The public settlement log: one row per settled pack.
    `CREATE TABLE IF NOT EXISTS settlements (order_id TEXT PRIMARY KEY, wallet TEXT NOT NULL, code TEXT NOT NULL, level TEXT NOT NULL, outcome TEXT NOT NULL,
       price_micros BIGINT NOT NULL, value_micros BIGINT NOT NULL, multiplier_bps INTEGER NOT NULL, bonus_micros BIGINT NOT NULL DEFAULT 0,
       floor_micros BIGINT NOT NULL DEFAULT 0, sellback_micros BIGINT NOT NULL DEFAULT 0, memo TEXT, card JSONB, links JSONB NOT NULL, settled_at BIGINT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS settlements_time ON settlements(settled_at DESC)`,
    `CREATE INDEX IF NOT EXISTS settlements_wallet ON settlements(wallet, settled_at DESC)`,
    `CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, micros BIGINT NOT NULL, created_at BIGINT NOT NULL, released_at BIGINT)`,
    // Signed amounts: inflows positive, outflows negative. Buckets: pool (LEV_POOL), ops (LEV_OPS), burn (held in LEV_POOL for buybacks).
    `CREATE TABLE IF NOT EXISTS ledger (id TEXT PRIMARY KEY, bucket TEXT NOT NULL, kind TEXT NOT NULL, amount_micros BIGINT NOT NULL, signature TEXT, ref TEXT, created_at BIGINT NOT NULL, data JSONB NOT NULL DEFAULT '{}')`,
    `CREATE INDEX IF NOT EXISTS ledger_time ON ledger(bucket, created_at)`,
    `CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, data JSONB NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, error TEXT)`,
    `CREATE TABLE IF NOT EXISTS audit (id BIGSERIAL PRIMARY KEY, event TEXT NOT NULL, data JSONB NOT NULL, created_at BIGINT NOT NULL)`,
    // CC's public pull feed (getAllWinners / getWinners): the calibration's raw data.
    `CREATE TABLE IF NOT EXISTS cc_pulls (id TEXT PRIMARY KEY, code TEXT NOT NULL, value_micros BIGINT NOT NULL, tier INTEGER, slug TEXT, pulled_at BIGINT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS cc_pulls_recent ON cc_pulls(code, pulled_at DESC)`,
    // Card photo and name, for the leaderboard's biggest pulls.
    `ALTER TABLE cc_pulls ADD COLUMN IF NOT EXISTS image TEXT`,
    `ALTER TABLE cc_pulls ADD COLUMN IF NOT EXISTS name TEXT`,
    `CREATE INDEX IF NOT EXISTS cc_pulls_value ON cc_pulls(pulled_at DESC, value_micros DESC)`,
    // CC's machine configs; `changed_at` moves when odds, tier ranges, buyback or price change, which restarts the calibration window.
    `CREATE TABLE IF NOT EXISTS machine_configs (code TEXT PRIMARY KEY, data JSONB NOT NULL, fingerprint TEXT NOT NULL, fetched_at BIGINT NOT NULL, changed_at BIGINT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS calibration (code TEXT NOT NULL, level TEXT NOT NULL, data JSONB NOT NULL, computed_at BIGINT NOT NULL, PRIMARY KEY(code, level))`,
    // Responsible play: a player's own daily loss limit. Raising it waits 24h; lowering is immediate.
    `CREATE TABLE IF NOT EXISTS player_limits (wallet TEXT PRIMARY KEY, daily_loss_limit_micros BIGINT, pending_limit_micros BIGINT, pending_at BIGINT, opted_in_at BIGINT)`,
    // USDC that reached LEV_POOL from Pullback's fee split (memo `fee-split:<cycle>`).
    `CREATE TABLE IF NOT EXISTS fee_splits (signature TEXT PRIMARY KEY, amount_micros BIGINT NOT NULL, cycle TEXT, from_wallet TEXT NOT NULL, received_at BIGINT NOT NULL)`,
    // The part of each creator-fee transfer that is pool money (the rest is held for the owner's buyback).
    `ALTER TABLE fee_splits ADD COLUMN IF NOT EXISTS pool_micros BIGINT`,
    // Owner-started buybacks of our coin from the held share, advanced by the worker until burned.
    `CREATE TABLE IF NOT EXISTS burns (id TEXT PRIMARY KEY, status TEXT NOT NULL, usdc_micros BIGINT NOT NULL, tokens TEXT, swap_signature TEXT, burn_signature TEXT, started_by TEXT NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, error TEXT)`,
  ];
  for (const statement of statements) await db.query(statement);
}

export class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.pending >= 256) return Promise.reject(Object.assign(new Error('The server is busy. Try again shortly.'), { statusCode: 503 }));
    this.pending++;
    const next = this.tail.then(fn, fn).finally(() => { this.pending--; });
    this.tail = next.catch(() => {});
    return next;
  }
}

export async function atomic<T>(db: Database, fn: () => Promise<T>) {
  // Nested calls are part of the transaction already open.
  if (inTransaction.getStore()) return fn();
  if (db.transaction) return db.transaction(fn);
  await db.query('BEGIN');
  try { const result = await fn(); await db.query('COMMIT'); return result; } catch (error) { await db.query('ROLLBACK'); throw error; }
}

export const audit = (db: Database, event: string, data: unknown) => db.query('INSERT INTO audit(event,data,created_at) VALUES($1,$2,$3)', [event, JSON.stringify(data), Date.now()]);

/** Records a ledger entry once; the id makes every financial event idempotent. */
export const record = (db: Database, entry: { id: string; bucket: 'pool' | 'ops' | 'burn'; kind: string; micros: number; signature?: string | null; ref?: string | null; data?: unknown }) =>
  db.query('INSERT INTO ledger(id,bucket,kind,amount_micros,signature,ref,created_at,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING',
    [entry.id, entry.bucket, entry.kind, Math.trunc(entry.micros), entry.signature ?? null, entry.ref ?? null, Date.now(), JSON.stringify(entry.data ?? {})]);

export async function sum(db: Database, where: string, params: any[] = []) {
  const row = (await db.query<{ total: string }>(`SELECT COALESCE(SUM(amount_micros),0)::text AS total FROM ledger WHERE ${where}`, params)).rows[0];
  return Number(row.total);
}
