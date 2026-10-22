import { createHash } from 'node:crypto';
import type { Database } from './db';
import type { PackProvider } from './ports';
import type { FeedPull } from './cc/client';
import { loadSample } from './sample';
import { MACHINES, type MachineConfig } from '../shared/machines';

/** What a machine's calibration depends on: a change here restarts its calibration window. */
const fingerprint = (m: MachineConfig) => createHash('sha256').update(JSON.stringify([m.priceUsd, m.buybackPct, m.odds, m.tierRanges])).digest('hex');

/**
 * Collects CC's public pull feed into `cc_pulls` (the calibration's raw data) and keeps a snapshot
 * of each machine's config. `getAllWinners` returns a machine's latest 200 pulls; at ~80 pulls an
 * hour on the busiest machine, polling every 2 minutes misses none.
 */
export class Collector {
  constructor(readonly db: Database, readonly packs: PackProvider) {}

  async refreshMachines(now = Date.now()) {
    const configs = await this.packs.machines();
    for (const m of configs) {
      const print = fingerprint(m), old = (await this.db.query<{ fingerprint: string }>('SELECT fingerprint FROM machine_configs WHERE code=$1', [m.code])).rows[0];
      // First sight: no known change, so the whole window counts. Later changes restart it.
      await this.db.query(`INSERT INTO machine_configs(code,data,fingerprint,fetched_at,changed_at) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(code) DO UPDATE SET data=EXCLUDED.data, fetched_at=EXCLUDED.fetched_at, fingerprint=EXCLUDED.fingerprint,
          changed_at=CASE WHEN machine_configs.fingerprint=EXCLUDED.fingerprint THEN machine_configs.changed_at ELSE EXCLUDED.fetched_at END`,
        [m.code, JSON.stringify(m), print, now, old ? now : 0]);
    }
    return configs;
  }

  async insert(pulls: FeedPull[]) {
    if (!pulls.length) return 0;
    const rows = pulls.map(p => ({ id: p.id, code: p.code, value_micros: p.valueMicros, tier: p.tier, slug: p.slug, pulled_at: p.pulledAt, image: p.image ?? null, name: p.name ?? null }));
    const inserted = await this.db.query(`INSERT INTO cc_pulls(id,code,value_micros,tier,slug,pulled_at,image,name)
      SELECT id,code,value_micros,tier,slug,pulled_at,image,name FROM jsonb_to_recordset($1::jsonb) AS x(id text, code text, value_micros bigint, tier integer, slug text, pulled_at bigint, image text, name text)
      ON CONFLICT(id) DO NOTHING RETURNING id`, [JSON.stringify(rows)]);
    return inserted.rows.length;
  }

  /** Every offered machine's newest pulls. Returns how many were new. */
  async poll() {
    let added = 0;
    for (const m of MACHINES) added += await this.insert(await this.packs.recentPulls(m.code).catch(() => []));
    return added;
  }

  /** Older pulls under the busiest memo slugs (CC's own site and Jupiter), newest first. */
  async backfill(slugs = ['cc', 'jupiter'], pages = 10) {
    const codes = new Set(MACHINES.map(m => m.code));
    let added = 0;
    for (const slug of slugs) {
      let cursor: string | null = null;
      for (let page = 0; page < pages; page++) {
        const result = await this.packs.pullHistory(slug, cursor);
        added += await this.insert(result.pulls.filter(p => codes.has(p.code)));
        if (!result.hasMore || !result.nextCursor) break;
        cursor = result.nextCursor;
      }
    }
    return added;
  }

  /** Practice mode: the saved CC sample, shifted so its newest pull is now. */
  async seedFromSample(now = Date.now()) {
    if ((await this.db.query('SELECT 1 FROM cc_pulls LIMIT 1')).rows.length) return 0;
    let added = 0;
    for (const [code, m] of Object.entries(loadSample().machines)) {
      const span = Math.max(1, m.to - m.from);
      added += await this.insert(m.pulls.map(([value, tier, image, name], i) => ({ id: `sample:${code}:${i}`, code, valueMicros: Math.round(value * 1_000_000), tier, slug: 'sample', pulledAt: now - span + Math.round(span * i / Math.max(1, m.pulls.length - 1)), image: image ?? null, name: name ?? null })));
    }
    return added;
  }

  async configs(): Promise<(MachineConfig & { changedAt: number })[]> {
    return (await this.db.query<{ data: MachineConfig; changed_at: string }>('SELECT data, changed_at::text FROM machine_configs')).rows.map(r => ({ ...r.data, changedAt: Number(r.changed_at) }));
  }
}
