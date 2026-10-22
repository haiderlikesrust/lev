import { PublicKey, type Connection, type ParsedTransactionWithMeta } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import bs58 from 'bs58';
import { config } from './config';
import { MAX_TX_VERSION, type Chain } from './chain';
import { buildPayment, validatePaymentMessage, validateSignedPayment, type PaymentIntent } from './payment';
import { CollectorCrypt, vrfVerifyUrl } from './cc/client';
import { buyPack } from './cc/purchase';
import { sellBack } from './cc/sellback';
import type { PurchaseStore, SaleStore } from './cc/store';
import type { BuiltPayment, FeeSplit, PackProvider, PaymentState, Solana } from './ports';
import type { MachineConfig } from '../shared/machines';
import { swap } from './swap';
import { ReviewRequired } from './jobs';

/** Turns a failed payment broadcast into one plain sentence; the raw RPC message is kept as `cause` for the logs. */
export function paymentFailure(message: string) {
  if (/debit an account but found no record|insufficient lamports|InsufficientFundsForFee|insufficient funds for fee/i.test(message)) return 'This wallet needs a little SOL (0.002 is plenty) to pay the Solana network fee. Nothing was charged.';
  if (/insufficient funds|0x1\b/i.test(message)) return 'This wallet does not have enough USDC for this pack. Nothing was charged.';
  if (/invalid account data|could not find account|AccountNotFound|0x3\b/i.test(message)) return 'This wallet has no USDC yet. Add USDC to it and try again. Nothing was charged.';
  if (/blockhash not found|block height exceeded|expired/i.test(message)) return 'The payment took too long to approve. Please try again. Nothing was charged.';
  return 'The payment could not be sent. Please try again. Nothing was charged.';
}

const FEE_SPLIT_MEMO = /^fee-split:([A-Za-z0-9_.:-]{1,80})$/;

/** Finds a USDC transfer from Pullback's POOL into LEV_POOL tagged `fee-split:<cycle>`. */
export function parseFeeSplit(tx: ParsedTransactionWithMeta | null, from: string, poolAta: string): FeeSplit | null {
  if (!tx?.meta || tx.meta.err || !tx.blockTime) return null;
  let amount = 0n, cycle: string | null = null;
  for (const ix of tx.transaction.message.instructions) {
    if (!('parsed' in ix)) continue;
    if (ix.program === 'spl-memo' && typeof ix.parsed === 'string') cycle = FEE_SPLIT_MEMO.exec(ix.parsed)?.[1] ?? cycle;
    if (ix.program === 'spl-token' && (ix.parsed?.type === 'transfer' || ix.parsed?.type === 'transferChecked')) {
      const info = ix.parsed.info;
      if (info.destination === poolAta && (info.authority ?? info.multisigAuthority) === from) amount += BigInt(info.tokenAmount?.amount ?? info.amount);
    }
  }
  if (!cycle || amount <= 0n) return null;
  return { signature: tx.transaction.signatures[0], amountMicros: Number(amount), cycle, from, receivedAt: tx.blockTime * 1000 };
}

/** Mainnet adapter: LEV_OPS and LEV_POOL are separate signing wallets sharing one RPC. */
export class LiveSolana implements Solana {
  readonly live = config.live;
  constructor(readonly ops: Chain, readonly pool: Chain, readonly rpc: Connection | null) {}
  /** Read-only until mainnet is enabled with both signers and an RPC: no payment is accepted before that. */
  get canSpend() { return config.live && !!this.rpc && !!this.ops.signer && !!this.pool.signer; }
  get opsAddress() { return this.ops.address; }
  get poolAddress() { return this.pool.address; }
  private requireRpc() { if (!this.rpc) throw new Error('Configure SOLANA_RPC_URL.'); return this.rpc; }
  usdcBalance(owner: string) { return this.ops.balance(config.USDC_MINT, owner); }

  async buildUserPayment(user: string, micros: number, memo: string): Promise<BuiltPayment> {
    if (!this.opsAddress) throw new Error('The LEV_OPS wallet is not configured.');
    const block = await this.requireRpc().getLatestBlockhash('confirmed');
    return buildPayment({ user, recipient: this.opsAddress, usdcMint: config.USDC_MINT, micros, memo }, block.blockhash);
  }

  async submitUserPayment(intent: PaymentIntent, signedBase64: string) {
    const tx = validateSignedPayment(signedBase64, intent);
    try { await this.requireRpc().sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 }); }
    catch (error) {
      const message = (error as Error).message;
      // The wallet broadcast it too: the payment is on its way, not failed.
      if (/already been processed/i.test(message)) return bs58.encode(tx.signatures[0]);
      throw Object.assign(new Error(paymentFailure(message), { cause: message }), { statusCode: 400 });
    }
    return bs58.encode(tx.signatures[0]);
  }

  /** Finds a payment the wallet broadcast itself, by its unique reference key. */
  private async findByReference(intent: PaymentIntent) {
    const rpc = this.requireRpc();
    const signatures = await rpc.getSignaturesForAddress(new PublicKey(intent.reference), { limit: 25 }, 'confirmed');
    for (const s of signatures) {
      if (s.err || (s.memo && !s.memo.includes(intent.memo))) continue;
      let tx;
      try { tx = await rpc.getTransaction(s.signature, { maxSupportedTransactionVersion: MAX_TX_VERSION, commitment: 'confirmed' }); } catch { continue; }
      if (!tx?.meta || tx.meta.err) continue;
      try { validatePaymentMessage(tx.transaction.message, intent); return s.signature; } catch { /* a look-alike, not our payment */ }
    }
    return null;
  }

  async paymentStatus(payment: BuiltPayment, known: string | null): Promise<PaymentState> {
    const rpc = this.requireRpc();
    const signature = known ?? await this.findByReference(payment.intent);
    if (signature) {
      const status = (await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
      if (status?.err) return { state: 'failed', reason: JSON.stringify(status.err) };
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return { state: 'confirmed', signature };
      if (status) return { state: 'pending' };
    }
    if ((await rpc.isBlockhashValid(payment.blockhash, { commitment: 'confirmed' })).value) return { state: 'pending' };
    // The blockhash is dead, so the payment can never land. Check history once more before expiring.
    const late = signature ? await rpc.getTransaction(signature, { maxSupportedTransactionVersion: MAX_TX_VERSION, commitment: 'confirmed' }) : null;
    if (late?.meta && !late.meta.err) return { state: 'confirmed', signature: signature! };
    if (!known && await this.findByReference(payment.intent)) return { state: 'pending' };
    return { state: 'expired' };
  }

  pay(from: 'ops' | 'pool', jobId: string, to: string, micros: number) { return (from === 'ops' ? this.ops : this.pool).payUsdc(jobId, to, BigInt(micros)); }
  transferNft(jobId: string, mint: string, to: string) { return this.ops.transferNft(jobId, mint, to); }

  async walletFunds(owner: string) {
    const rpc = this.requireRpc(), key = new PublicKey(owner), ata = getAssociatedTokenAddressSync(new PublicKey(config.USDC_MINT), key, true);
    const [account, lamports] = await Promise.all([rpc.getParsedAccountInfo(ata, 'confirmed'), rpc.getBalance(key, 'confirmed')]);
    const parsed = (account.value?.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } } | undefined)?.parsed;
    return { usdcAccount: !!account.value, usdcMicros: BigInt(parsed?.info?.tokenAmount?.amount ?? 0), lamports: BigInt(lamports) };
  }

  async feeSplits(after: string | null) {
    if (!this.rpc || !this.poolAddress || !config.FEE_SOURCE_WALLET) return [];
    const poolAta = getAssociatedTokenAddressSync(new PublicKey(config.USDC_MINT), new PublicKey(this.poolAddress)).toBase58();
    const signatures = (await this.rpc.getSignaturesForAddress(new PublicKey(poolAta), { limit: 100, ...(after ? { until: after } : {}) }, 'confirmed')).filter(s => !s.err);
    const found: FeeSplit[] = [];
    for (let i = 0; i < signatures.length; i += 20) {
      const txs = await this.rpc.getParsedTransactions(signatures.slice(i, i + 20).map(s => s.signature), { maxSupportedTransactionVersion: MAX_TX_VERSION, commitment: 'confirmed' });
      for (const tx of txs) { const split = parseFeeSplit(tx, config.FEE_SOURCE_WALLET, poolAta); if (split) found.push(split); }
    }
    return found;
  }

  async buybackAndBurn(jobId: string, usdcMicros: number, slippageBps: number) {
    if (!config.MEMECOIN_MINT) throw new ReviewRequired('Set MEMECOIN_MINT before buying back.');
    const bought = await swap(this.pool, `${jobId}:swap`, config.USDC_MINT, config.MEMECOIN_MINT, BigInt(usdcMicros), slippageBps);
    const burnSignature = await this.pool.burn(`${jobId}:burn`, config.MEMECOIN_MINT, bought.received);
    return { tokens: bought.received, swapSignature: bought.signature, burnSignature };
  }
}

/** Collector Crypt for real: LEV_OPS buys, opens and sells back; LEV_POOL receives sellbacks. */
export class LivePacks implements PackProvider {
  private machineCache: { at: number; value: MachineConfig[] } | null = null;
  private openCache: { at: number; value: Set<string> } | null = null;
  constructor(readonly client: CollectorCrypt, readonly ops: Chain, readonly pool: Chain, readonly purchases: PurchaseStore, readonly sales: SaleStore) {}

  async machines() {
    if (this.machineCache && Date.now() - this.machineCache.at < 60_000) return this.machineCache.value;
    const value = await this.client.machines();
    this.machineCache = { at: Date.now(), value };
    return value;
  }
  async openMachines() {
    if (this.openCache && Date.now() - this.openCache.at < 30_000) return this.openCache.value;
    const value = await this.client.openMachines();
    this.openCache = { at: Date.now(), value };
    return value;
  }

  buy(purchaseId: string, code: string, priceUsd: number) {
    const { rpc, signer } = this.ops.require();
    return buyPack({ id: purchaseId, priceUsdc: priceUsd, packType: code, maxPriceUsdc: 1_000, enabled: config.live, usdcMint: new PublicKey(config.USDC_MINT),
      client: this.client, connection: rpc, signer, paymentWallet: new PublicKey(config.COLLECTOR_CRYPT_PAYMENT_WALLET), store: this.purchases });
  }
  sellBack(saleId: string, mint: string) {
    const { rpc, signer } = this.ops.require();
    if (!this.pool.address) throw new Error('The LEV_POOL wallet is not configured.');
    return sellBack({ id: saleId, mint, client: this.client, connection: rpc, signer, recipient: new PublicKey(this.pool.address), usdcMint: new PublicKey(config.USDC_MINT), store: this.sales });
  }
  status(memo: string) { return this.client.packStatus(memo); }
  recentPulls(code: string) { return this.client.recentPulls(code); }
  pullHistory(slug: string, cursor: string | null) { return this.client.pullHistory(slug, cursor); }
  vrfUrl(memo: string) { return vrfVerifyUrl(this.client.baseUrl, memo); }
}
