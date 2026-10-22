import type { NextRequest } from 'next/server';
import { api, requireWallet } from '@/lib/server/http';

export function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return api(async s => s.orders.get((await params).id, (await requireWallet(req, s)).wallet));
}
