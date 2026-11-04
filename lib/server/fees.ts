import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { PublicKey, ComputeBudgetProgram } from '@solana/web3.js';
import { NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import type { Chain } from './chain';
import { config } from './config';
import { PendingOperation } from './jobs';
import { PriceImpactTooHigh, quote, swap } from './swap';
import { recordCreatorFees } from './burns';
import type { Settings } from '../shared/settings';

// Ported from Pullback (server/fees.ts). The SDK only loads through require, and only on mainnet.
const pump = () => createRequire(join(process.cwd(), 'package.json'))('@pump-fun/pump-sdk') as typeof import('@pump-fun/pump-sdk');

type Claimable = { quoteMint: string; amount: bigint; creator: string; sharing: boolean; graduated: boolean };

const unfinishedCycle = async (pool: Chain) => (await pool.jobs.db.query("SELECT * FROM jobs WHERE kind='fee-cycle' AND status<>'complete' ORDER BY created_at LIMIT 1")).rows[0];

/** Any of the fee token in this wallet counts as fees, however it got here (a claim by hand, a transfer). SOL pays network fees and USDC is the pool itself, so they never do. */
const walletFees = async (pool: Chain, mint: string) => mint === NATIVE_MINT.toBase58() || mint === config.USDC_MINT ? 0n : pool.balance(mint);

/** What LEV_POOL could claim right now. Read-only, so it is safe to call every few seconds. */
async function claimable(pool: Chain): Promise<Claimable> {
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
  return { quoteMint: quoteMint.toBase58(), amount: BigInt(balance?.total.toString() ?? 0), creator: curve.creator.toBase58(), sharing, graduated: curve.complete };
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

/** True when a cycle is unfinished, or fees to claim plus fees already in the wallet are worth a cycle (`creatorFeeMinUsd`). */
export async function creatorFeesDue(pool: Chain, settings: Settings) {
  if (await unfinishedCycle(pool)) return true;
  const c = await claimable(pool), total = c.amount + await walletFees(pool, c.quoteMint);
  if (total === 0n) return false;
  if (settings.creatorFeeMinUsd <= 0) return true;
  return await usdcValue(c.quoteMint, total) >= settings.creatorFeeMinUsd * 1_000_000;
}

/**
 * Claims our coin's pump.fun creator fees into LEV_POOL, then converts all of the fee token in the wallet to USDC and
 * splits it (`recordCreatorFees`). Every step is part of one job, so a crash resumes the same cycle.
 * The sale is split into parts when one swap would move the price more than `maxPriceImpactBps`.
 * Returns null when there is nothing to claim or sell.
 */
export async function collectCreatorFees(pool: Chain, settings: Settings) {
  const { rpc, signer } = pool.require(), { OnlinePumpSdk, PUMP_SDK } = pump();
  let cycle = await unfinishedCycle(pool);
  if (!cycle) {
    const c = await claimable(pool);
    if (c.amount === 0n && await walletFees(pool, c.quoteMint) === 0n) return null;
    const id = `fees:${randomUUID()}`;
    await pool.jobs.put(id, 'fee-cycle', 'claiming', { quoteMint: c.quoteMint, creator: c.creator, sharing: c.sharing, graduated: c.graduated, claim: c.amount > 0n });
    cycle = await pool.jobs.get(id);
  }
  const d = cycle.data, quoteMint = new PublicKey(d.quoteMint), mint = new PublicKey(config.MEMECOIN_MINT), sdk = new OnlinePumpSdk(rpc);
  if (d.claim && !d.claimSignature) {
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
  if (!d.amount) {
    // The wallet's whole balance is sold, not only this claim; the claim's own amount covers an RPC that hasn't caught up.
    const inWallet = await walletFees(pool, d.quoteMint), claimed = d.claimSignature ? await pool.tokenDelta(d.claimSignature, d.quoteMint) : 0n, amount = inWallet > claimed ? inWallet : claimed;
    d.amount = (amount > 0n ? amount : 0n).toString(); await pool.jobs.put(cycle.id, 'fee-cycle', 'routing', d);
  }
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
  await recordCreatorFees(pool.jobs.db, settings, { id: cycle.id, usdcMicros: Number(d.usdcAmount), signature: d.claimSignature ?? d.parts[0].signature, from: pool.address! });
  await pool.jobs.put(cycle.id, 'fee-cycle', 'complete', d);
  return { id: cycle.id as string, usdcMicros: Number(d.usdcAmount), signature: (d.claimSignature ?? d.parts[0].signature) as string };
}
