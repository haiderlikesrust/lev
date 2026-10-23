import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { openDatabase } from '@/lib/server/db';
import { MockPacks, MockSolana } from '@/lib/server/mock';
import { bootstrap, createServices, indexFeeSplits } from '@/lib/server/services';
import type { Level } from '@/lib/shared/leverage';

const M = 1_000_000;

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

  it('keeps a level locked until the pool reaches its unlock size, then opens it after a fee split', async () => {
    const ctx = await setup(1_500);
    await expect(ctx.s.orders.create(ctx.wallet, 'pokemon_25', 'full', true)).rejects.toThrow(/Unlocks when the pool reaches/);
    ctx.solana.feeSplit(5_000 * M);
    await indexFeeSplits(ctx.s);
    ctx.s.pool.invalidate();
    expect((await play(ctx, 'full', 26)).status).toBe('complete');
  });

  it('keeps 85% of creator fees as pool money and holds 15% until the owner buys back', async () => {
    const ctx = await setup(10_000);
    ctx.solana.feeSplit(1_000 * M);
    await indexFeeSplits(ctx.s);
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

  it('pauses new packs below the safety line', async () => {
    const ctx = await setup(500);
    await expect(ctx.s.orders.create(ctx.wallet, 'pokemon_25', 'half', true)).rejects.toThrow(/safety line/);
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
