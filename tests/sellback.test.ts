import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction, type Connection } from '@solana/web3.js';
import { AccountLayout } from '@solana/spl-token';
import bs58 from 'bs58';
import { sellBack } from '@/lib/server/cc/sellback';
import type { CollectorCrypt } from '@/lib/server/cc/client';
import type { Sale, SaleStore } from '@/lib/server/cc/store';

const M = 1_000_000;
const cc = Keypair.generate(), seller = Keypair.generate(), pool = Keypair.generate().publicKey, usdcMint = Keypair.generate().publicKey;
const card = Keypair.generate().publicKey.toBase58();

/** CC's sale as it arrives on mainnet: a legacy transaction CC pays for and has already signed; the seller signs second. */
function ccSale() {
  const tx = new Transaction({ feePayer: cc.publicKey, recentBlockhash: '11111111111111111111111111111111' })
    .add(SystemProgram.transfer({ fromPubkey: seller.publicKey, toPubkey: cc.publicKey, lamports: 0 }));
  tx.partialSign(cc);
  return { base64: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'), id: bs58.encode(tx.signatures[0].signature!) };
}

const tokenAccount = (amount: bigint) => {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({ mint: usdcMint, owner: pool, amount, delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
  return data;
};

function store(initial: Sale[] = []): SaleStore & { all: Map<string, Sale> } {
  const all = new Map(initial.map(s => [s.id, s]));
  return { all, get: async id => all.get(id) ?? null, save: async s => { all.set(s.id, { ...s }); }, locked: (_id, action) => action() };
}

/** The chain knows a transaction only by its first signature, as Solana's RPC does. */
function chain(landed: Set<string>, history: { signature: string; memo: string; paid: bigint }[] = []) {
  return {
    getMultipleAccountsInfo: async () => [{ lamports: 1e9, data: Buffer.alloc(0) }, null, null],
    simulateTransaction: async () => ({ value: { err: null, accounts: [{ lamports: 1e9, data: ['', 'base64'] }, null, { lamports: 2e6, data: [tokenAccount(BigInt(M)).toString('base64'), 'base64'] }] } }),
    getSignatureStatuses: async (ids: string[]) => ({ value: ids.map(id => landed.has(id) ? { confirmationStatus: 'confirmed', err: null } : null) }),
    isBlockhashValid: async () => ({ value: true }),
    sendRawTransaction: async () => 'sent',
    getSignaturesForAddress: async () => history.map(h => ({ signature: h.signature, memo: `[47] ${h.memo}`, err: null })),
    getTransaction: async (signature: string) => {
      const h = history.find(x => x.signature === signature);
      const row = (amount: bigint) => [{ accountIndex: 2, mint: usdcMint.toBase58(), owner: pool.toBase58(), uiTokenAmount: { amount: amount.toString(), decimals: 6, uiAmount: null, uiAmountString: '' } }];
      return h ? { meta: { err: null, preTokenBalances: row(5n * BigInt(M)), postTokenBalances: row(5n * BigInt(M) + h.paid) } } : null;
    },
  } as unknown as Connection;
}

const client = (sale: string, calls: string[] = []) => ({
  buybackQuote: async () => { calls.push('quote'); return { available: true, amountMicros: M, expiresAt: null }; },
  buyback: async () => { calls.push('offer'); return { transaction: sale, amountMicros: M, memo: 'cc-pack' }; },
  submitTransaction: async () => { calls.push('submit'); },
}) as unknown as CollectorCrypt;

const options = (s: SaleStore, connection: Connection, c: CollectorCrypt) => ({ id: 'order-1', mint: card, memo: 'cc-pack', client: c, connection, signer: seller, recipient: pool, usdcMint, store: s });

describe('selling a losing card back to Collector Crypt', () => {
  it('signs CC\'s legacy sale and tracks it by its first signature, CC\'s', async () => {
    const sale = ccSale(), s = store();
    const result = await sellBack(options(s, chain(new Set([sale.id])), client(sale.base64)));
    expect(result).toEqual({ state: 'complete', signature: sale.id, amountMicros: M });
    const signed = VersionedTransaction.deserialize(Buffer.from(s.all.get('order-1')!.signedTransaction!, 'base64'));
    expect(signed.signatures[1].some(b => b !== 0)).toBe(true);
  });

  it('heals a sale saved under the seller\'s signature, so a sale that landed is seen', async () => {
    const sale = ccSale(), tx = VersionedTransaction.deserialize(Buffer.from(sale.base64, 'base64'));
    tx.sign([seller]);
    const old: Sale = { id: 'order-1', mint: card, seller: seller.publicKey.toBase58(), recipient: pool.toBase58(), amountMicros: M,
      signedTransaction: Buffer.from(tx.serialize()).toString('base64'), signature: bs58.encode(tx.signatures[1]), blockhash: tx.message.recentBlockhash };
    const calls: string[] = [];
    const result = await sellBack(options(store([old]), chain(new Set([sale.id])), client(sale.base64, calls)));
    expect(result).toEqual({ state: 'complete', signature: sale.id, amountMicros: M });
    expect(calls).toEqual([]);
  });

  it('finds a sale that already landed by CC\'s memo, and never asks to sell the card again', async () => {
    const pending: Sale = { id: 'order-1', mint: card, seller: seller.publicKey.toBase58(), recipient: pool.toBase58(), attempts: 1 };
    const calls: string[] = [], s = store([pending]);
    const history = [{ signature: 'other', memo: 'cc-other:buyback', paid: 9n * BigInt(M) }, { signature: 'landed', memo: 'cc-pack:buyback', paid: 17_850_000n }];
    const result = await sellBack(options(s, chain(new Set(), history), client(ccSale().base64, calls)));
    expect(result).toEqual({ state: 'complete', signature: 'landed', amountMicros: 17_850_000 });
    expect(calls).toEqual([]);
    expect(s.all.get('order-1')!.confirmed).toBe(true);
  });
});
