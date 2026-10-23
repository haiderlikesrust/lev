import type { Database } from './db';
import { audit } from './db';
import type { Collector } from './collector';
import { calibrateMachine, type CalibrationRow } from '../shared/calibration';
import { calibrateShort, type ShortCalibrationRow } from '../shared/short';
import type { Settings } from '../shared/settings';
import { MACHINES } from '../shared/machines';

const DAY = 86_400_000;
/** Most recent pulls per machine the calibration uses; keeps the bootstrap fast. */
const MAX_PULLS = 20_000;
const seedOf = (code: string) => [...code].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

/**
 * Recomputes every machine's fair multipliers (long levels and the short) from its pulls since the later of
 * the window start and the machine's last config change. Yields between machines so the web server stays
 * responsive.
 */
export async function runCalibration(db: Database, collector: Collector, settings: Settings, now = Date.now()) {
  const configs = await collector.configs(), summary: Record<string, unknown> = {};
  for (const def of MACHINES) {
    const m = configs.find(c => c.code === def.code);
    if (!m) continue;
    const from = Math.max(now - settings.calibrationWindowDays * DAY, m.changedAt);
    const pulls = (await db.query<{ value_micros: string; pulled_at: string }>(
      'SELECT value_micros::text, pulled_at::text FROM cc_pulls WHERE code=$1 AND pulled_at >= $2 ORDER BY pulled_at DESC LIMIT $3', [m.code, from, MAX_PULLS])).rows;
    const ratios = pulls.map(p => Number(p.value_micros) / (m.priceUsd * 1_000_000));
    const window = { fromMs: pulls.length ? Number(pulls.at(-1)!.pulled_at) : from, toMs: pulls.length ? Number(pulls[0].pulled_at) : now };
    const edgesBps = [...new Set([settings.minEdgeBps, settings.edgeBps])];
    const rows = calibrateMachine(m.code, ratios, m.buybackPct / 100, window, { edgesBps, resamples: 1_000, seed: seedOf(m.code), now });
    const short = calibrateShort(m.code, ratios, window, { edgesBps, now });
    await db.query('DELETE FROM calibration WHERE code=$1', [m.code]);
    for (const row of rows) await db.query('INSERT INTO calibration(code,level,data,computed_at) VALUES($1,$2,$3,$4)', [row.code, row.level, JSON.stringify(row), row.computedAt]);
    if (short) await db.query('INSERT INTO calibration(code,level,data,computed_at) VALUES($1,$2,$3,$4)', [short.code, 'short', JSON.stringify(short), short.computedAt]);
    summary[m.code] = { n: ratios.length, safe: Object.fromEntries(rows.map(r => [r.level, r.safeBps])), short: short?.fair };
    await new Promise(resolve => setImmediate(resolve));
  }
  await audit(db, 'calibration', summary);
  return summary;
}

export async function loadCalibration(db: Database): Promise<CalibrationRow[]> {
  return (await db.query<{ data: CalibrationRow }>("SELECT data FROM calibration WHERE level <> 'short'")).rows.map(r => r.data);
}
export async function loadShortCalibration(db: Database): Promise<ShortCalibrationRow[]> {
  return (await db.query<{ data: ShortCalibrationRow }>("SELECT data FROM calibration WHERE level = 'short'")).rows.map(r => r.data);
}
