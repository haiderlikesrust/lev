import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { api, body, requireOwner, sameOrigin } from '@/lib/server/http';
import { runCalibration } from '@/lib/server/calibration';
import { config } from '@/lib/server/config';
import type { Services } from '@/lib/server/services';
import { settingsSchema } from '@/lib/shared/settings';

/** Owner view: settings, packs in review and recent worker problems. */
export function GET(req: NextRequest) {
  return api(async s => {
    await requireOwner(req, s);
    const audit = (await s.db.query("SELECT event, data, created_at::text FROM audit WHERE event IN ('order-review','order-delayed','worker-error','order-provider-refund') ORDER BY id DESC LIMIT 30")).rows;
    return { settings: s.settings.current, review: await s.orders.review(), audit: audit.map(a => ({ event: a.event, data: a.data, at: Number(a.created_at) })), buyback: await buyback(s) };
  });
}

/**
 * Owner actions: save settings (recalibrating when the edges change), recalibrate now,
 * or resolve a pack in review.
 */
export function POST(req: NextRequest) {
  return api(async s => {
    sameOrigin(req);
    const who = await requireOwner(req, s);
    const input = await body(req, z.discriminatedUnion('action', [
      z.object({ action: z.literal('settings'), settings: z.any() }),
      z.object({ action: z.literal('recalibrate') }),
      z.object({ action: z.literal('buyback') }),
      z.object({ action: z.enum(['retry', 'refund', 'retryNow']), id: z.string().uuid() }),
    ]));
    if (input.action === 'buyback') {
      await s.burns.start(who.wallet);
      // Practice settles at once; on mainnet the worker carries it through swap and burn.
      if (s.practice) await s.serial.run(() => s.burns.step());
    } else if (input.action === 'settings') {
      const before = s.settings.current, next = await s.settings.save(settingsSchema.parse(input.settings), who.wallet);
      if (before.edgeBps !== next.edgeBps || before.minEdgeBps !== next.minEdgeBps || before.calibrationWindowDays !== next.calibrationWindowDays) await runCalibration(s.db, s.collector, next);
    } else if (input.action === 'recalibrate') await runCalibration(s.db, s.collector, s.settings.current);
    else if (input.action === 'retryNow') await s.orders.retryNow(input.id);
    else await s.orders.resolve(input.id, input.action);
    return { ok: true, settings: s.settings.current, review: await s.orders.review(), buyback: await buyback(s) };
  });
}

/** The held creator-fee share and past buybacks. Owner-only; not shown anywhere public. */
async function buyback(s: Services) {
  const totalIn = Number((await s.db.query<{ total: string }>("SELECT COALESCE(SUM(amount_micros),0)::text AS total FROM ledger WHERE bucket='burn' AND kind='fee-held'")).rows[0].total);
  return { heldUsd: (await s.pool.held()) / 1_000_000, totalHeldUsd: totalIn / 1_000_000, burns: await s.burns.list(), mintSet: !!config.MEMECOIN_MINT || !config.live };
}
