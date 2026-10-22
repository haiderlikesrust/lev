/**
 * Read-only. Saves a sample of real CC pulls (value, tier, card photo and name; no wallets) and the machine configs
 * to lib/server/fixtures/cc-sample.json. Practice mode draws its packs and its calibration from it, so the
 * practice multipliers match what real data gives.
 *
 *   npm run snapshot -- --pages 30
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { CollectorCrypt, type FeedPull } from '../lib/server/cc/client';
import { MACHINES } from '../lib/shared/machines';

const arg = (name: string, fallback: number) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? Number(process.argv[i + 1]) : fallback; };
const pages = arg('pages', 30);
const cc = new CollectorCrypt(process.env.COLLECTOR_CRYPT_BASE_URL || 'https://gacha.collectorcrypt.com', process.env.COLLECTOR_CRYPT_API_KEY || '');
const codes = new Set(MACHINES.map(m => m.code)), pulls = new Map<string, FeedPull>();

for (const slug of ['cc', 'jupiter']) {
  let cursor: string | null = null;
  for (let page = 0; page < pages; page++) {
    const result = await cc.pullHistory(slug, cursor);
    for (const p of result.pulls) if (codes.has(p.code)) pulls.set(p.id, p);
    process.stdout.write(`\r${slug}: page ${page + 1}, ${pulls.size} pulls`);
    if (!result.hasMore || !result.nextCursor) break;
    cursor = result.nextCursor;
    await new Promise(r => setTimeout(r, 250));
  }
  console.log('');
}
for (const m of MACHINES) for (const p of await cc.recentPulls(m.code)) pulls.set(p.id, p);

const machines = await cc.machines(), all = [...pulls.values()];
const snapshot = {
  fetchedAt: new Date().toISOString(),
  source: 'GET /api/getWinners (slugs cc, jupiter) + GET /api/getAllWinners + GET /api/machines',
  machines: Object.fromEntries(machines.map(m => {
    const own = all.filter(p => p.code === m.code);
    return [m.code, { config: m, from: Math.min(...own.map(p => p.pulledAt)), to: Math.max(...own.map(p => p.pulledAt)), pulls: own.map(p => [Math.round(p.valueMicros / 10_000) / 100, p.tier ?? 0, p.image ?? null, p.name ?? null]) }];
  })),
};
await mkdir('lib/server/fixtures', { recursive: true });
await writeFile('lib/server/fixtures/cc-sample.json', JSON.stringify(snapshot));
console.table(machines.map(m => ({ code: m.code, price: m.priceUsd, buyback: m.buybackPct, pulls: snapshot.machines[m.code].pulls.length })));
