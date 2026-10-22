import type { MachineConfig } from '../shared/machines';
import type { Card, FeedPull } from './cc/client';
import type { PaymentIntent } from './payment';

export type PaymentState = { state: 'confirmed'; signature: string } | { state: 'pending' } | { state: 'failed'; reason: string } | { state: 'expired' };
export type BuiltPayment = { intent: PaymentIntent; transaction: string; blockhash: string };
export type PurchaseResult = { state: 'pending'; message: string; memo?: string; signature?: string } | { state: 'complete'; memo: string; signature: string; card: Card };
export type SaleResult = { state: 'pending'; message: string } | { state: 'complete'; signature: string; amountMicros: number };
export type FeeSplit = { signature: string; amountMicros: number; cycle: string | null; from: string; receivedAt: number };

/** Everything the services need from Solana. `LiveSolana` and `MockSolana` implement it. */
export interface Solana {
  readonly live: boolean;
  /** True only when real money can move end to end (mainnet on, both wallets and RPC set) or in practice mode. */
  readonly canSpend: boolean;
  readonly opsAddress: string | null;
  readonly poolAddress: string | null;
  usdcBalance(owner: string): Promise<bigint>;
  buildUserPayment(user: string, micros: number, memo: string): Promise<BuiltPayment>;
  /** Validates the wallet-signed bytes against the intent, broadcasts, and returns the signature. */
  submitUserPayment(intent: PaymentIntent, signedBase64: string): Promise<string>;
  paymentStatus(payment: BuiltPayment, signature: string | null): Promise<PaymentState>;
  /** Idempotent per job id. Throws PendingOperation until confirmed. */
  pay(from: 'ops' | 'pool', jobId: string, to: string, micros: number): Promise<string>;
  /** LEV_OPS sends a card. Idempotent per job id. */
  transferNft(jobId: string, mint: string, to: string): Promise<string>;
  /** A buyer's USDC and SOL, checked before they are asked to sign. */
  walletFunds(owner: string): Promise<{ usdcAccount: boolean; usdcMicros: bigint; lamports: bigint }>;
  /** USDC that reached LEV_POOL from Pullback's fee split since the newest one we know. */
  feeSplits(after: string | null): Promise<FeeSplit[]>;
}

/** Collector Crypt, or the practice mock. */
export interface PackProvider {
  machines(): Promise<MachineConfig[]>;
  /** Machine codes CC is selling from right now. */
  openMachines(): Promise<Set<string>>;
  /** Resumable and idempotent per purchase id. Buys with LEV_OPS, which receives the card. */
  buy(purchaseId: string, code: string, priceUsd: number): Promise<PurchaseResult>;
  /** Resumable and idempotent per sale id: LEV_OPS sells the card back, the USDC goes to LEV_POOL. */
  sellBack(saleId: string, mint: string): Promise<SaleResult>;
  /** Raw `/pack/status?memo=` response. */
  status(memo: string): Promise<any>;
  /** CC's newest pulls of one machine. */
  recentPulls(code: string): Promise<FeedPull[]>;
  /** CC's pull history under one memo slug, cursor-paged. */
  pullHistory(slug: string, cursor: string | null): Promise<{ pulls: FeedPull[]; nextCursor: string | null; hasMore: boolean }>;
  /** Public VRF proof link for a pack, or null in practice mode. */
  vrfUrl(memo: string): string | null;
}
