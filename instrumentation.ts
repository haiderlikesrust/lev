/** Starts the coordinator, and with it the background worker, once per server process (Node runtime only, never during `next build`). */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || process.env.NEXT_PHASE === 'phase-production-build') return;
  const { services, stopOnSignals } = await import('./lib/server/services');
  stopOnSignals();
  // Not awaited: Next serves nothing, health check included, until register() returns, and during an
  // update this server waits as a standby until the old one hands over the database. Failures are logged there.
  services().catch(() => {});
}
