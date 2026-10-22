'use client';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Coins, Gift, Layers, Zap } from 'lucide-react';
import { useCountUp, useHomeData } from './home-data';
import { mult } from '@/lib/client/api';

const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

/** Four live numbers with count-up, each with a small visual instead of a bare figure. */
export function StatsBand() {
  const { config, stats } = useHomeData();
  const pool = config?.pool, t = stats?.totals;
  const offers = config?.machines.flatMap(m => m.offers) ?? [], live = offers.filter(o => o.available);
  const best = live.reduce((b, o) => Math.max(b, o.multiplierBps), 0);
  return (
    <section className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
      <Tile icon={<Coins size={18} />} tone="bg-poke-yellow/25 text-poke-yellow-dark" label="Pool balance" value={pool?.balanceUsd ?? 0} format={money} href="/pool">
        <div className="h-2 overflow-hidden rounded-full bg-mist"><div className="h-full rounded-full bg-gradient-to-r from-uncommon to-poke-yellow transition-[width] duration-1000" style={{ width: `${(pool?.healthBps ?? 0) / 100}%` }} /></div>
        <div className="mt-1.5 text-xs text-muted">Pool HP {Math.round((pool?.healthBps ?? 0) / 100)}%</div>
      </Tile>
      <Tile icon={<Gift size={18} />} tone="bg-poke-red/10 text-poke-red" label="Bonuses paid" value={t?.bonusesUsd ?? 0} format={money} href="/leaderboard">
        <div className="text-xs text-muted">across {t?.wins ?? 0} winning packs · biggest {money(t?.biggestBonusUsd ?? 0)}</div>
      </Tile>
      <Tile icon={<Layers size={18} />} tone="bg-poke-blue/10 text-poke-blue" label="Packs settled" value={t?.packs ?? 0} format={n => Math.round(n).toLocaleString('en-US')} href="/pool">
        <OutcomeBar wins={t?.wins ?? 0} pushes={t?.pushes ?? 0} losses={t?.losses ?? 0} />
      </Tile>
      <Tile icon={<Zap size={18} />} tone="bg-epic/10 text-epic" label="Levels live" value={live.length} format={n => `${Math.round(n)}/${offers.length || 12}`} href="/open">
        <div className="text-xs text-muted">{best ? <>up to <span className="font-semibold text-ink">{mult(best)}</span> right now</> : 'unlocking as the pool grows'}</div>
      </Tile>
    </section>
  );
}

function Tile({ icon, tone, label, value, format, href, children }: { icon: ReactNode; tone: string; label: string; value: number; format: (n: number) => string; href: string; children: ReactNode }) {
  const shown = useCountUp(value);
  return (
    <Link href={href} className="group rounded-3xl border border-line bg-white p-4 shadow-card transition hover:-translate-y-0.5 hover:shadow-lift sm:p-5">
      <div className="flex items-center gap-2.5">
        <span className={`inline-flex h-9 w-9 items-center justify-center rounded-xl ${tone}`}>{icon}</span>
        <span className="text-sm font-medium text-muted">{label}</span>
      </div>
      <div className="mt-3 font-display text-3xl font-extrabold tabular-nums sm:text-4xl">{format(shown)}</div>
      <div className="mt-2">{children}</div>
    </Link>
  );
}

/** Wins, pushes and losses as one stacked bar. */
export function OutcomeBar({ wins, pushes, losses }: { wins: number; pushes: number; losses: number }) {
  const total = wins + pushes + losses || 1;
  return (
    <div>
      <div className="flex h-2 overflow-hidden rounded-full bg-mist">
        <span className="bg-poke-yellow" style={{ width: `${wins / total * 100}%` }} />
        <span className="bg-push" style={{ width: `${pushes / total * 100}%` }} />
        <span className="bg-poke-red" style={{ width: `${losses / total * 100}%` }} />
      </div>
      <div className="mt-1.5 flex gap-3 text-xs text-muted"><span>{wins} win</span><span>{pushes} push</span><span>{losses} loss</span></div>
    </div>
  );
}
