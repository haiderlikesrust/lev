/**
 * Read-only. Measures each machine's fair leverage multipliers from CC's public pull history, and what
 * would be offered at a given pool size. Nothing is signed or stored, except the report file.
 *
 *   npm run calibrate                          # live CC data
 *   npm run calibrate -- --pages 30 --pool 50000
 *   npm run calibrate -- --sample              # the saved practice sample instead
 *
 * The running app recalibrates itself daily from the pulls its collector stores; this is for looking.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { CollectorCrypt, type FeedPull } from '../lib/server/cc/client';
import { loadSample } from '../lib/server/sample';
import { MACHINES, type MachineConfig } from '../lib/shared/machines';
import { calibrateMachine, offer } from '../lib/shared/calibration';
import { DEFAULT_SETTINGS } from '../lib/shared/settings';
import { LEVELS, LEVEL_NAME, formatMultiplier } from '../lib/shared/leverage';

const arg = (name: string, fallback: number) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? Number(process.argv[i + 1]) : fallback; };
const pages = arg('pages', 30), poolUsd = arg('pool', 50_000), useSample = process.argv.includes('--sample');
const s = DEFAULT_SETTINGS, now = Date.now();

let machines: MachineConfig[], pulls: Map<string, number[]>;
if (useSample) {
  const sample = loadSample();
  machines = Object.values(sample.machines).map(m => m.config);
  pulls = new Map(Object.entries(sample.machines).map(([code, m]) => [code, m.pulls.map(([v]) => v * 1_000_000)]));
  console.log(`Saved sample from ${sample.fetchedAt}.`);
} else {
  const cc = new CollectorCrypt(process.env.COLLECTOR_CRYPT_BASE_URL || 'https://gacha.collectorcrypt.com', process.env.COLLECTOR_CRYPT_API_KEY || '');
  machines = await cc.machines();
  const seen = new Map<string, FeedPull>(), codes = new Set(MACHINES.map(m => m.code));
  for (const slug of ['cc', 'jupiter']) {
    let cursor: string | null = null;
    for (let page = 0; page < pages; page++) {
      const result = await cc.pullHistory(slug, cursor);
      for (const p of result.pulls) if (codes.has(p.code)) seen.set(p.id, p);
      process.stdout.write(`\rReading CC pull history (${slug}): ${seen.size} pulls`);
      if (!result.hasMore || !result.nextCursor) break;
      cursor = result.nextCursor;
      await new Promise(r => setTimeout(r, 250));
    }
  }
  for (const m of MACHINES) for (const p of await cc.recentPulls(m.code)) seen.set(p.id, p);
  console.log('');
  pulls = new Map();
  for (const p of seen.values()) pulls.set(p.code, [...(pulls.get(p.code) ?? []), p.valueMicros]);
}

const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
const report = [], table = [];
for (const def of MACHINES) {
  const m = machines.find(x => x.code === def.code), values = pulls.get(def.code) ?? [];
  if (!m || !values.length) { console.log(`${def.code}: no data`); continue; }
  const ratios = values.map(v => v / (m.priceUsd * 1_000_000));
  const rows = calibrateMachine(m.code, ratios, m.buybackPct / 100, { fromMs: 0, toMs: now }, { edgesBps: [s.minEdgeBps, s.edgeBps], resamples: 2_000, seed: 1, now });
  for (const row of rows) {
    const fair = (edgeBps: number) => row.fair.find(f => f.edgeBps === edgeBps && f.capRatio === null)!.bps;
    const o = offer(row, { priceMicros: m.priceUsd * 1_000_000, freeMicros: poolUsd * 1_000_000, minValueMicros: m.tierRanges.common.start * 1_000_000, now, settings: s });
    table.push({
      machine: `$${m.priceUsd} ${def.name}`, level: LEVEL_NAME[row.level], pulls: row.n, 'normal open': pct(row.normalReturn),
      'fair @5%': formatMultiplier(fair(s.edgeBps)), 'fair @3%': formatMultiplier(fair(s.minEdgeBps)), 'data supports': formatMultiplier(row.safeBps),
      [`offer @ $${poolUsd.toLocaleString('en-US')} pool`]: o.available ? formatMultiplier(o.multiplierBps) : '—',
      'player return': pct(o.playerReturn), 'unlocks at': `$${Math.ceil(o.unlockAtMicros / 1e6).toLocaleString('en-US')}`,
    });
    report.push({ row, offer: o });
  }
}
console.table(table);
console.log(`Loss < 0.95× price, push 0.95–1.05×, win ≥ 1.05×. Levels: ${LEVELS.map(l => LEVEL_NAME[l]).join(', ')}. Returns are per pack, selling every card back to CC.`);
await mkdir('reports', { recursive: true });
await writeFile('reports/calibration.json', JSON.stringify({ generatedAt: new Date(now).toISOString(), source: useSample ? 'sample' : 'live', poolUsd, report }, null, 2));
console.log('Saved reports/calibration.json');
