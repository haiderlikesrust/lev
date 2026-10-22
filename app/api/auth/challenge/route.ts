import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { api, body, sameOrigin } from '@/lib/server/http';
import { challenge } from '@/lib/server/auth';

/** A Sign-In With Solana message for the wallet to sign. */
export function POST(req: NextRequest) {
  return api(async s => {
    sameOrigin(req);
    const { wallet } = await body(req, z.object({ wallet: z.string().min(32).max(44) }));
    return challenge(s.db, wallet);
  });
}
