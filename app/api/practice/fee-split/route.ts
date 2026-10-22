import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { api, body, sameOrigin } from '@/lib/server/http';
import { httpError } from '@/lib/server/redact';
import { indexFeeSplits } from '@/lib/server/services';
import { poolView } from '@/lib/server/views';

/** Practice mode only: pretend Pullback's fee cycle sent its 15% share to the leverage pool. */
export function POST(req: NextRequest) {
  return api(async s => {
    sameOrigin(req);
    if (!s.practice) throw httpError(404, 'Not found.');
    const { usd } = await body(req, z.object({ usd: z.number().int().min(1).max(1_000_000) }));
    s.practice.feeSplit(usd * 1_000_000);
    await indexFeeSplits(s);
    return poolView(s.db, s.pool);
  });
}
