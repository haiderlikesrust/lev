import { NextResponse, connection } from 'next/server';
import { config } from '@/lib/server/config';
import { coordinatorState, services } from '@/lib/server/services';

const HEALTHY = ['standby', 'starting', 'active'];

/**
 * Docker's health check. A standby (the new server during an update, waiting for the old one to hand
 * over the database) counts as healthy: that is what lets Swarm stop the old one. Public, no secrets.
 */
export async function GET() {
  await connection();
  // Starts the coordinator when no request has yet (WORKER_ENABLED=false).
  services().catch(() => {});
  const state = coordinatorState();
  let ok = HEALTHY.includes(state);
  // A lost database connection fails at once; a slow answer (a long transaction ahead of it) is not a failure.
  if (state === 'active') ok = await Promise.race([
    services().then(s => s.db.query('SELECT 1')).then(() => true, () => false),
    new Promise<boolean>(resolve => setTimeout(resolve, 2_000, true)),
  ]);
  return NextResponse.json(
    { ok, state, mode: config.live ? 'mainnet' : 'practice', database: config.DATABASE_URL ? 'postgres' : 'embedded' },
    { status: ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
  );
}
