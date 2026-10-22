import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { api, body, requireWallet, sameOrigin } from '@/lib/server/http';

/** The wallet-signed USDC payment (base64), or `practice` in practice mode. */
export function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return api(async s => {
    sameOrigin(req);
    const who = await requireWallet(req, s);
    const { signed } = await body(req, z.object({ signed: z.string().min(1).max(4_000) }));
    return s.orders.pay(who.wallet, (await params).id, signed, fn => s.serial.run(fn));
  });
}
