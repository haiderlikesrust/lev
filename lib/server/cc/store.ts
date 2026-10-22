import type { Card } from './client';
import type { Jobs } from '../jobs';

export type Purchase = {
  id: string; wallet: string; recipient: string; priceUsdc: number; packType?: string; memo?: string; transaction?: string;
  signedTransaction?: string; signature?: string; paid?: boolean; card?: Card;
  /** When the payment was first seen as never landed; confirmed a minute later before giving up. */
  expiredSeenAt?: number;
  /** When the payment was first seen confirmed, and when Collector Crypt was last asked to open the pack while it hadn't registered it. */
  paidAt?: number; nudgedAt?: number;
};

/** A sale of a losing card back to CC, signed by LEV_OPS with the USDC going to LEV_POOL. */
export type Sale = {
  id: string; mint: string; seller: string; recipient: string;
  amountMicros?: number; transaction?: string; signedTransaction?: string; signature?: string; blockhash?: string;
  confirmed?: boolean; attempts?: number; expiredSeenAt?: number;
};

export interface Store<T extends { id: string }> {
  get(id: string): Promise<T | null>;
  save(item: T): Promise<void>;
  locked<R>(id: string, action: () => Promise<R>): Promise<R>;
}
export type PurchaseStore = Store<Purchase>;
export type SaleStore = Store<Sale>;

/**
 * Keeps Collector Crypt purchases and sales in the `jobs` table. One coordinator owns the database
 * (advisory lock), so an in-process lock is enough to stop two steps racing on one order.
 */
class JobStore<T extends { id: string }> implements Store<T> {
  private locks = new Set<string>();
  constructor(readonly jobs: Jobs, readonly prefix: string, readonly kind: string, readonly statusOf: (item: T) => string) {}
  async get(id: string) { return ((await this.jobs.get(`${this.prefix}:${id}`))?.data as T) ?? null; }
  async save(item: T) { await this.jobs.put(`${this.prefix}:${item.id}`, this.kind, this.statusOf(item), item); }
  async locked<R>(id: string, action: () => Promise<R>) {
    if (this.locks.has(id)) throw new Error('This purchase is already being processed.');
    this.locks.add(id);
    try { return await action(); } finally { this.locks.delete(id); }
  }
}

export const purchaseStore = (jobs: Jobs): PurchaseStore =>
  new JobStore<Purchase>(jobs, 'cc', 'cc-purchase', p => p.card ? 'complete' : p.paid ? 'paid' : p.signature ? 'signed' : 'ordered');
export const saleStore = (jobs: Jobs): SaleStore =>
  new JobStore<Sale>(jobs, 'sale', 'cc-sale', s => s.confirmed ? 'complete' : s.signature ? 'signed' : 'ordered');
