import { Connection, Keypair, PublicKey, VersionedTransaction, type TokenBalance } from '@solana/web3.js';
import { AccountLayout, getAssociatedTokenAddressSync } from '@solana/spl-token';
import bs58 from 'bs58';
import { CollectorCrypt } from './client';
import type { SaleStore } from './store';
import { ReviewRequired } from '../jobs';
import { MAX_TX_VERSION, signableVersion } from '../chain';

export type SaleResult = { state: 'pending'; message: string } | { state: 'complete'; signature: string; amountMicros: number };

/** Most SOL the seller may spend on one sale (network fee plus any rent CC asks for). */
const MAX_SELLER_LAMPORTS = 10_000_000n;

const tokenAmount = (data: Buffer | null | undefined) => data && data.length >= 165 ? AccountLayout.decode(data).amount : 0n;

/** A transaction is known by its first signature: on a sale that is CC's, as fee payer, not the seller's. */
const txId = (signedBase64: string) => bs58.encode(VersionedTransaction.deserialize(Buffer.from(signedBase64, 'base64')).signatures[0]);

/**
 * CC tags its sale of a pack's card `<pack memo>:buyback`. Finds one that already landed in the seller's
 * history, with what it paid the recipient, so a card that is already sold is never offered again.
 */
export async function landedSale(connection: Connection, seller: PublicKey, recipient: PublicKey, usdcMint: PublicKey, memo: string) {
  const owner = recipient.toBase58(), mint = usdcMint.toBase58();
  const total = (rows: TokenBalance[]) => rows.filter(b => b.owner === owner && b.mint === mint).reduce((sum, b) => sum + BigInt(b.uiTokenAmount.amount), 0n);
  for (const s of await connection.getSignaturesForAddress(seller, { limit: 100 }, 'confirmed')) {
    if (s.err || !s.memo?.includes(`${memo}:buyback`)) continue;
    const tx = await connection.getTransaction(s.signature, { maxSupportedTransactionVersion: MAX_TX_VERSION, commitment: 'confirmed' });
    if (!tx?.meta || tx.meta.err) continue;
    const paid = total(tx.meta.postTokenBalances ?? []) - total(tx.meta.preTokenBalances ?? []);
    if (paid > 0n) return { signature: s.signature, amountMicros: Number(paid) };
  }
  return null;
}

/**
 * Checks CC's sale transaction by simulating it: the seller's USDC must not move, its SOL may only pay
 * fees, and the recipient must receive at least the quoted amount. Nothing else of ours is touched.
 * On mainnet CC sends a legacy transaction that it pays for and signs first; LEV_OPS signs second.
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
  /** The pack's CC memo, which CC's sale carries as `<memo>:buyback`. */
  memo?: string;
}): Promise<SaleResult> {
  const { id, mint, client, connection, signer, recipient, usdcMint, store, memo } = options;
  const seller = signer.publicKey.toBase58();
  return store.locked(id, async () => {
    let sale = await store.get(id);
    if (!sale) { sale = { id, mint, seller, recipient: recipient.toBase58() }; await store.save(sale); }
    if (sale.mint !== mint || sale.seller !== seller || sale.recipient !== recipient.toBase58()) throw new Error('Existing sale intent does not match.');
    if (sale.confirmed) return { state: 'complete', signature: sale.signature!, amountMicros: sale.amountMicros! };
    // Sales signed before this was fixed kept the seller's signature, which no status lookup finds.
    if (sale.signedTransaction && sale.signature !== txId(sale.signedTransaction)) { sale.signature = txId(sale.signedTransaction); await store.save(sale); }
    const complete = async (found: { signature: string; amountMicros: number }): Promise<SaleResult> => {
      Object.assign(sale!, { confirmed: true, signature: found.signature, amountMicros: found.amountMicros });
      await store.save(sale!); return { state: 'complete', ...found };
    };
    const findSold = () => memo ? landedSale(connection, signer.publicKey, recipient, usdcMint, memo) : Promise.resolve(null);
    const retry = async (message: string): Promise<SaleResult> => {
      Object.assign(sale!, { transaction: undefined, signedTransaction: undefined, signature: undefined, blockhash: undefined, expiredSeenAt: undefined, attempts: (sale!.attempts ?? 0) + 1 });
      await store.save(sale!); return { state: 'pending', message };
    };
    if (!sale.signedTransaction) {
      const sold = await findSold();
      if (sold) return complete(sold);
      if ((sale.attempts ?? 0) >= 3) throw new ReviewRequired('Selling this card back failed 3 times.');
      const quote = await client.buybackQuote(mint);
      if (!quote.available) throw new ReviewRequired('Collector Crypt will not buy this card back (already sold, or its 72-hour window closed).');
      const offer = await client.buyback(seller, mint, recipient.toBase58());
      const tx = VersionedTransaction.deserialize(Buffer.from(offer.transaction, 'base64'));
      // CC sends its sales as legacy transactions, paid and signed first by CC itself.
      if (!signableVersion(tx)) throw new ReviewRequired('Collector Crypt sent a sale in an unsupported transaction format.');
      await validateSale(connection, tx, signer.publicKey, recipient, usdcMint, offer.amountMicros);
      tx.sign([signer]);
      Object.assign(sale, { amountMicros: offer.amountMicros, transaction: offer.transaction, signedTransaction: Buffer.from(tx.serialize()).toString('base64'), signature: bs58.encode(tx.signatures[0]), blockhash: tx.message.recentBlockhash });
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
    const sold = await findSold();
    if (sold) return complete(sold);
    return retry('The sale expired; asking Collector Crypt for a fresh offer.');
  });
}
