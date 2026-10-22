import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { CollectorCrypt, normalizeCard, type Card } from './client';
import type { PurchaseStore } from './store';
import { validatePackPayment } from './pack-policy';

export type PurchaseResult = { state: 'pending'; memo?: string; signature?: string; message: string } | { state: 'complete'; memo: string; signature: string; card: Card };

/**
 * Buys and opens one CC pack with `signer` (LEV_OPS), which receives the card. Ported from Pullback
 * (server/cc/purchase.ts). Call again with the SAME id to resume; no replacement payment is generated
 * after signing. The memo is saved before anything is signed, so a pull can never be re-assigned to another order.
 */
export async function buyPack(options: {
  id: string; priceUsdc: number; packType: string; maxPriceUsdc: number; enabled: boolean; usdcMint: PublicKey;
  client: CollectorCrypt; connection: Connection; signer: Keypair; paymentWallet: PublicKey; store: PurchaseStore;
}): Promise<PurchaseResult> {
  const { id, priceUsdc, packType, maxPriceUsdc, client, connection, signer, paymentWallet, store, usdcMint } = options;
  if (!options.enabled) throw new Error('Purchases are disabled.');
  if (!Number.isSafeInteger(priceUsdc) || priceUsdc <= 0 || !Number.isSafeInteger(maxPriceUsdc) || priceUsdc > maxPriceUsdc) throw new Error('Pack exceeds the explicit per-purchase limit.');
  return store.locked(id, async () => {
    let order = await store.get(id);
    if (!order) { order = { id, wallet: signer.publicKey.toBase58(), recipient: paymentWallet.toBase58(), priceUsdc, packType }; await store.save(order); }
    if (order.wallet !== signer.publicKey.toBase58() || order.recipient !== paymentWallet.toBase58() || order.priceUsdc !== priceUsdc || order.packType !== packType) throw new Error('Existing order intent does not match.');
    if (order.card) return { state: 'complete', memo: order.memo!, signature: order.signature!, card: order.card };
    if (!order.memo) { Object.assign(order, await client.generatePack(order.wallet, packType, priceUsdc)); await store.save(order); }
    const pending = (message: string): PurchaseResult => ({ state: 'pending', memo: order!.memo, signature: order!.signature, message });
    if (!order.signedTransaction) {
      const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction!, 'base64'));
      // web3.js 1.99 cannot sign version-1 transactions; nothing is signed, so the order retries or refunds.
      if (tx.version !== 0 && tx.version !== 'legacy') throw new Error('Collector Crypt sent a transaction format this server cannot sign yet; no USDC moved.');
      validatePackPayment(tx, signer.publicKey, paymentWallet, usdcMint, BigInt(priceUsdc) * 1_000_000n, order.memo!);
      if (!(await connection.isBlockhashValid(tx.message.recentBlockhash, { commitment: 'confirmed' })).value) throw new Error('Unsigned order expired. Check its provider status before starting a new order ID.');
      tx.sign([signer]);
      const simulation = await connection.simulateTransaction(tx, { sigVerify: true, commitment: 'confirmed' });
      if (simulation.value.err) throw new Error('Payment simulation failed. Check USDC/SOL funding and the order.');
      order.signedTransaction = Buffer.from(tx.serialize()).toString('base64');
      order.signature = bs58.encode(tx.signatures[0]);
      // Save the exact signed bytes before any network submission; retries reuse this signature.
      await store.save(order);
    }
    if (!order.paid) {
      const status = (await connection.getSignatureStatuses([order.signature!], { searchTransactionHistory: true })).value[0];
      // "no USDC moved" is a contract with the caller: this purchase can be retried or refunded safely.
      const settled = status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized';
      // Only a confirmed failure is final: a "processed" one can still land on another fork.
      if (status?.err && settled) throw new Error('Pack payment failed on-chain; no USDC moved.');
      if (settled) { order.paid = true; await store.save(order); }
      else if (status) return pending('Pack payment is confirming.');
      else {
        const tx = VersionedTransaction.deserialize(Buffer.from(order.signedTransaction, 'base64'));
        if ((await connection.isBlockhashValid(tx.message.recentBlockhash, { commitment: 'confirmed' })).value) {
          // Official flow: submit via Collector Crypt so they register the payment.
          try {
            const submitted = await client.submitTransaction(order.signedTransaction);
            if (submitted.confirmationStatus === 'confirmed' || submitted.confirmationStatus === 'finalized') {
              order.paid = true; await store.save(order);
            } else return pending('Payment submitted. Resume this order to check confirmation.');
          } catch {
            await connection.sendRawTransaction(Buffer.from(order.signedTransaction, 'base64'), { skipPreflight: false, maxRetries: 2 });
            return pending('Payment submitted. Resume this order to check confirmation.');
          }
        } else {
          // The blockhash is dead, so the payment can never land later. Chain history decides what happened.
          const landed = await connection.getTransaction(order.signature!, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' });
          if (landed && !landed.meta) return pending('Waiting for complete transaction history.');
          if (landed?.meta?.err) throw new Error('Pack payment failed on-chain; no USDC moved.');
          if (!landed) {
            // One empty answer can be a lagging node. Look again a minute later before calling it never landed.
            if (!order.expiredSeenAt) { order.expiredSeenAt = Date.now(); await store.save(order); return pending('Checking that the pack payment really expired.'); }
            if (Date.now() - order.expiredSeenAt < 60_000) return pending('Checking that the pack payment really expired.');
            throw new Error('Pack payment expired before landing; no USDC moved.');
          }
          order.paid = true; await store.save(order);
        }
      }
    }
    const status = await client.packStatus(order.memo!);
    if (status.pack?.refunded) throw new Error('Provider refunded this pack. No new payment will be made.');
    if (status.pack?.status !== 'confirmed') {
      // CC normally registers a paid pack within seconds. When it hasn't after 30s, ask it to open the pack, as its
      // own site does right after paying: openPack never buys, it only opens a paid pack (or returns its award).
      const now = Date.now();
      if (!order.paidAt) { order.paidAt = now; await store.save(order); }
      if (now - order.paidAt >= 30_000 && now - (order.nudgedAt ?? 0) >= 60_000) {
        order.nudgedAt = now; await store.save(order);
        await client.openPack(order.memo!).catch(() => null);
      }
      return pending('Waiting for the provider to see the confirmed payment.');
    }
    if (status.pack.wallet !== order.wallet || status.pack.pack_type !== packType || status.pack.transaction_signature !== order.signature) throw new Error('Provider purchase record does not match the saved payment.');
    const opened = await client.openPack(order.memo!);
    if (['WAITING_FOR_WEBHOOK', 'SEND_PENDING'].includes(opened.code)) return pending('Card delivery pending. Resume this same order.');
    if (opened.code === 'TURBO_MODE_BUYBACK' || !opened.nft_address) throw new Error('Unexpected pack result. Inspect provider status.');
    const delivered = await client.packStatus(order.memo!);
    if (delivered.send?.status !== 'confirmed') return pending('Waiting for confirmed NFT delivery.');
    if (delivered.send.nft_address !== opened.nft_address || delivered.send.to_wallet !== order.wallet) throw new Error('Card delivery does not match the purchase wallet.');
    order.card = normalizeCard(opened, delivered); await store.save(order);
    return { state: 'complete', memo: order.memo!, signature: order.signature!, card: order.card };
  });
}
