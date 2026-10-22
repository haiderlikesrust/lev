/** Starts the background worker once per server process (Node runtime only, never during `next build`). */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || process.env.NEXT_PHASE === 'phase-production-build') return;
  const { startWorker } = await import('./lib/server/services');
  await startWorker().catch(error => console.error('[worker] failed to start:', (error as Error).message));
}
