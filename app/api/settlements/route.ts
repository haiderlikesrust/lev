import type { NextRequest } from 'next/server';
import { api } from '@/lib/server/http';
import { settlementsView } from '@/lib/server/views';

/** The public settlement log, newest first. `?before=<ms>` pages back. */
export function GET(req: NextRequest) {
  return api(s => {
    const number = (name: string) => { const value = Number(req.nextUrl.searchParams.get(name)); return Number.isSafeInteger(value) && value > 0 ? value : undefined; };
    return settlementsView(s.db, s.packs, { before: number('before'), limit: number('limit') });
  });
}
