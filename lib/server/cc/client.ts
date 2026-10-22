import { PublicKey } from '@solana/web3.js';
import { MACHINES, TIERS, type MachineConfig } from '../../shared/machines';

/**
 * Collector Crypt's gacha API, as documented at docs.collectorcrypt.com/gacha/api.
 * Ported from Pullback (server/cc/client.ts); every path here is in CC's docs.
 */
export type Card = { mint: string; name: string; image: string | null; insuredValueUsd: number | null; rarity: string | null; transferSignature: string | null };
export type Buyback = { available: boolean; amountMicros: number | null; expiresAt: number | null };
/** One pull from CC's public winners feed. */
export type FeedPull = { id: string; code: string; valueMicros: number; tier: number | null; slug: string | null; pulledAt: number };

export class ApiError extends Error {
  constructor(readonly status: number, readonly detail = '') { super(`Collector Crypt returned HTTP ${status}${detail ? `: ${detail}` : ''}.`); }
}
/** Collector Crypt refusing to sell from a machine right now ("Machine is low", "off", "empty", "off balance"). Nothing is charged. */
export const machineUnavailable = (error: unknown) => error instanceof ApiError && /machine is (low|off|empty)|off balance/i.test(error.detail);

export class CollectorCrypt {
  constructor(readonly baseUrl = 'https://gacha.collectorcrypt.com', private readonly apiKey = '', private readonly fetcher: typeof fetch = fetch) {}

  private async request(path: string, body?: unknown, timeoutMs = 15_000): Promise<any> {
    const response = await this.fetcher(`${this.baseUrl}/api${path}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(this.apiKey ? { 'x-api-key': this.apiKey } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      // Keep Collector Crypt's own reason (e.g. "Machine is low"): it decides between retrying and refunding.
      const body: any = await response.json().catch(() => null);
      throw new ApiError(response.status, [body?.error, body?.details, body?.message].filter(x => typeof x === 'string' && x).join(' · ').slice(0, 160));
    }
    return response.json();
  }

  /** `GET /api/machines`, narrowed to the machines this app offers. */
  async machines(): Promise<MachineConfig[]> {
    const result = await this.request('/machines');
    if (!Array.isArray(result.machines)) throw new Error('Unexpected machine catalog.');
    return result.machines.filter((m: any) => MACHINES.some(d => d.code === m.code) && m.contains === 1).map(parseMachine).filter(Boolean) as MachineConfig[];
  }

  /** `GET /api/status`: machine codes CC is selling from right now. */
  async openMachines(): Promise<Set<string>> {
    const status = await this.request('/status');
    return new Set((Array.isArray(status.gachas) ? status.gachas : []).filter((g: any) => g.isOpen !== false && g.status !== 'stopped').map((g: any) => String(g.code)));
  }

  async generatePack(playerAddress: string, packType: string, priceUsdc: number) {
    new PublicKey(playerAddress);
    if (!Number.isSafeInteger(priceUsdc) || priceUsdc <= 0) throw new Error('Use a positive whole-USDC pack price.');
    const machine = (await this.machines()).find(m => m.code === packType && m.priceUsd === priceUsdc);
    if (!machine) throw new Error('That pack is not in the public catalog.');
    const order = await this.request('/generatePack', { playerAddress, packType: machine.code, turbo: false });
    if (typeof order.memo !== 'string' || typeof order.transaction !== 'string') throw new Error('Invalid pack order.');
    return { memo: order.memo as string, transaction: order.transaction as string };
  }
  packStatus(memo: string): Promise<any> { return this.request(`/pack/status?${new URLSearchParams({ memo })}`); }
  /** Opens an already-paid pack, or returns its existing award. Never buys a pack. */
  openPack(memo: string): Promise<any> { return this.request('/openPack', { memo }); }

  async buybackQuote(mint: string): Promise<Buyback> {
    new PublicKey(mint);
    const quote = await this.request(`/buyback/available?${new URLSearchParams({ nft: mint })}`);
    if (quote.available === false) return { available: false, amountMicros: null, expiresAt: null };
    const amount = Number(quote.amount), expires = Date.parse(quote.buybackExpiresAt ?? '');
    if (quote.available !== true || !Number.isSafeInteger(amount) || amount < 10_000 || amount > 280_000_000_000) throw new Error('Invalid buyback quote.');
    return { available: true, amountMicros: amount, expiresAt: Number.isFinite(expires) ? expires : null };
  }
  /** A sell-back transaction for the card's owner to sign. USDC goes to `altRecipient` (else the owner). */
  async buyback(playerAddress: string, nftAddress: string, altRecipient?: string) {
    new PublicKey(playerAddress); new PublicKey(nftAddress); if (altRecipient) new PublicKey(altRecipient);
    const offer = await this.request('/buyback', { playerAddress, nftAddress, ...(altRecipient ? { altRecipient } : {}) });
    const amount = Number(offer.refundAmount);
    if (typeof offer.serializedTransaction !== 'string' || !Number.isSafeInteger(amount) || amount < 10_000 || amount > 280_000_000_000) throw new Error('Collector Crypt did not return a sell offer.');
    return { transaction: offer.serializedTransaction as string, amountMicros: amount, memo: typeof offer.memo === 'string' ? offer.memo as string : null };
  }

  /**
   * Broadcasts a signed tx through Collector Crypt so they register it (packs and buybacks).
   * Prefer this over a raw RPC send: their indexer often misses those.
   */
  async submitTransaction(signedTransaction: string): Promise<{ signature: string; confirmationStatus?: string }> {
    // Their handler waits for confirmation (often 1–several seconds); give it more room than a status poll.
    const result = await this.request('/submitTransaction', { signedTransaction }, 45_000);
    if (!result.success || typeof result.signature !== 'string') throw new Error('Collector Crypt did not accept the signed transaction.');
    return { signature: result.signature, confirmationStatus: typeof result.confirmationStatus === 'string' ? result.confirmationStatus : undefined };
  }

  /** `GET /api/getAllWinners`: a machine's newest pulls (at most 200, no paging). */
  async recentPulls(packType: string, count = 200): Promise<FeedPull[]> {
    const body = await this.request(`/getAllWinners?${new URLSearchParams({ packType, count: String(Math.min(200, count)) })}`);
    return (Array.isArray(body.data) ? body.data : []).map(parsePull).filter(Boolean) as FeedPull[];
  }
  /** `GET /api/getWinners`: every machine's pulls under one memo slug, newest first, cursor-paged. */
  async pullHistory(slug: string, cursor?: string | null, count = 200) {
    const body = await this.request(`/getWinners?${new URLSearchParams({ slug, count: String(Math.min(200, count)), ...(cursor ? { cursor } : {}) })}`);
    return {
      pulls: (Array.isArray(body.data) ? body.data : []).map(parsePull).filter(Boolean) as FeedPull[],
      nextCursor: body.nextCursor ? String(body.nextCursor) : null, hasMore: !!body.hasMore,
    };
  }

  /** Reads metadata for an existing purchase by memo (no payment or opening). */
  async cardDetails(memo: string, dasRpcUrl?: string): Promise<Card | null> {
    const status = await this.packStatus(memo);
    if (!status.send?.nft_address) return null;
    const asset = dasRpcUrl ? await this.asset(status.send.nft_address, dasRpcUrl) : undefined;
    return normalizeCard({ nft_address: status.send.nft_address, nftWon: asset, transactionSignature: status.send.transaction_signature }, status);
  }
  /** Requires an RPC provider supporting Solana DAS getAsset (including Core/compressed cards). */
  async asset(mint: string, dasRpcUrl: string): Promise<any> {
    new PublicKey(mint);
    const response = await this.fetcher(dasRpcUrl, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id: mint } }) });
    if (!response.ok) throw new Error('Asset RPC request failed.');
    const body: any = await response.json();
    if (body.error || !body.result || body.result.id !== mint) throw new Error('Asset unavailable. Check that this RPC supports DAS getAsset.');
    return body.result;
  }
}

/** Public proof that a pull came from CC's VRF (docs.collectorcrypt.com/gacha/vrf). */
export const vrfVerifyUrl = (baseUrl: string, memo: string) => `${baseUrl}/api/vrf/verify?${new URLSearchParams({ memo })}`;

export function parseMachine(m: any): MachineConfig | null {
  const price = Number(m.price), buyback = Number(m.instantBuyback);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(buyback) || buyback <= 0 || buyback > 100) return null;
  const odds = Object.fromEntries(TIERS.map(t => [t, Number(m.odds?.[t] ?? 0)])) as MachineConfig['odds'];
  const tierRanges = Object.fromEntries(TIERS.map(t => [t, { start: Number(m.tierRanges?.[t]?.start ?? 0), end: Number(m.tierRanges?.[t]?.end ?? 0) }])) as MachineConfig['tierRanges'];
  return { code: String(m.code), name: String(m.name ?? m.code), priceUsd: price, buybackPct: buyback, odds, tierRanges, ev: m.ev == null ? null : Number(m.ev), public: !!m.public };
}

export function parsePull(w: any): FeedPull | null {
  const value = Number(w?.insuredValue), at = Date.parse(w?.created_at ?? '');
  if (!w?.nft_address || typeof w.pack_type !== 'string' || !Number.isFinite(value) || value < 0 || !Number.isFinite(at)) return null;
  return { id: `${w.nft_address}:${at}`, code: w.pack_type, valueMicros: Math.round(value * 1_000_000), tier: Number.isInteger(w.prize_tier) ? w.prize_tier : null, slug: typeof w.memo_slug === 'string' ? w.memo_slug : null, pulledAt: at };
}

export function normalizeCard(opened: any, status: any): Card {
  const nft = opened.nftWon ?? {}, metadata = nft.content?.metadata ?? nft.metadata ?? {};
  const attributes = Array.isArray(metadata.attributes) ? metadata.attributes : [];
  const rawValue = status.send?.insured_value ?? attributes.find((a: any) => /insured.?value/i.test(a.trait_type))?.value;
  const value = rawValue == null || rawValue === '' ? NaN : Number(String(rawValue).replace(/[$,]/g, ''));
  const rawImage = nft.content?.links?.image ?? nft.content?.files?.[0]?.uri ?? metadata.image ?? nft.image;
  let image: string | null = null;
  try { const url = new URL(rawImage); if (url.protocol === 'https:' && !url.username && !url.password) image = url.href; } catch {}
  return { mint: new PublicKey(opened.nft_address).toBase58(), name: metadata.name ?? nft.name ?? 'Pokémon card', image,
    insuredValueUsd: Number.isFinite(value) && value >= 0 ? value : null, rarity: opened.rarity ?? null,
    transferSignature: opened.transactionSignature ?? status.send?.transaction_signature ?? null };
}
