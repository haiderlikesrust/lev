import { randomUUID } from 'node:crypto';
import { atomic, audit, record, type Database } from './db';
import { Jobs, PendingOperation, ReviewRequired } from './jobs';
import { httpError, redact } from './redact';
import { ApiError, type Card } from './cc/client';
import type { BuiltPayment, PackProvider, Solana } from './ports';
import type { LevPool } from './pool';
import type { Limits } from './limits';
import type { SettingsStore } from './settings';
import type { Collector } from './collector';
import { loadCalibration } from './calibration';
import { offer, type Offer } from '../shared/calibration';
import { LEVELS, LEVEL_NAME, bonusMicros, classify, floorRefundMicros, type Level, type Outcome } from '../shared/leverage';
import { machineDef } from '../shared/machines';
import type { OrderStatus, OrderView, SettlementLinks } from '../shared/types';

/** Runs a critical section; the app passes the coordinator's Serial queue, tests run it directly. */
export type Runner = <T>(fn: () => Promise<T>) => Promise<T>;
const direct: Runner = fn => fn();
const PAYMENT_WINDOW_MS = 120_000;
/** Enough SOL for the payment's fee while the wallet stays rent-exempt. */
const BUYER_MIN_LAMPORTS = 1_000_000n;
// Transient failures back off up to 5 minutes, so ~40 attempts ride out a couple of hours of trouble before review.
const MAX_FAILURES = 40;
/** Consecutive CC failures before an order whose pack was never paid is refunded. */
const PROVIDER_FAILURES_BEFORE_REFUND = 7;
/** CC's sellback window is 72 hours; a card still without a value after this goes to a human well inside it. */
const VALUE_WAIT_MS = 6 * 3_600_000;
const backoffMs = (failures: number) => Math.min(300_000, 2_000 * 2 ** Math.min(failures, 8));
const usd = (micros: number) => micros / 1_000_000;
const dollars = (micros: number) => `$${usd(micros).toFixed(2)}`;

/** Network trouble or a provider 5xx/429: worth retrying, not worth a human's attention yet. */
export function isTransient(error: unknown) {
  const e = error as Error & { status?: number };
  if (e instanceof ApiError) return e.status >= 500 || e.status === 429;
  return ['AbortError', 'TimeoutError'].includes(e?.name) || /fetch failed|network|ECONN|ETIMEDOUT|EAI_AGAIN|socket hang up|timed out|already being processed|\b429\b|too many requests|rate.?limit/i.test(e?.message ?? '');
}
const OPEN: OrderStatus[] = ['awaiting_payment', 'paying', 'paid', 'buying', 'settling', 'refunding'];

type OrderData = {
  payment: BuiltPayment; machineName: string; quotedAt: number; expiresAt: number;
  /** When the buyer ticked the HIGH RISK confirmation for this exact pack. */
  acceptedRiskAt: number;
  /** The offer the buyer saw, kept for the record. */
  offer: Pick<Offer, 'edgeBps' | 'poolEdge' | 'playerReturn' | 'normalReturn' | 'pLoss' | 'pPush' | 'pWin'>;
  maxLossMicros: number;
  attempt?: number; purchaseId?: string; memo?: string; packSignature?: string; card?: Card; valueMicros?: number; valueWaitSince?: number;
  outcome?: Outcome; bonusMicros?: number; sellbackMicros?: number; floorMicros?: number;
  sellSignature?: string; floorSignature?: string; nftSignature?: string; bonusSignature?: string;
  refundSignature?: string; refundReason?: string; message?: string | null; failures?: number; retryAt?: number; cancelled?: boolean;
  /** Pack-purchase attempts proven not to have moved USDC (expired or failed on-chain). */
  unpaidAttempts?: number[];
  /** The status an order had when it was handed to review, so Retry resumes exactly there. */
  reviewFrom?: OrderStatus;
};
type Row = {
  id: string; wallet: string; status: OrderStatus; code: string; level: Level; price_micros: string; multiplier_bps: number; floor_bps: number;
  cap_micros: string; payment_signature: string | null; data: OrderData; created_at: string; error: string | null;
};

/**
 * Leverage packs. The buyer pays the pack price to LEV_OPS; LEV_OPS buys and opens the pack on CC and
 * holds the card, so a losing card can never be kept. Then, by the card's insured value:
 *   loss → LEV_OPS sells it back, the USDC lands in LEV_POOL, and a half-risk buyer gets the floor;
 *   push → the card goes to the buyer;
 *   win  → the card goes to the buyer, and LEV_POOL pays the bonus.
 * Structure ported from Pullback (server/orders.ts): every step is resumable and idempotent.
 */
export class Orders {
  constructor(readonly db: Database, readonly jobs: Jobs, readonly solana: Solana, readonly packs: PackProvider, readonly pool: LevPool,
    readonly limits: Limits, readonly settings: SettingsStore, readonly collector: Collector) {}

  /** The live offer for one machine × level, with everything needed to price it. */
  async quote(code: string, level: Level, free?: number) {
    const def = machineDef(code);
    if (!def) throw httpError(404, 'That machine is not offered here.');
    const s = this.settings.current;
    if (!s.levels[level] || s.disabledMachines.includes(code)) throw httpError(409, `${LEVEL_NAME[level]} is not available on this machine right now.`);
    const config = (await this.collector.configs()).find(c => c.code === code);
    const row = (await loadCalibration(this.db)).find(r => r.code === code && r.level === level);
    if (!config || !row) throw httpError(409, 'This machine is still being calibrated.');
    const o = offer(row, { priceMicros: config.priceUsd * 1_000_000, freeMicros: free ?? await this.pool.free(), minValueMicros: config.tierRanges.common.start * 1_000_000, now: Date.now(), settings: s });
    return { def, config, offer: o };
  }

  /**
   * Starts one leverage pack: locks its terms and returns the USDC payment for the wallet to sign.
   * Slow calls (catalog, calibration, wallet funds, blockhash) happen first; only the DB check-and-insert
   * runs inside `run`. No pool money is reserved until the buyer actually pays.
   */
  async create(wallet: string, code: string, level: Level, acceptedRisk: boolean, run: Runner = direct) {
    if (acceptedRisk !== true) throw httpError(400, 'Confirm the HIGH RISK warning for this pack first.');
    if (!LEVELS.includes(level)) throw httpError(400, 'Unknown risk level.');
    if (!this.solana.canSpend) throw httpError(503, 'Leverage packs open at launch. Nothing was charged.');
    const pause = await this.pool.pauseReason();
    if (pause) throw httpError(503, pause);
    const { def, config, offer: first } = await this.quote(code, level);
    if (!first.available) throw httpError(409, first.reason ?? 'This level is not available right now.');
    if (!(await this.packs.openMachines()).has(code)) throw httpError(409, 'Collector Crypt is not selling from this machine right now. Nothing was charged.');
    const price = config.priceUsd * 1_000_000;
    await this.limits.check(wallet, price, first.maxLossMicros);
    const funds = await this.solana.walletFunds(wallet);
    if (!funds.usdcAccount || funds.usdcMicros < BigInt(price)) throw httpError(400, `This pack costs ${dollars(price)} in USDC and this wallet has ${dollars(Number(funds.usdcMicros))}. Add USDC and try again.`);
    if (funds.lamports < BUYER_MIN_LAMPORTS) throw httpError(400, 'This wallet needs a little SOL (0.002 is plenty) to pay the Solana network fee.');
    const id = randomUUID(), payment = await this.solana.buildUserPayment(wallet, price, `lev-${id}`);
    return run(async () => {
      // A cancelled unpaid order no longer blocks a new one; it still settles if a payment lands before it expires.
      const waiting = (await this.db.query("SELECT 1 FROM orders WHERE wallet=$1 AND status IN ('awaiting_payment','paying') AND NOT COALESCE((data->>'cancelled')::boolean, FALSE)", [wallet])).rows[0];
      if (waiting) throw httpError(409, 'Finish or cancel your current pack before starting another.');
      const now = await this.quote(code, level);
      if (!now.offer.available || now.offer.multiplierBps !== first.multiplierBps || now.offer.capMicros < first.capMicros * 0.99) throw httpError(409, 'The terms just changed. Please review them and confirm again.');
      const at = Date.now(), o = first;
      const data: OrderData = {
        payment, machineName: def.name, quotedAt: at, expiresAt: at + PAYMENT_WINDOW_MS, acceptedRiskAt: at, maxLossMicros: o.maxLossMicros,
        offer: { edgeBps: o.edgeBps, poolEdge: o.poolEdge, playerReturn: o.playerReturn, normalReturn: o.normalReturn, pLoss: o.pLoss, pPush: o.pPush, pWin: o.pWin },
      };
      await this.db.query('INSERT INTO orders(id,wallet,status,code,level,price_micros,multiplier_bps,floor_bps,cap_micros,data,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)',
        [id, wallet, 'awaiting_payment', code, level, price, o.multiplierBps, o.floorBps, o.capMicros, JSON.stringify(data), at]);
      await audit(this.db, 'order-created', { id, wallet, code, level, multiplierBps: o.multiplierBps, capMicros: o.capMicros, acceptedRiskAt: at });
      return { order: await this.get(id, wallet), transaction: payment.transaction };
    });
  }

  /** Reserves the pack's largest bonus (refused if the pool can't cover it, before any money moves), then broadcasts the signed payment. */
  async pay(wallet: string, id: string, signed: string, run: Runner = direct) {
    const row = await run(async () => {
      const row = await this.row(id);
      if (!row || row.wallet !== wallet) throw httpError(404, 'Order not found.');
      if (row.status !== 'awaiting_payment') throw httpError(409, 'This pack is no longer waiting for payment.');
      if (Date.now() > row.data.expiresAt) throw httpError(409, 'This pack expired. Start a new one.');
      if (!this.solana.canSpend) throw httpError(503, 'Leverage packs open at launch. Nothing was charged.');
      if (signed === 'practice' && this.solana.live) throw httpError(400, 'Sign the payment with your wallet.');
      await this.pool.reserve(id, Number(row.cap_micros));
      return row;
    });
    // A failed submit may still have been broadcast, so the reservation stays: expiry releases it if no payment lands.
    const signature = await this.solana.submitUserPayment(row.data.payment.intent, signed);
    await run(() => this.db.query("UPDATE orders SET status='paying',payment_signature=$2,updated_at=$3 WHERE id=$1 AND status='awaiting_payment'", [id, signature, Date.now()]));
    return this.get(id, wallet);
  }

  /** The buyer backed out before paying. The order keeps watching for a payment until it expires, but no longer blocks a new one. */
  async cancel(wallet: string, id: string) {
    const row = await this.row(id);
    if (!row || row.wallet !== wallet) throw httpError(404, 'Order not found.');
    if (row.status !== 'awaiting_payment' || row.payment_signature) return this.view(row);
    await this.save(row, row.status, { cancelled: true, message: 'Cancelled. Nothing was charged.' });
    return this.view(row);
  }

  async row(id: string) { return (await this.db.query<Row>('SELECT * FROM orders WHERE id=$1', [id])).rows[0] ?? null; }
  async get(id: string, wallet?: string) {
    const row = await this.row(id);
    if (!row || (wallet && row.wallet !== wallet)) throw httpError(404, 'Order not found.');
    return this.view(row);
  }
  async list(wallet: string, limit = 100) { return Promise.all((await this.db.query<Row>("SELECT * FROM orders WHERE wallet=$1 AND status<>'expired' ORDER BY created_at DESC LIMIT $2", [wallet, limit])).rows.map(r => this.view(r))); }
  async review() { return Promise.all((await this.db.query<Row>("SELECT * FROM orders WHERE status='review' ORDER BY updated_at")).rows.map(async r => ({ ...(await this.view(r)), error: r.error ? redact(r.error) : null }))); }
  async open() { return (await this.db.query<Row>('SELECT * FROM orders WHERE status = ANY($1) ORDER BY created_at', [OPEN])).rows; }

  /** Advances every open order by at most one step. Call from the coordinator's Serial queue. */
  async step() {
    let changed = 0;
    for (const row of await this.open()) {
      const before = row.status;
      if ((row.data.retryAt ?? 0) > Date.now()) continue;
      try { await this.advance(row); }
      catch (error) {
        const e = error as Error, failures = (row.data.failures ?? 0) + 1;
        if (e instanceof PendingOperation) await this.save(row, row.status, { message: e.message, failures: 0, retryAt: 0 });
        else if (e instanceof ReviewRequired || failures >= MAX_FAILURES) { await this.save(row, 'review', { message: e.message, retryAt: 0, reviewFrom: before }, e.message); await audit(this.db, 'order-review', { id: row.id, status: before, error: redact(e.message) }); }
        else {
          const message = e instanceof ApiError ? 'Collector Crypt is not responding right now. Retrying automatically; your payment is safe.' : 'Temporarily delayed. Retrying automatically; your payment is safe.';
          await this.save(row, row.status, { message, failures, retryAt: Date.now() + backoffMs(failures) }, e.message);
          if (failures === 1 || e.message !== row.error) await audit(this.db, 'order-delayed', { id: row.id, status: before, failures, error: redact(e.message) });
        }
      }
      if ((await this.row(row.id))?.status !== before) changed++;
    }
    return changed;
  }

  private async save(row: Row, status: OrderStatus, patch: Partial<OrderData>, error: string | null = null) {
    row.data = { ...row.data, ...patch }; row.status = status;
    await this.db.query('UPDATE orders SET status=$2,data=$3,updated_at=$4,error=$5,payment_signature=COALESCE(payment_signature,$6) WHERE id=$1', [row.id, status, JSON.stringify(row.data), Date.now(), error, row.payment_signature]);
  }

  private async advance(row: Row) {
    const d = row.data, price = Number(row.price_micros);
    switch (row.status) {
      case 'awaiting_payment':
      case 'paying': {
        const state = await this.solana.paymentStatus(d.payment, row.payment_signature);
        if (state.state === 'pending') return;
        if (state.state !== 'confirmed') {
          await this.pool.release(row.id);
          return this.save(row, 'expired', { message: state.state === 'failed' ? 'The payment failed on-chain. Nothing was charged.' : 'The payment window closed. Nothing was charged.' });
        }
        row.payment_signature = state.signature;
        // pay() normally reserved already; a payment the wallet broadcast on its own reserves now if the pool still can.
        // If it can't, the pack is refunded rather than bought with a bonus the pool couldn't pay.
        try { await this.pool.reserve(row.id, Number(row.cap_micros)); }
        catch {
          await record(this.db, { id: `order:${row.id}:payment`, bucket: 'ops', kind: 'payment', micros: price, signature: state.signature, ref: row.id });
          return this.save(row, 'refunding', { refundReason: 'The pool could no longer cover this pack\'s top bonus.' });
        }
        await record(this.db, { id: `order:${row.id}:payment`, bucket: 'ops', kind: 'payment', micros: price, signature: state.signature, ref: row.id });
        return this.save(row, 'paid', { message: 'Payment confirmed. Buying your pack.', failures: 0 });
      }
      case 'paid':
      case 'buying': {
        const attempt = d.attempt ?? 0, purchaseId = `${row.id}-${attempt}`;
        // Record the attempt before any money can move, so review and refund always know to check it.
        if (d.purchaseId !== purchaseId) await this.save(row, row.status, { purchaseId });
        let result;
        try { result = await this.packs.buy(purchaseId, row.code, usd(price)); }
        catch (error) {
          const message = (error as Error).message, signed = !!(await this.jobs.get(`cc:${purchaseId}`))?.data?.signature;
          if (!signed && /Unsigned order expired/.test(message) && attempt < 3) return this.save(row, 'buying', { attempt: attempt + 1, message: 'Refreshing the pack order.' });
          if (/no USDC moved/.test(message)) {
            const unpaidAttempts = [...(d.unpaidAttempts ?? []), attempt];
            return attempt < 3
              ? this.save(row, 'buying', { attempt: attempt + 1, unpaidAttempts, message: 'Retrying the pack purchase.' })
              : this.save(row, 'refunding', { unpaidAttempts, refundReason: 'The pack could not be bought.' });
          }
          if (!signed && /not in the public catalog|not available|Machine is (low|off|empty)|off balance/i.test(message)) return this.save(row, 'refunding', { refundReason: 'Collector Crypt paused this machine, so the pack could not be bought.' });
          if (/refunded/i.test(message)) return this.save(row, 'refunding', { refundReason: 'Collector Crypt refunded the pack.' });
          if (isTransient(error) && (d.failures ?? 0) + 1 >= PROVIDER_FAILURES_BEFORE_REFUND && (await this.sentToProvider(row)) === null) {
            await audit(this.db, 'order-provider-refund', { id: row.id, error: redact(message) });
            return this.save(row, 'refunding', { refundReason: 'Collector Crypt could not sell this pack right now.', failures: 0, retryAt: 0 });
          }
          if (isTransient(error)) throw error;
          throw new ReviewRequired(message);
        }
        if (result.state === 'pending') return this.save(row, 'buying', { purchaseId, message: result.message || 'Collector Crypt is opening your pack.', failures: 0 });
        const value = result.card.insuredValueUsd;
        await record(this.db, { id: `order:${row.id}:pack`, bucket: 'ops', kind: 'pack', micros: -price, signature: result.signature, ref: row.id });
        return this.save(row, 'settling', { purchaseId, memo: result.memo, packSignature: result.signature, card: result.card, valueMicros: value === null ? undefined : Math.round(value * 1_000_000), message: 'Pack opened. Settling.', failures: 0 });
      }
      case 'settling': return this.settle(row);
      case 'refunding': {
        const signature = await this.solana.pay('ops', `order:${row.id}:refund`, row.wallet, price);
        await record(this.db, { id: `order:${row.id}:refund`, bucket: 'ops', kind: 'refund', micros: -price, signature, ref: row.id });
        await this.pool.release(row.id);
        return this.save(row, 'refunded', { refundSignature: signature, message: `${d.refundReason ?? 'The pack could not be completed.'} You were refunded in full.` });
      }
    }
  }

  /** Decides the outcome once from the insured value, then runs its steps; each is idempotent, so retries resume. */
  private async settle(row: Row) {
    let d = row.data;
    const price = Number(row.price_micros);
    if (d.valueMicros === undefined) {
      const value = Number((await this.packs.status(d.memo!))?.send?.insured_value);
      if (!Number.isFinite(value) || value < 0) {
        const since = d.valueWaitSince ?? Date.now();
        if (!d.valueWaitSince) await this.save(row, row.status, { valueWaitSince: since });
        if (Date.now() - since > VALUE_WAIT_MS) throw new ReviewRequired('Collector Crypt has not recorded this card\'s insured value; settle it by hand inside the 72-hour sellback window.');
        throw new PendingOperation('Waiting for Collector Crypt to record the card\'s value.');
      }
      await this.save(row, row.status, { valueMicros: Math.round(value * 1_000_000) });
    }
    if (!row.data.outcome) {
      const outcome = classify(price, row.data.valueMicros!);
      await this.save(row, row.status, { outcome, bonusMicros: outcome === 'win' ? bonusMicros(price, row.data.valueMicros!, row.multiplier_bps, Number(row.cap_micros)) : 0 });
    }
    d = row.data;
    if (d.outcome === 'loss') {
      if (!d.sellSignature) {
        const sale = await this.packs.sellBack(`order-${row.id}`, d.card!.mint);
        if (sale.state === 'pending') throw new PendingOperation(sale.message);
        await record(this.db, { id: `order:${row.id}:sellback`, bucket: 'pool', kind: 'sellback', micros: sale.amountMicros, signature: sale.signature, ref: row.id });
        this.pool.invalidate();
        await this.save(row, row.status, { sellSignature: sale.signature, sellbackMicros: sale.amountMicros, floorMicros: floorRefundMicros(sale.amountMicros, row.floor_bps), message: 'The card was sold back to Collector Crypt.' });
      }
      if (row.data.floorMicros! > 0 && !row.data.floorSignature) {
        const signature = await this.solana.pay('pool', `order:${row.id}:floor`, row.wallet, row.data.floorMicros!);
        await record(this.db, { id: `order:${row.id}:floor`, bucket: 'pool', kind: 'floor', micros: -row.data.floorMicros!, signature, ref: row.id });
        await this.save(row, row.status, { floorSignature: signature });
      }
    } else {
      if (!d.nftSignature) await this.save(row, row.status, { nftSignature: await this.solana.transferNft(`order:${row.id}:nft`, d.card!.mint, row.wallet), message: 'Card sent to your wallet.' });
      if (d.outcome === 'win' && row.data.bonusMicros! > 0 && !row.data.bonusSignature) {
        const signature = await this.solana.pay('pool', `order:${row.id}:bonus`, row.wallet, row.data.bonusMicros!);
        await record(this.db, { id: `order:${row.id}:bonus`, bucket: 'pool', kind: 'bonus', micros: -row.data.bonusMicros!, signature, ref: row.id });
        await this.save(row, row.status, { bonusSignature: signature });
      }
    }
    d = row.data;
    const message = d.outcome === 'loss'
      ? `This card was worth ${dollars(d.valueMicros!)}, below the pack price, so it was sold back to Collector Crypt for ${dollars(d.sellbackMicros!)}.${d.floorMicros ? ` Your half-risk floor of ${dollars(d.floorMicros)} was sent to you.` : ''}`
      : d.outcome === 'push' ? `This card was worth ${dollars(d.valueMicros!)}, about the pack price. It is in your wallet.`
      : `This card was worth ${dollars(d.valueMicros!)}. It is in your wallet, with a ${dollars(d.bonusMicros!)} bonus.`;
    await atomic(this.db, async () => {
      await this.db.query(`INSERT INTO settlements(order_id,wallet,code,level,outcome,price_micros,value_micros,multiplier_bps,bonus_micros,floor_micros,sellback_micros,memo,card,links,settled_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT(order_id) DO NOTHING`,
        [row.id, row.wallet, row.code, row.level, d.outcome, price, d.valueMicros, row.multiplier_bps, d.bonusMicros ?? 0, d.floorMicros ?? 0, d.sellbackMicros ?? 0, d.memo ?? null,
          JSON.stringify(cardView(d.card)), JSON.stringify(links(row)), Date.now()]);
      await this.pool.release(row.id);
      await this.save(row, 'complete', { message });
    });
    this.pool.invalidate();
  }

  /**
   * The attempt whose pack payment to CC was signed (and so may have moved USDC), or null when none was:
   * attempts known to have moved nothing, and packs CC refunded, do not count.
   */
  private async sentToProvider(row: Row) {
    const d = row.data;
    if (/refunded/i.test(row.error ?? '')) return null;
    for (let attempt = 0; attempt <= (d.attempt ?? 0); attempt++) {
      if ((d.unpaidAttempts ?? []).includes(attempt)) continue;
      if ((await this.jobs.get(`cc:${row.id}-${attempt}`))?.data?.signature) return attempt;
    }
    return null;
  }

  /** Owner action: skip the backoff wait so a delayed order is tried again on the next pass. */
  async retryNow(id: string) {
    const row = await this.row(id);
    if (!row || !OPEN.includes(row.status)) throw httpError(409, 'Only packs that are still in progress can be retried.');
    await this.save(row, row.status, { retryAt: 0 }, row.error);
  }

  /** Owner actions for an order in review. Refund only moves money that provably arrived and was not already spent on a pack. */
  async resolve(id: string, action: 'retry' | 'refund') {
    const row = await this.row(id);
    if (!row || row.status !== 'review') throw httpError(409, 'Only packs in review can be resolved.');
    const d = row.data, paid = (await this.db.query('SELECT 1 FROM ledger WHERE id=$1', [`order:${row.id}:payment`])).rows.length > 0;
    if (action === 'refund') {
      if (!paid) throw httpError(409, 'This payment was never confirmed, so there is nothing to refund. Use Retry to re-check it.');
      if (d.card) throw httpError(409, 'The pack was bought; use Retry to finish settling instead of refunding.');
      const sent = await this.sentToProvider(row);
      if (sent !== null) throw httpError(409, `A pack payment was sent to Collector Crypt for this order (attempt ${sent}). Check it on Solscan; use Retry instead of refunding.`);
      return this.save(row, 'refunding', { refundReason: 'The pack could not be completed.', failures: 0, retryAt: 0 });
    }
    const after = (status?: OrderStatus) => status && !['awaiting_payment', 'paying', 'review'].includes(status);
    const resume: OrderStatus = !paid ? (row.payment_signature ? 'paying' : 'awaiting_payment') : after(d.reviewFrom) ? d.reviewFrom! : d.card ? 'settling' : 'buying';
    return this.save(row, resume, { failures: 0, retryAt: 0, message: 'Retrying.' });
  }

  private view(row: Row): OrderView {
    const d = row.data;
    return {
      id: row.id, status: row.status, wallet: row.wallet, code: row.code, machineName: d.machineName, level: row.level,
      priceUsd: usd(Number(row.price_micros)), multiplierBps: row.multiplier_bps, floorBps: row.floor_bps, capUsd: usd(Number(row.cap_micros)), maxLossUsd: usd(d.maxLossMicros),
      playerReturn: d.offer.playerReturn, normalReturn: d.offer.normalReturn, createdAt: Number(row.created_at), expiresAt: d.expiresAt,
      card: cardView(d.card), valueUsd: d.valueMicros === undefined ? null : usd(d.valueMicros),
      // The outcome shows only once settled, so the reveal and the result arrive together.
      outcome: row.status === 'complete' ? d.outcome ?? null : null,
      bonusUsd: usd(d.bonusMicros ?? 0), floorUsd: usd(d.floorMicros ?? 0), sellbackUsd: usd(d.sellbackMicros ?? 0),
      // Review reasons can be internal (RPC or provider errors); the buyer only sees that it is being checked.
      message: row.status === 'review' ? 'This pack needs a manual check. Your payment is safe and the team has been alerted.' : d.message ?? null,
      links: links(row), memo: d.memo ?? null, vrfUrl: d.memo ? this.packs.vrfUrl(d.memo) : null,
    };
  }
}

const cardView = (card: Card | undefined) => card ? { mint: card.mint, name: card.name, image: card.image, rarity: card.rarity } : null;
const links = (row: Row): SettlementLinks => ({
  payment: row.payment_signature, packPayment: row.data.packSignature ?? null, cardDelivery: row.data.card?.transferSignature ?? null,
  sellback: row.data.sellSignature ?? null, floor: row.data.floorSignature ?? null, nftTransfer: row.data.nftSignature ?? null,
  bonus: row.data.bonusSignature ?? null, refund: row.data.refundSignature ?? null,
});
