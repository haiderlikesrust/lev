import type { NextRequest } from 'next/server';
import { api } from '@/lib/server/http';
import { leaderboardView } from '@/lib/server/views';
import type { Period } from '@/lib/shared/types';

/** Public stats: totals, biggest bonuses and pulls (with their transactions), per-machine results and CC-wide pulls. */
export function GET(req: NextRequest) {
  return api(s => {
    const p = req.nextUrl.searchParams.get('period');
    const period: Period = p === '24h' || p === '7d' ? p : 'all';
    return leaderboardView(s.db, s.packs, s.collector, period);
  });
}
