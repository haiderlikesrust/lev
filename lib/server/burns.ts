import { randomUUID } from 'node:crypto';
import { atomic, audit, record, type Database } from './db';
import { PendingOperation, ReviewRequired } from './jobs';
import { httpError, redact } from './redact';
import type { Solana } from './ports';
import type { SettingsStore } from './settings';
import type { Settings } from '../shared/settings';
import type { LevPool } from './pool';

export type BurnView = { id: string; status: 'pending' | 'done' | 'review'; usdcUsd: number; tokens: string | null; swapSignature: string | null; burnSignature: string | null; createdAt: number; error: string | null };

/**
 * Splits one creator-fee claim: `feePoolShareBps` becomes pool money, the rest is held (still in LEV_POOL) for
 * the owner's manual buyback and never funds bonuses. Idempotent per claim, so a resumed claim can't count twice.
 */
export async function recordCreatorFees(db: Database, settings: Settings, claim: { id: string; usdcMicros: number; signature: string; from: string }) {
  const poolMicros = Math.floor(claim.usdcMicros * settings.feePoolShareBps / 10_000), heldMicros = claim.usdcMicros - poolMicros;
  await atomic(db, async () => {
    await db.query('INSERT INTO fee_splits(signature,amount_micros,pool_micros,cycle,from_wallet,received_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(signature) DO NOTHING', [claim.signature, claim.usdcMicros, poolMicros, claim.id, claim.from, Date.now()]);
    await record(db, { id: `fee-split:${claim.id}`, bucket: 'pool', kind: 'fee-split', micros: poolMicros, signature: claim.signature, ref: claim.id });
    if (heldMicros > 0) await record(db, { id: `fee-held:${claim.id}`, bucket: 'burn', kind: 'fee-held', micros: heldMicros, signature: claim.signature, ref: claim.id });
  });
}

/**
 * Owner-only. The held share of creator fees (see `recordCreatorFees`) is spent only when the owner clicks
 * "Buy back & burn": LEV_POOL swaps that USDC into our coin on Jupiter and burns it. One at a time,
 * advanced by the worker like an order, so a crash mid-way resumes instead of paying twice.
 */
export class Burns {
  constructor(readonly db: Database, readonly solana: Solana, readonly settings: SettingsStore, readonly pool: LevPool) {}

  /** True when fees are worth claiming or selling. Read-only, so it runs outside the coordinator's queue. */
  async feesDue() {
    if (this.settings.current.paused) return false;
    try { return await this.solana.creatorFeesDue(this.settings.current); }
    catch (error) { if (error instanceof PendingOperation) return false; throw error; }
  }

  /** Claims, swaps and splits creator fees. Call from the coordinator's Serial queue; a part-finished claim resumes next time. */
  async collectFees() {
    try { if (await this.solana.collectCreatorFees(this.settings.current)) this.pool.invalidate(); }
    catch (error) { if (!(error instanceof PendingOperation)) throw error; }
  }

  async start(by: string) {
    if ((await this.db.query("SELECT 1 FROM burns WHERE status='pending'")).rows.length) throw httpError(409, 'A buyback is already running.');
    const held = await this.pool.held();
    if (held < 1_000_000) throw httpError(400, 'Less than $1 is held for buybacks.');
    const id = randomUUID(), now = Date.now();
    await this.db.query('INSERT INTO burns(id,status,usdc_micros,started_by,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)', [id, 'pending', held, by, now]);
    await audit(this.db, 'buyback-started', { id, by, usdcMicros: held });
    return id;
  }

  /** Advances the running buyback. Call from the coordinator's Serial queue. */
  async step() {
    for (const row of (await this.db.query<{ id: string; usdc_micros: string }>("SELECT id, usdc_micros::text FROM burns WHERE status='pending'")).rows) {
      const amount = Number(row.usdc_micros);
      try {
        const done = await this.solana.buybackAndBurn(`burn:${row.id}`, amount, this.settings.current.buybackSlippageBps);
        await atomic(this.db, async () => {
          await record(this.db, { id: `burn:${row.id}`, bucket: 'burn', kind: 'buyback', micros: -amount, signature: done.burnSignature, ref: row.id, data: { tokens: done.tokens.toString(), swap: done.swapSignature } });
          await this.db.query("UPDATE burns SET status='done', tokens=$2, swap_signature=$3, burn_signature=$4, updated_at=$5, error=NULL WHERE id=$1", [row.id, done.tokens.toString(), done.swapSignature, done.burnSignature, Date.now()]);
        });
        this.pool.invalidate();
      } catch (error) {
        if (error instanceof PendingOperation) continue;
        const message = redact((error as Error).message);
        await this.db.query(`UPDATE burns SET ${error instanceof ReviewRequired ? "status='review'," : ''} error=$2, updated_at=$3 WHERE id=$1`, [row.id, message, Date.now()]);
      }
    }
  }

  async list(limit = 20): Promise<BurnView[]> {
    return (await this.db.query<any>('SELECT * FROM burns ORDER BY created_at DESC LIMIT $1', [limit])).rows.map(r => ({
      id: r.id, status: r.status, usdcUsd: Number(r.usdc_micros) / 1_000_000, tokens: r.tokens, swapSignature: r.swap_signature, burnSignature: r.burn_signature, createdAt: Number(r.created_at), error: r.error,
    }));
  }
}
