import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { MachineConfig } from '../shared/machines';

/** One saved pull: insured value (USD), CC prize tier, card photo URL and card name. */
export type SamplePull = [value: number, tier: number, image?: string | null, name?: string | null];
/** The real CC pull sample saved by `npm run snapshot` (no wallets). */
export type Sample = { fetchedAt: string; machines: Record<string, { config: MachineConfig; from: number; to: number; pulls: SamplePull[] }> };

let cached: Sample | null = null;
export function loadSample(): Sample {
  cached ??= JSON.parse(readFileSync(path.join(process.cwd(), 'lib/server/fixtures/cc-sample.json'), 'utf8')) as Sample;
  return cached;
}
