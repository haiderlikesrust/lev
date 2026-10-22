import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { api, body, sameOrigin, setSessionCookie } from '@/lib/server/http';
import { sessionWallet, verify } from '@/lib/server/auth';

/** Checks the signed message and starts a 24-hour session (httpOnly cookie). */
export function POST(req: NextRequest) {
  return api(async s => {
    sameOrigin(req);
    const { id, signature } = await body(req, z.object({ id: z.string().uuid(), signature: z.string().min(64).max(100) }));
    const { token, wallet } = await verify(s.db, id, signature);
    const who = await sessionWallet(s.db, token);
    return setSessionCookie(NextResponse.json({ wallet, owner: !!who?.owner }), token);
  });
}
