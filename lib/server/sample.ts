import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { MachineConfig } from '../shared/machines';

/** The real CC pull sample saved by `npm run snapshot` (values and tiers only). */
export type Sample = { fetchedAt: string; machines: Record<string, { config: MachineConfig; from: number; to: number; pulls: [number, number][] }> };

let cached: Sample | null = null;
export function loadSample(): Sample {
  cached ??= JSON.parse(readFileSync(path.join(process.cwd(), 'lib/server/fixtures/cc-sample.json'), 'utf8')) as Sample;
  return cached;
}
