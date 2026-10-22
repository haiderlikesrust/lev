import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { api, body, requireWallet, sameOrigin, session } from '@/lib/server/http';

/** The signed-in wallet, its opt-in, its own loss limit and any cool-down. */
export function GET(req: NextRequest) {
  return api(async s => {
    const who = await session(req, s);
    if (!who) return { wallet: null };
    return { wallet: who.wallet, owner: who.owner, optedIn: await s.limits.optedIn(who.wallet), limits: await s.limits.view(who.wallet) };
  });
}

/** Opt in or out of leverage packs, or set your own daily loss limit (null removes it after 24 hours). */
export function POST(req: NextRequest) {
  return api(async s => {
    sameOrigin(req);
    const who = await requireWallet(req, s);
    const input = await body(req, z.object({ optIn: z.boolean().optional(), dailyLossLimitUsd: z.number().int().min(0).max(1_000_000).nullable().optional() }));
    if (input.optIn !== undefined) await s.limits.setOptIn(who.wallet, input.optIn);
    if (input.dailyLossLimitUsd !== undefined) await s.limits.setOwnLimit(who.wallet, input.dailyLossLimitUsd === null ? null : input.dailyLossLimitUsd * 1_000_000);
    return { wallet: who.wallet, owner: who.owner, optedIn: await s.limits.optedIn(who.wallet), limits: await s.limits.view(who.wallet) };
  });
}
