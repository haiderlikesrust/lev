import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { config } from './config';
import { buildPayment, validateSignedPayment, type PaymentIntent } from './payment';
import { PendingOperation } from './jobs';
import { loadSample } from './sample';
import type { BuiltPayment, FeeSplit, PackProvider, PaymentState, PurchaseResult, SaleResult, Solana } from './ports';
import type { Card, CollectorCrypt, FeedPull } from './cc/client';
import { tierOf } from '../shared/machines';

const fakeSignature = () => bs58.encode(randomBytes(64));
const fakeAddress = () => Keypair.generate().publicKey.toBase58();
/** Where practice pack payments go. */
const CC_WALLET = fakeAddress();

/**
 * Practice-mode Solana: in-memory balances, instant confirmations, no keys or RPC.
 * Ported from Pullback (server/mock.ts), trimmed to what leverage packs use.
 */
export class MockSolana implements Solana {
  readonly live = false;
  canSpend = true;
  readonly opsAddress = fakeAddress();
  readonly poolAddress = fakeAddress();
  readonly usdc = new Map<string, bigint>();
  readonly splits: FeeSplit[] = [];
  private submitted = new Map<string, { signature: string; at: number }>();
  private paid = new Map<string, string>();
  /** Number of status checks before a payment confirms; 0 makes tests deterministic. */
  confirmAfterChecks = 0;
  private checks = new Map<string, number>();

  constructor(poolMicros = 25_000_000_000n) { this.usdc.set(this.poolAddress, poolMicros); }
  async usdcBalance(owner: string) { return this.usdc.get(owner) ?? 0n; }
  move(from: string | null, to: string, amount: bigint) {
    if (from) { const balance = this.usdc.get(from) ?? 0n; if (balance < amount) throw new PendingOperation('Waiting for USDC to cover this payout.'); this.usdc.set(from, balance - amount); }
    this.usdc.set(to, (this.usdc.get(to) ?? 0n) + amount);
  }

  private built = new Map<string, number>();
  /** Unsigned payments expire like a real blockhash would. */
  paymentLifetimeMs = 120_000;
  async buildUserPayment(user: string, micros: number, memo: string): Promise<BuiltPayment> {
    const payment = buildPayment({ user, recipient: this.opsAddress, usdcMint: config.USDC_MINT, micros, memo }, fakeAddress());
    this.built.set(payment.intent.reference, Date.now());
    return payment;
  }
  /** Accepts a real wallet signature (the practice burner wallet signs too), or the literal `practice`. */
  async submitUserPayment(intent: PaymentIntent, signedBase64: string) {
    const signature = signedBase64 === 'practice' ? fakeSignature() : bs58.encode(validateSignedPayment(signedBase64, intent).signatures[0]);
    this.submitted.set(intent.reference, { signature, at: Date.now() });
    return signature;
  }
  async paymentStatus(payment: BuiltPayment, known: string | null): Promise<PaymentState> {
    const sent = this.submitted.get(payment.intent.reference);
    if (!sent || (known && known !== sent.signature)) return Date.now() - (this.built.get(payment.intent.reference) ?? 0) > this.paymentLifetimeMs ? { state: 'expired' } : { state: 'pending' };
    const n = (this.checks.get(sent.signature) ?? 0) + 1; this.checks.set(sent.signature, n);
    if (n <= this.confirmAfterChecks) return { state: 'pending' };
    if (!this.paid.has(sent.signature)) { this.paid.set(sent.signature, payment.intent.user); this.move(null, this.opsAddress, BigInt(payment.intent.micros)); }
    return { state: 'confirmed', signature: sent.signature };
  }

  private done = new Map<string, string>();
  async pay(from: 'ops' | 'pool', jobId: string, to: string, micros: number) {
    const existing = this.done.get(jobId); if (existing) return existing;
    this.move(from === 'ops' ? this.opsAddress : this.poolAddress, to, BigInt(micros));
    const signature = fakeSignature(); this.done.set(jobId, signature); return signature;
  }
  async transferNft(jobId: string) { const existing = this.done.get(jobId); if (existing) return existing; const s = fakeSignature(); this.done.set(jobId, s); return s; }
  /** Practice buyers have plenty unless a test sets their funds. */
  readonly funds = new Map<string, { usdcAccount: boolean; usdcMicros: bigint; lamports: bigint }>();
  async walletFunds(owner: string) { return this.funds.get(owner) ?? { usdcAccount: true, usdcMicros: 1_000_000_000_000n, lamports: 1_000_000_000n }; }

  async feeSplits(after: string | null) {
    const index = after ? this.splits.findIndex(s => s.signature === after) : -1;
    return this.splits.slice(index + 1);
  }
  /** Practice helper: a Pullback fee split landing in LEV_POOL. */
  feeSplit(micros: number) {
    this.move(null, this.poolAddress, BigInt(micros));
    const split = { signature: fakeSignature(), amountMicros: micros, cycle: `practice-${this.splits.length + 1}`, from: 'PULLBACK-POOL', receivedAt: Date.now() };
    this.splits.push(split);
    return split;
  }
}

const NAMES = ['Charizard', 'Pikachu', 'Umbreon', 'Mewtwo', 'Gengar', 'Rayquaza', 'Lugia', 'Eevee', 'Blastoise', 'Snorlax', 'Gyarados', 'Dragonite', 'Mew', 'Sylveon', 'Greninja', 'Lucario'];
const SETS = ['Base Set', 'Evolving Skies', 'Hidden Fates', 'Crown Zenith', '151', 'Paldean Fates', 'Lost Origin', 'Celebrations'];

/** Deterministic pseudo-random numbers from a seed string. */
function seeded(seed: string) {
  let state = createHash('sha256').update(seed).digest().readUInt32LE(0) || 1;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return ((state >>> 0) % 1_000_000) / 1_000_000; };
}

/**
 * Practice-mode Collector Crypt: every pack is a real pull drawn from the CC sample, so practice
 * outcomes follow the real distribution. Tests can queue exact values with `forceValues`.
 */
export class MockPacks implements PackProvider {
  private purchases = new Map<string, { calls: number; result?: PurchaseResult }>();
  private sales = new Map<string, { calls: number; result?: SaleResult }>();
  private records = new Map<string, any>();
  /** Calls to `buy` (and `sellBack`) that return pending first, like the real flow. */
  pendingCalls = 1;
  /** Calls to `buy` that fail like a network outage. */
  outageCalls = 0;
  /** Machine codes CC is refusing to sell from ("Machine is low"). */
  readonly machineLow = new Set<string>();
  /** The next pulls' values in USD, used before any random draw. */
  readonly forceValues: number[] = [];
  /** Cards CC no longer buys back. */
  readonly unsellable = new Set<string>();

  /** PRACTICE_LIVE_DATA: real CC machines and pull feed, practice money and packs. */
  liveData: CollectorCrypt | null = null;

  constructor(readonly solana: MockSolana) {}

  async machines() { return this.liveData ? this.liveData.machines() : Object.values(loadSample().machines).map(m => m.config); }
  async openMachines() { return new Set((await this.machines()).map(m => m.code)); }

  private draw(seed: string, code: string) {
    const pulls = loadSample().machines[code]?.pulls ?? [];
    const forced = this.forceValues.shift();
    if (forced !== undefined) return { value: forced, tier: 0 };
    const [value, tier] = pulls[Math.floor(seeded(seed)() * pulls.length)] ?? [0, 0];
    return { value, tier };
  }

  async buy(purchaseId: string, code: string, priceUsd: number): Promise<PurchaseResult> {
    const entry = this.purchases.get(purchaseId) ?? { calls: 0 };
    this.purchases.set(purchaseId, entry);
    if (entry.result) return entry.result;
    if (this.outageCalls > 0) { this.outageCalls--; throw new TypeError('fetch failed'); }
    if (this.machineLow.has(code) && !entry.calls) throw new Error('That pack is not available right now (Collector Crypt: Machine is low).');
    if (entry.calls++ < this.pendingCalls) return { state: 'pending', message: 'Collector Crypt is opening your pack.' };
    this.solana.move(this.solana.opsAddress, CC_WALLET, BigInt(priceUsd) * 1_000_000n);
    const memo = `practice-${randomUUID()}`, signature = fakeSignature(), { value, tier } = this.draw(purchaseId, code), rand = seeded(`card:${purchaseId}`);
    const pick = (list: string[]) => list[Math.floor(rand() * list.length)];
    const card: Card = {
      mint: new PublicKey(createHash('sha256').update(`mint:${purchaseId}`).digest()).toBase58(),
      name: `${pick(NAMES)} · ${pick(SETS)} · PSA ${7 + Math.floor(rand() * 4)}`, image: null, insuredValueUsd: value,
      rarity: tierOf(tier) ?? (value >= priceUsd * 2 ? 'epic' : value >= priceUsd ? 'uncommon' : 'common'), transferSignature: fakeSignature(),
    };
    entry.result = { state: 'complete', memo, signature, card };
    this.records.set(memo, { pack: { status: 'confirmed', wallet: this.solana.opsAddress, pack_type: code, transaction_signature: signature, refunded: false }, send: { status: 'confirmed', nft_address: card.mint, to_wallet: this.solana.opsAddress, insured_value: value } });
    return entry.result;
  }

  async sellBack(saleId: string, mint: string): Promise<SaleResult> {
    const entry = this.sales.get(saleId) ?? { calls: 0 };
    this.sales.set(saleId, entry);
    if (entry.result) return entry.result;
    const record = [...this.records.entries()].find(([, r]) => r.send?.nft_address === mint);
    if (!record || this.unsellable.has(mint)) throw new Error('Collector Crypt will not buy this card back.');
    if (entry.calls++ < this.pendingCalls) return { state: 'pending', message: 'Sale submitted.' };
    const code = record[1].pack.pack_type, buyback = (loadSample().machines[code]?.config.buybackPct ?? 85) / 100;
    const amountMicros = Math.round(Number(record[1].send.insured_value) * buyback * 1_000_000);
    this.solana.move(null, this.solana.poolAddress, BigInt(amountMicros));
    entry.result = { state: 'complete', signature: fakeSignature(), amountMicros };
    return entry.result;
  }

  async status(memo: string) { return this.records.get(memo) ?? { pack: null, send: null }; }

  /** A few fresh pulls per poll, drawn from the sample, so the practice feed and calibration stay live. */
  async recentPulls(code: string): Promise<FeedPull[]> {
    if (this.liveData) return this.liveData.recentPulls(code);
    const pulls = loadSample().machines[code]?.pulls ?? [], now = Date.now();
    return Array.from({ length: 3 }, (_, i) => {
      const [value, tier] = pulls[Math.floor(Math.random() * pulls.length)] ?? [0, 0];
      return { id: `practice:${randomUUID()}`, code, valueMicros: Math.round(value * 1_000_000), tier, slug: 'practice', pulledAt: now - i * 1000 };
    });
  }
  async pullHistory(slug: string, cursor: string | null) { return this.liveData ? this.liveData.pullHistory(slug, cursor) : { pulls: [], nextCursor: null, hasMore: false }; }
  vrfUrl() { return null; }
}
