import { NextResponse, connection, type NextRequest } from 'next/server';
import { z } from 'zod';
import { config } from './config';
import { publicError, httpError, redact } from './redact';
import { withServices, type Services } from './services';
import { SESSION_COOKIE, sessionWallet } from './auth';

/**
 * Every API route runs through here: it renders per request (Cache Components would otherwise try to
 * prerender GET handlers), gets the one coordinator, and turns errors into safe JSON.
 */
export async function api<T>(fn: (s: Services) => Promise<T | Response>): Promise<Response> {
  await connection();
  try {
    const result = await withServices(fn);
    return result instanceof Response ? result : NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const e = error as Error & { statusCode?: number };
    const { status, message } = publicError(e instanceof z.ZodError ? Object.assign(new Error('That request was not valid.'), { statusCode: 400 }) : e);
    if (status >= 500) console.error('[api]', redact(e.message));
    return NextResponse.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
}

/** State-changing requests must come from our own pages (the session cookie is SameSite=Lax, this is the second guard). */
export function sameOrigin(req: NextRequest) {
  const origin = req.headers.get('origin');
  if (!origin) throw httpError(403, 'Missing request origin.');
  const host = new URL(origin).hostname, expected = new URL(config.APP_ORIGIN).origin;
  if (origin === expected) return;
  if (!config.live && ['localhost', '127.0.0.1', '[::1]'].includes(host)) return;
  throw httpError(403, 'This request came from another site.');
}

export async function body<T>(req: NextRequest, schema: z.ZodType<T>): Promise<T> {
  const raw = await req.json().catch(() => { throw httpError(400, 'Send a JSON body.'); });
  return schema.parse(raw);
}

export async function session(req: NextRequest, s: Services) { return sessionWallet(s.db, req.cookies.get(SESSION_COOKIE)?.value); }
export async function requireWallet(req: NextRequest, s: Services) {
  const who = await session(req, s);
  if (!who) throw httpError(401, 'Connect and sign in with your wallet first.');
  return who;
}
export async function requireOwner(req: NextRequest, s: Services) {
  const who = await requireWallet(req, s);
  if (!who.owner) throw httpError(403, 'Only the owner wallet can do that.');
  return who;
}

export function setSessionCookie(res: NextResponse, token: string | null) {
  res.cookies.set(SESSION_COOKIE, token ?? '', { httpOnly: true, sameSite: 'lax', secure: config.APP_ORIGIN.startsWith('https:'), path: '/', maxAge: token ? 86_400 : 0 });
  return res;
}
