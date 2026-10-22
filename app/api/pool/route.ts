import { api } from '@/lib/server/http';
import { poolView } from '@/lib/server/views';

/** Pool balance, health and totals. Public. */
export function GET() {
  return api(s => poolView(s.db, s.pool));
}
