import { randomUUID } from 'node:crypto';
import { atomic, audit, record, type Database } from './db';
import { PendingOperation, ReviewRequired } from './jobs';
import { httpError, redact } from './redact';
import type { Solana } from './ports';
import type { SettingsStore } from './settings';
import type { LevPool } from './pool';

export type BurnView = { id: string; status: 'pending' | 'done' | 'review'; usdcUsd: number; tokens: string | null; swapSignature: string | null; burnSignature: string | null; createdAt: number; error: string | null };

/**
 * Owner-only. The held share of creator fees (see `indexFeeSplits`) is spent only when the owner clicks
 * "Buy back & burn": LEV_POOL swaps that USDC into our coin on Jupiter and burns it. One at a time,
 * advanced by the worker like an order, so a crash mid-way resumes instead of paying twice.
 */
export class Burns {
  constructor(readonly db: Database, readonly solana: Solana, readonly settings: SettingsStore, readonly pool: LevPool) {}

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
