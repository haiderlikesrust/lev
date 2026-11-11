import { describe, expect, it } from 'vitest';
import { Keypair, MessageV0, SystemProgram, Transaction, VersionedTransaction } from '@solana/web3.js';
import { signableVersion } from '@/lib/server/chain';
import { openDatabase } from '@/lib/server/db';
import { MockPacks, MockSolana } from '@/lib/server/mock';
import { recordCreatorFees } from '@/lib/server/burns';
import { lockLabel } from '@/lib/client/api';
import { insuredUsd, parsePull } from '@/lib/server/cc/client';
import { paymentFailure } from '@/lib/server/live';
import { bootstrap, createServices } from '@/lib/server/services';
import { machinesView } from '@/lib/server/views';
import type { Level } from '@/lib/shared/leverage';

const M = 1_000_000;
const claimFees = (ctx: Awaited<ReturnType<typeof setup>>, usd: number, id = 'fees:1') =>
  recordCreatorFees(ctx.s.db, ctx.s.settings.current, { id, usdcMicros: usd * M, signature: ctx.solana.receiveFees(usd * M), from: ctx.solana.poolAddress });

async function setup(poolUsd = 25_000) {
  const solana = new MockSolana(BigInt(poolUsd) * BigInt(M));
  const packs = new MockPacks(solana); packs.pendingCalls = 0;
  const s = await createServices({ database: await openDatabase('', 'memory://'), practice: { solana, packs } });
  await bootstrap(s);
  return { s, solana, packs, wallet: Keypair.generate().publicKey.toBase58() };
}

/** Creates, pays and settles one pack whose card is worth `valueUsd`. */
async function play(ctx: Awaited<ReturnType<typeof setup>>, level: Level, valueUsd: number, code = 'pokemon_25') {
  ctx.packs.forceValues.push(valueUsd);
  const { order } = await ctx.s.orders.create(ctx.wallet, code, level, true);
  await ctx.s.orders.pay(ctx.wallet, order.id, 'practice');
  for (let i = 0; i < 10; i++) { await ctx.s.orders.step(); if (['complete', 'refunded', 'review'].includes((await ctx.s.orders.get(order.id)).status)) break; }
  return ctx.s.orders.get(order.id);
}
const balance = async (solana: MockSolana, owner: string) => Number(await solana.usdcBalance(owner)) / M;

describe('leverage packs (practice mode)', () => {
  it('pays a win: card plus (value − price) × (M − 1) from the pool', async () => {
    const ctx = await setup(), before = await balance(ctx.solana, ctx.solana.poolAddress);
    const order = await play(ctx, 'full', 60);
    expect(order.status).toBe('complete');
    expect(order.outcome).toBe('win');
    const expected = Math.floor((60 - 25) * (order.multiplierBps - 10_000) / 10_000 * M) / M;
    expect(order.bonusUsd).toBeCloseTo(expected, 6);
    expect(order.links.nftTransfer).toBeTruthy();
    expect(await balance(ctx.solana, ctx.wallet)).toBeCloseTo(expected, 6);
    expect(await balance(ctx.solana, ctx.solana.poolAddress)).toBeCloseTo(before - expected, 6);
    expect(await ctx.s.pool.reserved()).toBe(0);
  });

  it('keeps a losing card: sells it back into the pool and pays a half-risk floor', async () => {
    const ctx = await setup(), before = await balance(ctx.solana, ctx.solana.poolAddress);
    const order = await play(ctx, 'half', 13);
    expect(order.outcome).toBe('loss');
    expect(order.sellbackUsd).toBeCloseTo(13 * 0.85, 6);
    expect(order.floorUsd).toBeCloseTo(13 * 0.85 * 0.5, 6);
    expect(order.links.nftTransfer).toBeNull();
    expect(await balance(ctx.solana, ctx.wallet)).toBeCloseTo(13 * 0.85 * 0.5, 6);
    expect(await balance(ctx.solana, ctx.solana.poolAddress)).toBeCloseTo(before + 13 * 0.85 * 0.5, 6);
    const [settled] = await ctx.s.db.query('SELECT outcome, floor_micros::text FROM settlements WHERE order_id=$1', [order.id]).then(r => r.rows);
    expect(settled.outcome).toBe('loss');
  });

  it('a full-risk loss pays nothing; a push just sends the card', async () => {
    const ctx = await setup();
    const loss = await play(ctx, 'full', 20);
    expect(loss.outcome).toBe('loss');
    expect(loss.floorUsd).toBe(0);
    const push = await play(ctx, 'full', 25.5);
    expect(push.outcome).toBe('push');
    expect(push.bonusUsd).toBe(0);
    expect(push.links.nftTransfer).toBeTruthy();
    expect(await balance(ctx.solana, ctx.wallet)).toBe(0);
  });

  it('never pays twice when steps run again', async () => {
    const ctx = await setup();
    const order = await play(ctx, 'full', 80);
    const paid = await balance(ctx.solana, ctx.wallet);
    for (let i = 0; i < 3; i++) await ctx.s.orders.step();
    expect(await balance(ctx.solana, ctx.wallet)).toBe(paid);
    expect((await ctx.s.orders.get(order.id)).status).toBe('complete');
  });

  it('refunds in full when Collector Crypt will not sell the pack', async () => {
    const ctx = await setup();
    ctx.packs.machineLow.add('pokemon_25');
    const order = await play(ctx, 'half', 30);
    expect(order.status).toBe('refunded');
    expect(await balance(ctx.solana, ctx.wallet)).toBe(25);
    expect(await ctx.s.pool.reserved()).toBe(0);
  });

  it('requires the HIGH RISK confirmation for every pack', async () => {
    const ctx = await setup();
    await expect(ctx.s.orders.create(ctx.wallet, 'pokemon_25', 'full', false)).rejects.toThrow(/HIGH RISK/);
  });

  it('cools a wallet down after 5 losses in a row', async () => {
    const ctx = await setup();
    for (let i = 0; i < 5; i++) expect((await play(ctx, 'full', 15)).outcome).toBe('loss');
    await expect(ctx.s.orders.create(ctx.wallet, 'pokemon_25', 'full', true)).rejects.toThrow(/5 losses in a row/);
    const other = { ...ctx, wallet: Keypair.generate().publicKey.toBase58() };
    expect((await play(other, 'full', 15)).status).toBe('complete');
  });

  it('honours a player\'s own daily loss limit, and delays raising it', async () => {
    const ctx = await setup();
    await ctx.s.limits.setOwnLimit(ctx.wallet, 30 * M);
    expect((await play(ctx, 'full', 15)).outcome).toBe('loss');
    await expect(ctx.s.orders.create(ctx.wallet, 'pokemon_25', 'full', true)).rejects.toThrow(/own daily loss limit/);
    const raised = await ctx.s.limits.setOwnLimit(ctx.wallet, 500 * M);
    expect(raised.dailyLossLimitUsd).toBe(30);
    expect(raised.pending?.dailyLossLimitUsd).toBe(500);
  });

  it('keeps a level locked until the pool reaches its unlock size, then opens it after creator fees arrive', async () => {
    const ctx = await setup(150);
    await expect(ctx.s.orders.create(ctx.wallet, 'pokemon_25', 'full', true)).rejects.toThrow(/Unlocks when the pool reaches/);
    await claimFees(ctx, 5_000);
    ctx.s.pool.invalidate();
    expect((await play(ctx, 'full', 26)).status).toBe('complete');
  });

  it('keeps 85% of creator fees as pool money and holds 15% until the owner buys back', async () => {
    const ctx = await setup(10_000);
    await claimFees(ctx, 1_000);
    ctx.s.pool.invalidate();
    expect(await ctx.s.pool.held()).toBe(150 * M);
    expect(await ctx.s.pool.balance()).toBe(10_850 * M);
    await ctx.s.burns.start('owner');
    await expect(ctx.s.burns.start('owner')).rejects.toThrow(/already running/);
    await ctx.s.burns.step();
    ctx.s.pool.invalidate();
    expect(await ctx.s.pool.held()).toBe(0);
    expect(await ctx.s.pool.balance()).toBe(10_850 * M);
    expect((await ctx.s.burns.list())[0].status).toBe('done');
  });

  it('counts a claim once, even when a crash makes it record twice', async () => {
    const ctx = await setup(10_000);
    await claimFees(ctx, 1_000, 'fees:same');
    await claimFees(ctx, 1_000, 'fees:same');
    expect(await ctx.s.pool.held()).toBe(150 * M);
  });

  it('collects fees only when they are due, and never while paused', async () => {
    const ctx = await setup(10_000);
    expect(await ctx.s.burns.feesDue()).toBe(false);
    await ctx.s.burns.collectFees();
    expect(await ctx.s.pool.held()).toBe(0);
  });

  it('never reads a blank card value as $0', async () => {
    expect([null, undefined, '', 0, 'n/a'].map(insuredUsd)).toEqual([null, null, null, null, null]);
    expect([65, '65.5', '$1,200'].map(insuredUsd)).toEqual([65, 65.5, 1_200]);
    expect(parsePull({ nft_address: 'a', pack_type: 'pokemon_25', insuredValue: null, created_at: '2026-11-04T00:00:00Z' })).toBeNull();
    const ctx = await setup(), buy = ctx.packs.buy.bind(ctx.packs);
    ctx.packs.buy = async (id, code, price) => { const r = await buy(id, code, price); return r.state === 'complete' ? { ...r, card: { ...r.card, insuredValueUsd: null } } : r; };
    ctx.packs.status = async () => ({ send: { insured_value: null } });
    const order = await play(ctx, 'full', 60);
    expect(order.status).toBe('settling');
    expect(order.valueUsd).toBeNull();
  });

  it('refunds a waiting short on time even while the feed is down', async () => {
    const ctx = await setup();
    // An hour's guard means no sample pull counts; the wait is set so it has already run out.
    ctx.s.orders.shortTiming = { guardMs: 3_600_000, lagMs: 0, pollMs: 0 };
    ctx.s.settings.current = { ...ctx.s.settings.current, shortWaitMinutes: -120 };
    ctx.packs.recentPulls = async () => { throw new Error('Collector Crypt is down'); };
    const { order } = await ctx.s.orders.create(ctx.wallet, 'pokemon_25', 'full', true, undefined, 'short');
    await ctx.s.orders.pay(ctx.wallet, order.id, 'practice');
    for (let i = 0; i < 6; i++) await ctx.s.orders.step();
    expect((await ctx.s.orders.get(order.id)).status).toBe('refunded');
  });

  it('counts paid packs against a player\'s own loss limit until they settle', async () => {
    const ctx = await setup();
    await ctx.s.limits.setOwnLimit(ctx.wallet, 30 * M);
    const { order } = await ctx.s.orders.create(ctx.wallet, 'pokemon_25', 'full', true);
    await ctx.s.orders.pay(ctx.wallet, order.id, 'practice');
    await expect(ctx.s.orders.create(ctx.wallet, 'pokemon_25', 'full', true)).rejects.toThrow(/own daily loss limit/);
  });

  it('opens the $25 Half pack on a $100 pool, one pack at a time', async () => {
    const ctx = await setup(100), other = Keypair.generate().publicKey.toBase58();
    ctx.packs.forceValues.push(13);
    const { order } = await ctx.s.orders.create(ctx.wallet, 'pokemon_25', 'half', true);
    expect(order.capUsd).toBe(25);
    await ctx.s.orders.pay(ctx.wallet, order.id, 'practice');
    // Its $25 top bonus is set aside, so the next pack waits until this one settles.
    await expect(ctx.s.orders.create(other, 'pokemon_25', 'half', true)).rejects.toThrow(/Unlocks when the pool reaches/);
    for (let i = 0; i < 10; i++) { await ctx.s.orders.step(); if ((await ctx.s.orders.get(order.id)).status === 'complete') break; }
    expect((await ctx.s.orders.get(order.id)).outcome).toBe('loss');
    ctx.s.pool.invalidate();
    expect((await ctx.s.orders.create(other, 'pokemon_25', 'half', true)).order.capUsd).toBe(25);
  });

  it('asks for no payment until the pack wallet has a USDC account, and never blames the buyer for it', async () => {
    const ctx = await setup();
    ctx.solana.funds.set(ctx.solana.opsAddress, { usdcAccount: false, usdcMicros: 0n, lamports: 1_000_000_000n });
    await expect(ctx.s.orders.create(ctx.wallet, 'pokemon_25', 'half', true)).rejects.toThrow(/getting ready to take payments/);
    const missing = 'Transaction simulation failed: Error processing Instruction 2: invalid account data for instruction';
    expect(paymentFailure(missing)).not.toMatch(/This wallet/);
    expect(paymentFailure('custom program error: 0x1')).toMatch(/not have enough USDC/);
  });

  it('signs Collector Crypt transactions in both formats it sends: legacy sales and v0 packs', () => {
    const payer = Keypair.generate().publicKey, ix = SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 1 }), recentBlockhash = '11111111111111111111111111111111';
    const legacy = new Transaction({ feePayer: payer, recentBlockhash }).add(ix).serialize({ requireAllSignatures: false, verifySignatures: false });
    const v0 = new VersionedTransaction(MessageV0.compile({ payerKey: payer, instructions: [ix], recentBlockhash })).serialize();
    expect(VersionedTransaction.deserialize(legacy).version).toBe('legacy');
    expect(signableVersion(VersionedTransaction.deserialize(legacy))).toBe(true);
    expect(signableVersion(VersionedTransaction.deserialize(v0))).toBe(true);
  });

  it('has no pool safety line by default, but a level still waits for its unlock size', async () => {
    const ctx = await setup(60);
    expect(await ctx.s.pool.pauseReason()).toBeNull();
    await expect(ctx.s.orders.create(ctx.wallet, 'pokemon_25', 'half', true)).rejects.toThrow(/Unlocks when the pool reaches/);
  });

  it('pauses new packs below the safety line when one is set', async () => {
    const ctx = await setup(500);
    ctx.s.settings.current = { ...ctx.s.settings.current, pauseThresholdUsd: 1_000 };
    await expect(ctx.s.orders.create(ctx.wallet, 'pokemon_25', 'half', true)).rejects.toThrow(/safety line/);
  });

  it('shows one neutral message for a pack that is not available', async () => {
    const ctx = await setup(), { s } = ctx, view = () => machinesView(s.db, s.pool, s.packs, s.settings, s.collector);
    s.settings.current = { ...s.settings.current, disabledMachines: ['pokemon_25'] };
    await expect(s.orders.create(ctx.wallet, 'pokemon_25', 'half', true)).rejects.toThrow(/not available/);
    await expect(s.orders.create(ctx.wallet, 'pokemon_25', 'full', true, undefined, 'short')).rejects.toThrow(/not available/);
    const closed = (await view()).find(m => m.code === 'pokemon_25')!;
    expect([...closed.offers, closed.short].every(o => !o?.available)).toBe(true);
    expect(JSON.stringify(closed)).not.toMatch(/team|admin|owner|disabled|turned off/i);
    expect(lockLabel(closed.offers[0])).toBe('unavailable');

    s.settings.current = { ...s.settings.current, disabledMachines: [], levels: { half: false, full: true }, shortsEnabled: false };
    const part = (await view()).find(m => m.code === 'pokemon_25')!;
    expect(part.offers.find(o => o.level === 'half')?.reason).toBe('Not available right now.');
    expect(part.offers.find(o => o.level === 'full')?.available).toBe(true);
    expect(part.short?.reason).toBe('Not available right now.');

    s.settings.current = { ...s.settings.current, levels: { half: true, full: true }, shortsEnabled: true, paused: true };
    expect(await s.pool.pauseReason()).not.toMatch(/team|admin|owner/i);
  });

  it('keeps claiming fees while packs are switched off, but not when everything is paused', async () => {
    const ctx = await setup(), { s } = ctx;
    ctx.solana.creatorFeesDue = async () => true;
    s.settings.current = { ...s.settings.current, disabledMachines: ['pokemon_25', 'pokemon_50'] };
    expect(await s.burns.feesDue()).toBe(true);
    s.settings.current = { ...s.settings.current, paused: true };
    expect(await s.burns.feesDue()).toBe(false);
  });
});

/** Creates and pays one short, then lets the next pull on the machine (worth `valueUsd`) settle it. */
async function short(ctx: Awaited<ReturnType<typeof setup>>, valueUsd: number | null, code = 'pokemon_25') {
  ctx.packs.autoFeed = false;
  ctx.s.orders.shortTiming = { guardMs: 0, lagMs: 0, pollMs: 0 };
  const { order } = await ctx.s.orders.create(ctx.wallet, code, 'full', true, undefined, 'short');
  await ctx.s.orders.pay(ctx.wallet, order.id, 'practice');
  await ctx.s.orders.step();
  const watching = await ctx.s.orders.get(order.id);
  expect(watching.status).toBe('watching');
  // A pull stamped before the short was paid never counts.
  ctx.packs.pushPull(code, 1_000, watching.watchFrom! - 1);
  await new Promise(resolve => setTimeout(resolve, 5));
  if (valueUsd !== null) ctx.packs.pushPull(code, valueUsd);
  for (let i = 0; i < 10; i++) { await ctx.s.orders.step(); if (['complete', 'refunded', 'review'].includes((await ctx.s.orders.get(order.id)).status)) break; }
  return ctx.s.orders.get(order.id);
}

describe('shorts (practice mode)', () => {
  it('wins when the next pull misses: stake back plus (price − value) × S from the pool', async () => {
    const ctx = await setup(), before = await balance(ctx.solana, ctx.solana.poolAddress);
    const order = await short(ctx, 15);
    expect(order.status).toBe('complete');
    expect(order.side).toBe('short');
    expect(order.outcome).toBe('win');
    const payout = Math.floor((25 - 15) * order.multiplierBps / 10_000 * M) / M;
    expect(order.bonusUsd).toBeCloseTo(payout, 6);
    expect(order.valueUsd).toBe(15);
    expect(await balance(ctx.solana, ctx.wallet)).toBeCloseTo(25 + payout, 6);
    expect(await balance(ctx.solana, ctx.solana.poolAddress)).toBeCloseTo(before - payout, 6);
    expect(await balance(ctx.solana, ctx.solana.opsAddress)).toBe(0);
    expect(order.links.stakeBack && order.links.payout).toBeTruthy();
    expect(order.pull?.mint).toBeTruthy();
    expect(await ctx.s.pool.reserved()).toBe(0);
    const [settled] = (await ctx.s.db.query('SELECT side, outcome, bonus_micros::text FROM settlements WHERE order_id=$1', [order.id])).rows;
    expect(settled).toMatchObject({ side: 'short', outcome: 'win' });
  });

  it('loses the stake to the pool when the next pull hits, and returns it on a push', async () => {
    const ctx = await setup(), before = await balance(ctx.solana, ctx.solana.poolAddress);
    const loss = await short(ctx, 60);
    expect(loss.outcome).toBe('loss');
    expect(loss.bonusUsd).toBe(0);
    expect(loss.links.stakeToPool).toBeTruthy();
    expect(await balance(ctx.solana, ctx.wallet)).toBe(0);
    expect(await balance(ctx.solana, ctx.solana.poolAddress)).toBeCloseTo(before + 25, 6);
    const push = await short(ctx, 25.5);
    expect(push.outcome).toBe('push');
    expect(await balance(ctx.solana, ctx.wallet)).toBe(25);
    expect(await balance(ctx.solana, ctx.solana.poolAddress)).toBeCloseTo(before + 25, 6);
  });

  it('refunds the stake in full when no pull comes in time', async () => {
    const ctx = await setup();
    ctx.s.settings.current = { ...ctx.s.settings.current, shortWaitMinutes: 0 };
    const order = await short(ctx, null);
    expect(order.status).toBe('refunded');
    expect(order.pull).toBeNull();
    expect(await balance(ctx.solana, ctx.wallet)).toBe(25);
    expect(await ctx.s.pool.reserved()).toBe(0);
  });

  it('caps what all the shorts riding one pull can win together', async () => {
    const ctx = await setup();
    ctx.packs.autoFeed = false;
    const first = (await ctx.s.orders.create(ctx.wallet, 'pokemon_25', 'full', true, undefined, 'short')).order;
    // Room for one short's top payout under the cap, not two.
    const free = await ctx.s.pool.free();
    ctx.s.settings.current = { ...ctx.s.settings.current, capBps: Math.ceil(first.capUsd * M * 1.5 * 10_000 / free) };
    await ctx.s.orders.pay(ctx.wallet, first.id, 'practice');
    const other = Keypair.generate().publicKey.toBase58();
    const second = (await ctx.s.orders.create(other, 'pokemon_25', 'full', true, undefined, 'short')).order;
    await expect(ctx.s.orders.pay(other, second.id, 'practice')).rejects.toThrow(/Too many shorts/);
  });

  it('counts short losses toward the cool-down', async () => {
    const ctx = await setup();
    for (let i = 0; i < 3; i++) expect((await play(ctx, 'full', 15)).outcome).toBe('loss');
    for (let i = 0; i < 2; i++) expect((await short(ctx, 80)).outcome).toBe('loss');
    await expect(ctx.s.orders.create(ctx.wallet, 'pokemon_25', 'full', true, undefined, 'short')).rejects.toThrow(/5 losses in a row/);
  });
});
