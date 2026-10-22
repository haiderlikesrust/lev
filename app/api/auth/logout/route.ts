import { NextResponse, type NextRequest } from 'next/server';
import { api, sameOrigin, setSessionCookie } from '@/lib/server/http';
import { SESSION_COOKIE, endSession } from '@/lib/server/auth';

export function POST(req: NextRequest) {
  return api(async s => {
    sameOrigin(req);
    await endSession(s.db, req.cookies.get(SESSION_COOKIE)?.value);
    return setSessionCookie(NextResponse.json({ ok: true }), null);
  });
}
