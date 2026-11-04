import type { NextRequest } from 'next/server';
import { api, requireWallet, sameOrigin } from '@/lib/server/http';

export function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return api(async s => {
    sameOrigin(req);
    const { wallet } = await requireWallet(req, s), { id } = await params;
    return s.serial.run(() => s.orders.cancel(wallet, id));
  });
}
