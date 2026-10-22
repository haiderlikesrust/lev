import type { Database } from './db';
import type { Solana } from './ports';
import type { SettingsStore } from './settings';
import { httpError } from './redact';

const usd = (micros: number) => `$${Math.floor(micros / 1_000_000).toLocaleString('en-US')}`;

/**
 * The leverage pool's USDC (LEV_POOL), separate from Pullback's loss-coverage pool.
 * Free balance = on-chain balance − the bonus caps reserved by packs in progress, so every
 * bonus a pack in progress could win is always payable.
 */
export class LevPool {
  private cache: { micros: number; at: number } | null = null;
  constructor(readonly db: Database, readonly solana: Solana, readonly settings: SettingsStore) {}

  invalidate() { this.cache = null; }
  /** LEV_POOL's on-chain USDC. */
  async usdc() {
    if (this.cache && Date.now() - this.cache.at < 15_000) return this.cache.micros;
    const value = this.solana.poolAddress ? Number(await this.solana.usdcBalance(this.solana.poolAddress)) : 0;
    this.cache = { micros: value, at: Date.now() };
    return value;
  }
  /** Creator-fee USDC sitting in LEV_POOL that is held for the owner's buyback, not pool money. */
  async held() { return Number((await this.db.query<{ total: string }>("SELECT COALESCE(SUM(amount_micros),0)::text AS total FROM ledger WHERE bucket='burn'")).rows[0].total); }
  /** The pool's own money: on-chain USDC minus what is held for the buyback. */
  async balance() { return (await this.usdc()) - (await this.held()); }
  async reserved() { return Number((await this.db.query<{ total: string }>('SELECT COALESCE(SUM(micros),0)::text AS total FROM reservations WHERE released_at IS NULL')).rows[0].total); }
  async free() { return (await this.balance()) - (await this.reserved()); }

  /** Why new packs can't start right now, or null. Packs in progress always settle. */
  async pauseReason(free?: number) {
    const s = this.settings.current;
    if (s.paused) return 'Leverage packs are paused by the team.';
    if ((free ?? await this.free()) < s.pauseThresholdUsd * 1_000_000) return `The pool is below its ${usd(s.pauseThresholdUsd * 1_000_000)} safety line, so new packs are paused until it refills.`;
    return null;
  }

  async health() {
    const [balance, reserved] = [await this.balance(), await this.reserved()], free = balance - reserved, target = this.settings.current.targetReserveUsd * 1_000_000;
    return { balanceMicros: balance, reservedMicros: reserved, freeMicros: free, targetMicros: target, healthBps: Math.max(0, Math.min(10_000, Math.floor(free * 10_000 / target))), pauseReason: await this.pauseReason(free) };
  }

  /** Callers run inside the coordinator's Serial queue, so check-then-insert cannot race. Idempotent per id. */
  async reserve(id: string, amount: number) {
    if (amount <= 0) return;
    if ((await this.db.query('SELECT 1 FROM reservations WHERE id=$1 AND released_at IS NULL', [id])).rows.length) return;
    if ((await this.free()) < amount) throw httpError(409, 'The pool can\'t cover this pack\'s top bonus right now. Nothing was charged.');
    await this.db.query('INSERT INTO reservations(id,micros,created_at) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET micros=EXCLUDED.micros,created_at=EXCLUDED.created_at,released_at=NULL', [id, amount, Date.now()]);
  }
  async release(id: string) { await this.db.query('UPDATE reservations SET released_at=$2 WHERE id=$1 AND released_at IS NULL', [id, Date.now()]); }
}
