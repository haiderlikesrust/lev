import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { api, body, sameOrigin } from '@/lib/server/http';
import { httpError } from '@/lib/server/redact';
import { recordCreatorFees } from '@/lib/server/burns';
import { poolView } from '@/lib/server/views';

/** Practice mode only: pretend creator fees were claimed and swapped to USDC. */
export function POST(req: NextRequest) {
  return api(async s => {
    sameOrigin(req);
    if (!s.practice) throw httpError(404, 'Not found.');
    const { usd } = await body(req, z.object({ usd: z.number().int().min(1).max(1_000_000) }));
    const signature = s.practice.receiveFees(usd * 1_000_000);
    await recordCreatorFees(s.db, s.settings.current, { id: randomUUID(), usdcMicros: usd * 1_000_000, signature, from: s.practice.poolAddress });
    s.pool.invalidate();
    return poolView(s.db, s.pool);
  });
}
