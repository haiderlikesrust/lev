import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { api, body, requireWallet, sameOrigin } from '@/lib/server/http';
import { httpError } from '@/lib/server/redact';
import { LEVELS } from '@/lib/shared/leverage';
import { SIDES } from '@/lib/shared/short';

/** The signed-in wallet's leverage packs, newest first. */
export function GET(req: NextRequest) {
  return api(async s => s.orders.list((await requireWallet(req, s)).wallet));
}

/**
 * Starts one leverage pack, or a short on a machine's next pull: locks its terms and returns the USDC payment
 * to sign. `acceptedRisk` must be true: the buyer ticked the HIGH RISK box for this one.
 */
export function POST(req: NextRequest) {
  return api(async s => {
    sameOrigin(req);
    const who = await requireWallet(req, s);
    const input = await body(req, z.object({ code: z.string().max(64), side: z.enum(SIDES as ['long', 'short']).default('long'), level: z.enum(LEVELS as ['half', 'full']).default('full'), acceptedRisk: z.boolean() }));
    if (!(await s.limits.optedIn(who.wallet))) throw httpError(403, 'Turn on leverage packs for this wallet first.');
    return s.orders.create(who.wallet, input.code, input.level ?? 'full', input.acceptedRisk, fn => s.serial.run(fn), input.side ?? 'long');
  });
}
