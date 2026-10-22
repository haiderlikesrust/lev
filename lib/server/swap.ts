import { VersionedTransaction } from '@solana/web3.js';
import { config } from './config';
import type { Chain, TxPolicy } from './chain';
import { ReviewRequired } from './jobs';

// Ported from Pullback (server/swap.ts): Jupiter (Metis only) swaps with a guaranteed output floor.
const JUP = 'https://api.jup.ag/swap/v2';

async function jsonFetch(url: string, init: RequestInit = {}) {
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  const body: any = await response.json();
  if (!response.ok) throw new Error(body.error || body.message || `Provider returned HTTP ${response.status}`);
  return body;
}

export function quote(inputMint: string, outputMint: string, amount: bigint, taker?: string, slippageBps = 100) {
  return jsonFetch(`${JUP}/order?${new URLSearchParams({ inputMint, outputMint, amount: amount.toString(), slippageBps: String(slippageBps), excludeRouters: 'jupiterz,dflow,okx', ...(taker ? { taker } : {}) })}`, { headers: { 'x-api-key': config.JUPITER_API_KEY } });
}

export async function swap(chain: Chain, id: string, inputMint: string, outputMint: string, amount: bigint, slippageBps: number, minOutput = 1n) {
  if (amount <= 0n) throw new Error('Swap amount must be positive.');
  if (!config.JUPITER_API_KEY) throw new ReviewRequired('Set JUPITER_API_KEY (portal.jup.ag) before swapping.');
  let job = await chain.jobs.get(id);
  if (!job) await chain.jobs.put(id, 'swap', 'queued', { inputMint, outputMint, amount: amount.toString(), minOutput: minOutput.toString() });
  job = await chain.jobs.get(id); const d = job.data;
  if (d.inputMint !== inputMint || d.outputMint !== outputMint || d.amount !== amount.toString()) throw new ReviewRequired('Swap intent changed during recovery.');
  const policy: TxPolicy = { kind: 'swap', inputMint, maxInput: amount, outputMint, minOutput };
  const signature = await chain.execute(id, 'swap', async () => {
    const requestedAt = Date.now(), order = await quote(inputMint, outputMint, amount, chain.address!, slippageBps);
    if (Date.now() - requestedAt > 10_000) throw new Error('Swap quote is stale. Retry with current pricing.');
    if (order.errorCode || !order.transaction) throw new Error(order.errorMessage || 'No supported swap route.');
    if (order.router !== 'metis' || order.inputMint !== inputMint || order.outputMint !== outputMint || BigInt(order.inAmount) !== amount) throw new ReviewRequired('Swap quote route, asset or amount mismatch.');
    const guaranteed = BigInt(order.outAmount) * (10_000n - BigInt(slippageBps)) / 10_000n;
    if (guaranteed < minOutput) throw new Error('Swap output is below the required minimum.');
    if (BigInt(order.otherAmountThreshold ?? '0') < guaranteed || Number(order.slippageBps) > slippageBps) throw new ReviewRequired('Swap exceeds the configured slippage ceiling.');
    policy.minOutput = guaranteed;
    const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, 'base64'));
    if (tx.version !== 0 && tx.version !== 'legacy') throw new Error('No supported swap route (newer transaction format).');
    if (tx.message.header.numRequiredSignatures !== 1) throw new ReviewRequired('Swap requires an unsupported co-signer.');
    return tx;
  }, policy);
  const received = await chain.tokenDelta(signature, outputMint);
  if (received < minOutput) throw new ReviewRequired('Settled swap output is insufficient.');
  return { signature, received };
}
