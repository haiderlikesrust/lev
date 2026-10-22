import type { NextRequest } from 'next/server';
import { api } from '@/lib/server/http';
import { settlementsView } from '@/lib/server/views';

/** The public settlement log, newest first. `?before=<ms>` pages back. */
export function GET(req: NextRequest) {
  return api(s => {
    const before = Number(req.nextUrl.searchParams.get('before')) || undefined, limit = Number(req.nextUrl.searchParams.get('limit')) || 50;
    return settlementsView(s.db, s.packs, { before, limit });
  });
}
