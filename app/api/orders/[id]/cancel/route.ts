import type { NextRequest } from 'next/server';
import { api, requireWallet, sameOrigin } from '@/lib/server/http';

export function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return api(async s => {
    sameOrigin(req);
    return s.orders.cancel((await requireWallet(req, s)).wallet, (await params).id);
  });
}
