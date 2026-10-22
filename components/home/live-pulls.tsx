'use client';
import Link from 'next/link';
import { Radio } from 'lucide-react';
import { useHomeData } from './home-data';
import { CardPhoto } from '../machine-art';
import { mult, timeAgo, usd } from '@/lib/client/api';
import type { SettlementView } from '@/lib/shared/types';

const RESULT: Record<SettlementView['outcome'], (s: SettlementView) => { text: string; tone: string }> = {
  win: s => ({ text: `+${usd(s.bonusUsd)} bonus`, tone: 'text-win' }),
  push: () => ({ text: 'got the card', tone: 'text-muted' }),
  loss: s => ({ text: s.floorUsd > 0 ? `${usd(s.floorUsd)} floor` : 'sold back', tone: 'text-loss' }),
};

/** A slow marquee of the latest leverage packs settled on our platform, every outcome, with the card's photo. */
export function LivePulls() {
  const { latest } = useHomeData();
  const head = (
    <div className="flex items-center gap-2 border-b border-line px-5 py-3 text-sm">
      <Radio size={16} className="glow text-poke-red" />
      <span className="font-semibold">Live pulls</span>
      <span className="text-muted">· leverage packs settled here, wins and losses alike</span>
      <Link href="/leaderboard" className="ml-auto hidden text-xs font-semibold text-poke-blue hover:underline sm:inline">Leaderboard</Link>
    </div>
  );
  if (!latest) return <section className="h-32 animate-pulse rounded-3xl bg-white shadow-card" />;
  if (!latest.length) return (
    <section className="overflow-hidden rounded-3xl border border-line bg-white shadow-card">
      {head}
      <p className="px-5 py-8 text-center text-sm text-muted">No leverage packs settled yet. They&apos;ll appear here the moment they do.</p>
    </section>
  );
  // Few packs: show them as a row; enough to fill the strip: loop them slowly.
  const loop = latest.length >= 5, row = loop ? [...latest, ...latest] : latest;
  return (
    <section className="overflow-hidden rounded-3xl border border-line bg-white shadow-card">
      {head}
      <div className="relative">
        {loop && <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-12 bg-gradient-to-r from-white to-transparent" />}
        {loop && <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-12 bg-gradient-to-l from-white to-transparent" />}
        <ul className={`flex gap-3 px-3 py-3 ${loop ? 'marquee w-max' : 'overflow-x-auto'}`}>
          {row.map((s, i) => {
            const r = RESULT[s.outcome](s);
            return (
              <li key={`${s.orderId}-${i}`} className="flex w-64 shrink-0 items-center gap-3 rounded-2xl bg-mist p-2 pr-3">
                <CardPhoto image={s.card?.image} name={s.card?.name} className="h-16 w-12 shrink-0 bg-white" />
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{s.card?.name ?? 'Card'}</div>
                  <div className="truncate text-xs text-muted">${s.priceUsd} {s.machineName} · {s.level === 'full' ? 'Full' : 'Half'} {mult(s.multiplierBps)}</div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs"><span className={`font-semibold ${r.tone}`}>{r.text}</span><span className="text-muted">{timeAgo(s.settledAt)}</span></div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
