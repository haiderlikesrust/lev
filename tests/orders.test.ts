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

  it('pauses new packs below the safety line', async () => {
    const ctx = await setup(500);
    await expect(ctx.s.orders.create(ctx.wallet, 'pokemon_25', 'half', true)).rejects.toThrow(/safety line/);
  });
});
