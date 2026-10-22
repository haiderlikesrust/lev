import { api } from '@/lib/server/http';
import { configView } from '@/lib/server/views';

/** Machines with their live offers, the pool, and the house rules. Public. */
export function GET() {
  return api(s => configView(s.db, s.solana, s.pool, s.packs, s.settings, s.collector));
}
