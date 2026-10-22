import type { Database } from './db';
import type { SettingsStore } from './settings';
import { httpError } from './redact';
import type { PlayerLimitView } from '../shared/types';

const DAY = 86_400_000;
const usd = (micros: number) => `$${(micros / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const wait = (ms: number) => { const m = Math.max(1, Math.ceil(ms / 60_000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`; };

export type { PlayerLimitView };

/**
 * Responsible play and the (default-off) volume limits. Every check is server-side.
 * - Cool-down: after `cooldownLosses` losses in a row, the wallet waits `cooldownMinutes`.
 * - A player's own daily loss limit: lowering it is instant, raising or removing it takes 24 hours.
 * - Per-wallet and global 24-hour limits: 0 means off (the default, like Pullback).
 */
export class Limits {
  constructor(readonly db: Database, readonly settings: SettingsStore) {}

  async cooldownUntil(wallet: string, now = Date.now()) {
    const s = this.settings.current;
    if (s.cooldownLosses <= 0 || s.cooldownMinutes <= 0) return null;
    const recent = (await this.db.query<{ outcome: string; settled_at: string }>(
      'SELECT outcome, settled_at::text FROM settlements WHERE wallet=$1 ORDER BY settled_at DESC LIMIT $2', [wallet, s.cooldownLosses])).rows;
    if (recent.length < s.cooldownLosses || recent.some(r => r.outcome !== 'loss')) return null;
    const until = Number(recent[0].settled_at) + s.cooldownMinutes * 60_000;
    return until > now ? until : null;
  }

  /** What losing packs cost this wallet in the last 24 hours (pack price minus any floor paid back). */
  async lossLast24h(wallet: string, now = Date.now()) {
    return Number((await this.db.query<{ total: string }>(
      "SELECT COALESCE(SUM(price_micros - floor_micros),0)::text AS total FROM settlements WHERE wallet=$1 AND outcome='loss' AND settled_at >= $2", [wallet, now - DAY])).rows[0].total);
  }

  /** The wallet's own limit, applying a pending raise once its 24 hours are up. */
  async ownLimit(wallet: string, now = Date.now()) {
    const row = (await this.db.query<{ daily_loss_limit_micros: string | null; pending_limit_micros: string | null; pending_at: string | null }>(
      'SELECT daily_loss_limit_micros::text, pending_limit_micros::text, pending_at::text FROM player_limits WHERE wallet=$1', [wallet])).rows[0];
    if (!row) return { limit: null as number | null, pending: null as { limit: number | null; at: number } | null };
    const toNumber = (v: string | null) => v === null ? null : Number(v);
    if (row.pending_at !== null && Number(row.pending_at) <= now) {
      await this.db.query('UPDATE player_limits SET daily_loss_limit_micros=pending_limit_micros, pending_limit_micros=NULL, pending_at=NULL WHERE wallet=$1', [wallet]);
      return { limit: toNumber(row.pending_limit_micros), pending: null };
    }
    return { limit: toNumber(row.daily_loss_limit_micros), pending: row.pending_at === null ? null : { limit: toNumber(row.pending_limit_micros), at: Number(row.pending_at) } };
  }

  /** Leverage packs are opt-in per wallet, on top of the HIGH RISK confirmation on every pack. */
  async optedIn(wallet: string) {
    return !!(await this.db.query('SELECT 1 FROM player_limits WHERE wallet=$1 AND opted_in_at IS NOT NULL', [wallet])).rows.length;
  }
  async setOptIn(wallet: string, on: boolean, now = Date.now()) {
    await this.db.query('INSERT INTO player_limits(wallet,opted_in_at) VALUES($1,$2) ON CONFLICT(wallet) DO UPDATE SET opted_in_at=EXCLUDED.opted_in_at', [wallet, on ? now : null]);
  }

  /** null removes the limit. Lower is immediate; higher or none waits 24 hours. */
  async setOwnLimit(wallet: string, micros: number | null, now = Date.now()) {
    if (micros !== null && (!Number.isSafeInteger(micros) || micros < 0)) throw httpError(400, 'Use a whole number of dollars.');
    const current = (await this.ownLimit(wallet, now)).limit;
    const immediate = current === null ? micros !== null : micros !== null && micros <= current;
    await this.db.query(immediate
      ? 'INSERT INTO player_limits(wallet,daily_loss_limit_micros,pending_limit_micros,pending_at) VALUES($1,$2,NULL,NULL) ON CONFLICT(wallet) DO UPDATE SET daily_loss_limit_micros=EXCLUDED.daily_loss_limit_micros, pending_limit_micros=NULL, pending_at=NULL'
      : 'INSERT INTO player_limits(wallet,daily_loss_limit_micros,pending_limit_micros,pending_at) VALUES($1,NULL,$2,$3) ON CONFLICT(wallet) DO UPDATE SET pending_limit_micros=EXCLUDED.pending_limit_micros, pending_at=EXCLUDED.pending_at',
      immediate ? [wallet, micros] : [wallet, micros, now + DAY]);
    return this.view(wallet, now);
  }

  async view(wallet: string, now = Date.now()): Promise<PlayerLimitView> {
    const own = await this.ownLimit(wallet, now);
    return {
      dailyLossLimitUsd: own.limit === null ? null : own.limit / 1_000_000,
      pending: own.pending ? { dailyLossLimitUsd: own.pending.limit === null ? null : own.pending.limit / 1_000_000, at: own.pending.at } : null,
      lossLast24hUsd: (await this.lossLast24h(wallet, now)) / 1_000_000,
      cooldownUntil: await this.cooldownUntil(wallet, now),
    };
  }

  /** Throws a plain-language reason when this wallet can't start a pack that could lose `maxLossMicros`. */
  async check(wallet: string, priceMicros: number, maxLossMicros: number, now = Date.now()) {
    const s = this.settings.current;
    const until = await this.cooldownUntil(wallet, now);
    if (until) throw httpError(429, `${s.cooldownLosses} losses in a row. Take a break: leverage packs open again for this wallet in ${wait(until - now)}.`);
    const own = (await this.ownLimit(wallet, now)).limit;
    if (own !== null) {
      const left = own - await this.lossLast24h(wallet, now);
      if (left < maxLossMicros) throw httpError(429, `This pack could take you past your own daily loss limit (${usd(Math.max(0, left))} left in the last 24 hours).`);
    }
    if (s.perWalletDailyPacks > 0 || s.perWalletDailyUsd > 0) {
      const used = (await this.db.query<{ n: number; total: string }>(
        "SELECT COUNT(*)::int AS n, COALESCE(SUM(price_micros),0)::text AS total FROM orders WHERE wallet=$1 AND payment_signature IS NOT NULL AND status NOT IN ('refunded','expired') AND created_at >= $2", [wallet, now - DAY])).rows[0];
      if (s.perWalletDailyPacks > 0 && used.n >= s.perWalletDailyPacks) throw httpError(429, `This wallet has opened its ${s.perWalletDailyPacks} leverage packs for the last 24 hours.`);
      if (s.perWalletDailyUsd > 0 && Number(used.total) + priceMicros > s.perWalletDailyUsd * 1_000_000) throw httpError(429, `This pack would pass the ${usd(s.perWalletDailyUsd * 1_000_000)} daily limit per wallet.`);
    }
    if (s.globalDailyUsd > 0) {
      const total = Number((await this.db.query<{ total: string }>(
        "SELECT COALESCE(SUM(price_micros),0)::text AS total FROM orders WHERE payment_signature IS NOT NULL AND status NOT IN ('refunded','expired') AND created_at >= $1", [now - DAY])).rows[0].total);
      if (total + priceMicros > s.globalDailyUsd * 1_000_000) throw httpError(429, 'Today\'s leverage volume is full. Please come back tomorrow.');
    }
  }
}
