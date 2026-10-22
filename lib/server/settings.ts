import type { Database } from './db';
import { audit } from './db';
import { DEFAULT_SETTINGS, settingsSchema, type Settings } from '../shared/settings';

export class SettingsStore {
  current: Settings = DEFAULT_SETTINGS;
  constructor(readonly db: Database) {}
  async load() {
    const row = (await this.db.query<{ data: Partial<Settings> }>('SELECT data FROM settings WHERE id=1')).rows[0];
    // New settings get their defaults; stored ones win.
    this.current = { ...DEFAULT_SETTINGS, ...(row?.data ?? {}), levels: { ...DEFAULT_SETTINGS.levels, ...(row?.data?.levels ?? {}) } };
    return this.current;
  }
  async save(next: Settings, by: string) {
    const parsed = settingsSchema.parse(next);
    await this.db.query('INSERT INTO settings(id,data) VALUES(1,$1) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data', [JSON.stringify(parsed)]);
    await audit(this.db, 'settings', { by, settings: parsed });
    this.current = parsed;
    return parsed;
  }
}
