import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { PublicKey, ComputeBudgetProgram } from '@solana/web3.js';
import { NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { MAX_TX_VERSION, type Chain } from './chain';
import { config } from './config';
import { PendingOperation } from './jobs';
import { PriceImpactTooHigh, quote, swap } from './swap';
import { recordCreatorFees } from './burns';
import type { Settings } from '../shared/settings';

// Ported from Pullback (server/fees.ts). The SDK only loads through require, and only on mainnet.
const pump = () => createRequire(join(process.cwd(), 'package.json'))('@pump-fun/pump-sdk') as typeof import('@pump-fun/pump-sdk');

type Claimable = { quoteMint: string; amount: bigint; creator: string; sharing: boolean; graduated: boolean };

const unfinishedCycle = async (pool: Chain) => (await pool.jobs.db.query("SELECT * FROM jobs WHERE kind='fee-cycle' AND status<>'complete' ORDER BY created_at LIMIT 1")).rows[0];

const PUMP_PROGRAMS = new Set(['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ']);
const SCAN_JOB = 'fee-scan';

/** A creator-fee claim: the fee token came in through a pump.fun program and none of our coin moved, which a sale would. */
export const isClaim = (accounts: string[], feeTokenDelta: bigint, coinDelta: bigint) => feeTokenDelta > 0n && coinDelta === 0n && accounts.some(a => PUMP_PROGRAMS.has(a));

/**
 * Finds claims made outside this app (by hand on pump.fun) and queues each as a fee cycle, which then sells and
 * splits it like our own. Only the claimed amount is touched: other tokens held in this wallet are never sold.
 * The first run starts from now, so earlier history is left alone.
 */
async function findManualClaims(pool: Chain) {
  const { rpc, signer } = pool.require(), { OnlinePumpSdk, normalizeQuoteMint } = pump();
  const sdk = new OnlinePumpSdk(rpc), curve = await sdk.fetchBondingCurve(new PublicKey(config.MEMECOIN_MINT)), quoteMint = normalizeQuoteMint(curve.quoteMint);
  const watched = quoteMint.equals(NATIVE_MINT) ? signer.publicKey : getAssociatedTokenAddressSync(quoteMint, signer.publicKey, false, await sdk.fetchQuoteTokenProgram(quoteMint));
  const scan = await pool.jobs.get(SCAN_JOB), last: string | null = scan?.data.last ?? null;
  const signatures = await rpc.getSignaturesForAddress(watched, { limit: 1_000, ...(last ? { until: last } : {}) }, 'confirmed');
  if (scan) for (const { signature } of signatures.filter(s => !s.err).reverse()) {
    if (await pool.jobs.get(`fees:${signature}`)) continue;
    // Our own claims are saved before they are sent.
    if ((await pool.jobs.db.query("SELECT 1 FROM jobs WHERE kind='fee-claim' AND data->>'signature'=$1", [signature])).rows.length) continue;
    const tx = await rpc.getParsedTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: MAX_TX_VERSION });
    if (!tx) throw new PendingOperation('Waiting for transaction history.');
    const accounts = tx.transaction.message.accountKeys.map(k => k.pubkey.toBase58());
    if (!accounts.some(a => PUMP_PROGRAMS.has(a))) continue;
    const amount = await pool.tokenDelta(signature, quoteMint.toBase58());
    if (isClaim(accounts, amount, await pool.tokenDelta(signature, config.MEMECOIN_MINT))) await pool.jobs.put(`fees:${signature}`, 'fee-cycle', 'routing', { quoteMint: quoteMint.toBase58(), claimSignature: signature, amount: amount.toString(), manual: true });
  }
  await pool.jobs.put(SCAN_JOB, SCAN_JOB, 'ok', { last: signatures[0]?.signature ?? last });
}

/** What LEV_POOL could claim right now, or null. Read-only, so it is safe to call every few seconds. */
async function claimable(pool: Chain): Promise<Claimable | null> {
  const { rpc, signer } = pool.require(), { OnlinePumpSdk, PUMP_SDK, feeSharingConfigPda, normalizeQuoteMint } = pump();
  const mint = new PublicKey(config.MEMECOIN_MINT), sdk = new OnlinePumpSdk(rpc), curve = await sdk.fetchBondingCurve(mint);
  if (curve.isHolderReward) throw new Error('This mint routes fees to holder rewards, not its creator.');
  const quoteMint = normalizeQuoteMint(curve.quoteMint), sharing = curve.creator.equals(feeSharingConfigPda(mint));
  if (!sharing && !curve.creator.equals(signer.publicKey)) throw new Error('LEV_POOL is not this coin’s creator-fee recipient.');
  if (sharing) {
    const info = await rpc.getAccountInfo(curve.creator); if (!info) throw new Error('Fee sharing account is missing.');
    const shared = PUMP_SDK.decodeSharingConfig(info);
    if (!shared.shareholders.some(s => s.address.equals(signer.publicKey))) throw new Error('LEV_POOL is not a fee-sharing shareholder of this coin.');
  }
  const balances = await sdk.getCreatorVaultQuoteBalances(curve.creator), balance = balances.find(b => b.mint.equals(quoteMint));
  if (!balance || balance.total.isZero()) return null;
  return { quoteMint: quoteMint.toBase58(), amount: BigInt(balance.total.toString()), creator: curve.creator.toBase58(), sharing, graduated: curve.complete };
}

/** USDC per smallest unit of the fee mint, from a Jupiter quote. Reused for 30 seconds: the due check runs every second. */
let unitPrice: { mint: string; at: number; usdcPerUnit: number } | null = null;

/** Roughly what `amount` of the fee mint is worth in USDC micros. Only decides whether to claim; the swap quotes afresh. */
export async function usdcValue(mint: string, amount: bigint, now = Date.now(), getQuote = quote) {
  if (mint === config.USDC_MINT) return Number(amount);
  if (!unitPrice || unitPrice.mint !== mint || now - unitPrice.at > 30_000) {
    const out = Number((await getQuote(mint, config.USDC_MINT, amount)).outAmount ?? 0);
    unitPrice = { mint, at: now, usdcPerUnit: out / Number(amount) };
  }
  return Math.floor(Number(amount) * unitPrice.usdcPerUnit);
}

/** True when a claim cycle is unfinished (a claim made by hand starts one), or enough fees have built up to be worth claiming (`creatorFeeMinUsd`). */
export async function creatorFeesDue(pool: Chain, settings: Settings) {
  await findManualClaims(pool);
  if (await unfinishedCycle(pool)) return true;
  const c = await claimable(pool);
  if (!c) return false;
  if (settings.creatorFeeMinUsd <= 0) return true;
  return await usdcValue(c.quoteMint, c.amount) >= settings.creatorFeeMinUsd * 1_000_000;
}

/**
 * Claims our coin's pump.fun creator fees into LEV_POOL, converts them to USDC and splits them (`recordCreatorFees`).
 * Every step is part of one job, so a crash resumes the same claim.
 * The sale is split into parts when one swap would move the price more than `maxPriceImpactBps`.
 * Returns null when there is nothing to claim.
 */
export async function collectCreatorFees(pool: Chain, settings: Settings) {
  const { rpc, signer } = pool.require(), { OnlinePumpSdk, PUMP_SDK } = pump();
  let cycle = await unfinishedCycle(pool);
  if (!cycle) {
    const c = await claimable(pool);
    if (!c) return null;
    const id = `fees:${randomUUID()}`;
    await pool.jobs.put(id, 'fee-cycle', 'claiming', { quoteMint: c.quoteMint, creator: c.creator, sharing: c.sharing, graduated: c.graduated });
    cycle = await pool.jobs.get(id);
  }
  const d = cycle.data, quoteMint = new PublicKey(d.quoteMint), mint = new PublicKey(config.MEMECOIN_MINT), sdk = new OnlinePumpSdk(rpc);
  if (!d.claimSignature) {
    d.claimSignature = await pool.execute(`${cycle.id}:claim`, 'fee-claim', async () => {
      const quoteTokenProgram = await sdk.fetchQuoteTokenProgram(quoteMint);
      const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 350_000 })];
      if (d.sharing) {
        const address = new PublicKey(d.creator), info = await rpc.getAccountInfo(address); if (!info) throw new Error('Sharing configuration is missing.');
        const shared = PUMP_SDK.decodeSharingConfig(info);
        if (d.graduated) ixs.push(await PUMP_SDK.transferCreatorFeesToPumpV2({ payer: signer.publicKey, mint, quoteMint, quoteTokenProgram }));
        ixs.push(await PUMP_SDK.distributeCreatorFeesV2({ mint, sharingConfig: shared, sharingConfigAddress: address, quoteMint, quoteTokenProgram, payer: signer.publicKey, shouldInitializeAta: true }));
      } else {
        if (!quoteMint.equals(NATIVE_MINT)) ixs.push(createAssociatedTokenAccountIdempotentInstruction(signer.publicKey, getAssociatedTokenAddressSync(quoteMint, signer.publicKey, false, quoteTokenProgram), signer.publicKey, quoteMint, quoteTokenProgram));
        ixs.push(...await sdk.collectCoinCreatorFeeV2Instructions(signer.publicKey, quoteMint, quoteTokenProgram, signer.publicKey));
      }
      return pool.build(ixs);
    });
    await pool.jobs.put(cycle.id, 'fee-cycle', 'routing', d);
  }
  if (!d.amount) { const delta = await pool.tokenDelta(d.claimSignature, d.quoteMint); d.amount = (delta > 0n ? delta : 0n).toString(); await pool.jobs.put(cycle.id, 'fee-cycle', 'routing', d); }
  if (BigInt(d.amount) === 0n) { await pool.jobs.put(cycle.id, 'fee-cycle', 'complete', d); return null; }
  // Bonuses are owed in dollars, so the pool keeps USDC rather than a volatile token.
  if (!d.usdcAmount) {
    if (d.quoteMint === config.USDC_MINT) d.usdcAmount = d.amount;
    else {
      d.parts ??= []; d.chunk ??= d.amount;
      const total = BigInt(d.amount), sold = d.parts.reduce((s: bigint, p: { amount: string }) => s + BigInt(p.amount), 0n);
      if (sold < total) {
        const chunk = BigInt(d.chunk), amount = total - sold < chunk ? total - sold : chunk;
        try {
          // The chunk is part of the job id: a part that was signed resumes as itself, a resized part starts fresh.
          const sale = await swap(pool, `${cycle.id}:usdc:${d.parts.length}:${chunk}`, d.quoteMint, config.USDC_MINT, amount, settings.buybackSlippageBps, 1n, settings.maxPriceImpactBps);
          d.parts.push({ amount: amount.toString(), received: sale.received.toString(), signature: sale.signature });
          await pool.jobs.put(cycle.id, 'fee-cycle', 'routing', d);
        } catch (error) {
          if (!(error instanceof PriceImpactTooHigh)) throw error;
          // Halve the part and try again on the next pass; a 32nd of the claim is as small as it gets.
          if (chunk / 2n >= total / 32n && chunk / 2n > 0n) { d.chunk = (chunk / 2n).toString(); await pool.jobs.put(cycle.id, 'fee-cycle', 'routing', d); throw new PendingOperation('Splitting the fee sale to limit price impact.'); }
          throw new PendingOperation('Price impact is too high right now; waiting for more liquidity before selling the claimed fees.');
        }
        if (sold + amount < total) throw new PendingOperation('Selling the rest of the claimed fees.');
      }
      d.usdcAmount = d.parts.reduce((s: bigint, p: { received: string }) => s + BigInt(p.received), 0n).toString();
    }
    await pool.jobs.put(cycle.id, 'fee-cycle', 'accounting', d);
  }
  await recordCreatorFees(pool.jobs.db, settings, { id: cycle.id, usdcMicros: Number(d.usdcAmount), signature: d.claimSignature, from: pool.address! });
  await pool.jobs.put(cycle.id, 'fee-cycle', 'complete', d);
  return { id: cycle.id as string, usdcMicros: Number(d.usdcAmount), signature: d.claimSignature as string };
}
