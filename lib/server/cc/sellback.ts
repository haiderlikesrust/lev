import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { AccountLayout, getAssociatedTokenAddressSync } from '@solana/spl-token';
import bs58 from 'bs58';
import { CollectorCrypt } from './client';
import type { SaleStore } from './store';
import { ReviewRequired } from '../jobs';
import { MAX_TX_VERSION } from '../chain';

export type SaleResult = { state: 'pending'; message: string } | { state: 'complete'; signature: string; amountMicros: number };

/** Most SOL the seller may spend on one sale (network fee plus any rent CC asks for). */
const MAX_SELLER_LAMPORTS = 10_000_000n;

const tokenAmount = (data: Buffer | null | undefined) => data && data.length >= 165 ? AccountLayout.decode(data).amount : 0n;

/**
 * Checks CC's sale transaction by simulating it: the seller's USDC must not move, its SOL may only pay
 * fees, and the recipient must receive at least the quoted amount. Nothing else of ours is touched.
 * TODO: confirm the exact shape of CC's buyback transaction on devnet (dev-gacha) before mainnet.
 */
export async function validateSale(rpc: Connection, tx: VersionedTransaction, seller: PublicKey, recipient: PublicKey, usdcMint: PublicKey, amountMicros: number) {
  const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures);
  const sellerIndex = signers.findIndex(k => k.equals(seller));
  if (sellerIndex < 0) throw new ReviewRequired('The sale is not for the LEV_OPS wallet to sign.');
  // Any other required signer must be CC itself, which signs before handing the transaction over.
  if (signers.some((k, i) => i !== sellerIndex && tx.signatures[i].every(b => b === 0))) throw new ReviewRequired('The sale asks for an unexpected signer.');
  const sellerAta = getAssociatedTokenAddressSync(usdcMint, seller), recipientAta = getAssociatedTokenAddressSync(usdcMint, recipient, true);
  const addresses = [seller, sellerAta, recipientAta];
  const before = await rpc.getMultipleAccountsInfo(addresses, 'confirmed');
  const simulation = await rpc.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: addresses.map(a => a.toBase58()) } });
  if (simulation.value.err) throw new Error(`Sale simulation failed: ${JSON.stringify(simulation.value.err)}`);
  const after = simulation.value.accounts;
  if (!after || after.length !== addresses.length) throw new Error('Missing sale simulation results.');
  const data = (i: number) => after[i]?.data?.[0] ? Buffer.from(after[i]!.data[0], 'base64') : null;
  if (BigInt(before[0]?.lamports ?? 0) - BigInt(after[0]?.lamports ?? 0) > MAX_SELLER_LAMPORTS) throw new ReviewRequired('The sale costs more SOL than a network fee.');
  if (tokenAmount(data(1)) < tokenAmount(before[1]?.data)) throw new ReviewRequired('The sale would take USDC from LEV_OPS.');
  if (tokenAmount(data(2)) - tokenAmount(before[2]?.data) < BigInt(amountMicros)) throw new ReviewRequired('The sale pays the pool less than CC quoted.');
}

/**
 * Sells a losing card back to CC: LEV_OPS signs, the USDC goes straight to LEV_POOL (`altRecipient`).
 * Resumable per id, like `buyPack`: the signed bytes are saved before anything is sent. CC's window is
 * 72 hours from the card leaving the gacha, so this runs right after the pull.
 */
export async function sellBack(options: {
  id: string; mint: string; client: CollectorCrypt; connection: Connection; signer: Keypair; recipient: PublicKey; usdcMint: PublicKey; store: SaleStore;
}): Promise<SaleResult> {
  const { id, mint, client, connection, signer, recipient, usdcMint, store } = options;
  const seller = signer.publicKey.toBase58();
  return store.locked(id, async () => {
    let sale = await store.get(id);
    if (!sale) { sale = { id, mint, seller, recipient: recipient.toBase58() }; await store.save(sale); }
    if (sale.mint !== mint || sale.seller !== seller || sale.recipient !== recipient.toBase58()) throw new Error('Existing sale intent does not match.');
    if (sale.confirmed) return { state: 'complete', signature: sale.signature!, amountMicros: sale.amountMicros! };
    const retry = async (message: string): Promise<SaleResult> => {
      Object.assign(sale!, { transaction: undefined, signedTransaction: undefined, signature: undefined, blockhash: undefined, expiredSeenAt: undefined, attempts: (sale!.attempts ?? 0) + 1 });
      await store.save(sale!); return { state: 'pending', message };
    };
    if (!sale.signedTransaction) {
      if ((sale.attempts ?? 0) >= 3) throw new ReviewRequired('Selling this card back failed 3 times.');
      const quote = await client.buybackQuote(mint);
      if (!quote.available) throw new ReviewRequired('Collector Crypt will not buy this card back (already sold, or its 72-hour window closed).');
      const offer = await client.buyback(seller, mint, recipient.toBase58());
      const tx = VersionedTransaction.deserialize(Buffer.from(offer.transaction, 'base64'));
      // CC's submitTransaction takes v0 only.
      if (tx.version !== 0) throw new ReviewRequired('Collector Crypt sent a sale in an unsupported transaction format.');
      await validateSale(connection, tx, signer.publicKey, recipient, usdcMint, offer.amountMicros);
      tx.sign([signer]);
      Object.assign(sale, { amountMicros: offer.amountMicros, transaction: offer.transaction, signedTransaction: Buffer.from(tx.serialize()).toString('base64'), signature: bs58.encode(tx.signatures[tx.message.staticAccountKeys.findIndex(k => k.equals(signer.publicKey))]), blockhash: tx.message.recentBlockhash });
      // Save the exact signed bytes before any network submission.
      await store.save(sale);
    }
    const status = (await connection.getSignatureStatuses([sale.signature!], { searchTransactionHistory: true })).value[0];
    const settled = status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized';
    if (status?.err && settled) return retry('The sale failed on-chain; asking Collector Crypt for a fresh offer.');
    if (settled) { sale.confirmed = true; await store.save(sale); return { state: 'complete', signature: sale.signature!, amountMicros: sale.amountMicros! }; }
    if (status) return { state: 'pending', message: 'The sale is confirming.' };
    if ((await connection.isBlockhashValid(sale.blockhash!, { commitment: 'confirmed' })).value) {
      // Through CC, so it registers the buyback; a raw send is the fallback.
      try { await client.submitTransaction(sale.signedTransaction!); }
      catch { await connection.sendRawTransaction(Buffer.from(sale.signedTransaction!, 'base64'), { skipPreflight: false, maxRetries: 2 }); }
      return { state: 'pending', message: 'Sale submitted.' };
    }
    const landed = await connection.getTransaction(sale.signature!, { maxSupportedTransactionVersion: MAX_TX_VERSION, commitment: 'confirmed' });
    if (landed && !landed.meta) return { state: 'pending', message: 'Waiting for complete transaction history.' };
    if (landed?.meta && !landed.meta.err) { sale.confirmed = true; await store.save(sale); return { state: 'complete', signature: sale.signature!, amountMicros: sale.amountMicros! }; }
    // One empty answer can be a lagging node. Look again a minute later before asking for a new offer.
    if (!sale.expiredSeenAt) { sale.expiredSeenAt = Date.now(); await store.save(sale); return { state: 'pending', message: 'Checking that the sale really expired.' }; }
    if (Date.now() - sale.expiredSeenAt < 60_000) return { state: 'pending', message: 'Checking that the sale really expired.' };
    return retry('The sale expired; asking Collector Crypt for a fresh offer.');
  });
}
