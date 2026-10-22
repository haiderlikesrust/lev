import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { api, body, requireOwner, sameOrigin } from '@/lib/server/http';
import { runCalibration } from '@/lib/server/calibration';
import { settingsSchema } from '@/lib/shared/settings';

/** Owner view: settings, packs in review and recent worker problems. */
export function GET(req: NextRequest) {
  return api(async s => {
    await requireOwner(req, s);
    const audit = (await s.db.query("SELECT event, data, created_at::text FROM audit WHERE event IN ('order-review','order-delayed','worker-error','order-provider-refund') ORDER BY id DESC LIMIT 30")).rows;
    return { settings: s.settings.current, review: await s.orders.review(), audit: audit.map(a => ({ event: a.event, data: a.data, at: Number(a.created_at) })) };
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
      z.object({ action: z.enum(['retry', 'refund', 'retryNow']), id: z.string().uuid() }),
    ]));
    if (input.action === 'settings') {
      const before = s.settings.current, next = await s.settings.save(settingsSchema.parse(input.settings), who.wallet);
      if (before.edgeBps !== next.edgeBps || before.minEdgeBps !== next.minEdgeBps || before.calibrationWindowDays !== next.calibrationWindowDays) await runCalibration(s.db, s.collector, next);
    } else if (input.action === 'recalibrate') await runCalibration(s.db, s.collector, s.settings.current);
    else if (input.action === 'retryNow') await s.orders.retryNow(input.id);
    else await s.orders.resolve(input.id, input.action);
    return { ok: true, settings: s.settings.current, review: await s.orders.review() };
  });
}
