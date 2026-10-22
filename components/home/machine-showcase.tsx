'use client';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { useHomeData } from './home-data';
import { MachineArt } from '../machine-art';
import { Locked } from '../ui';
import { mult, usdShort } from '@/lib/client/api';

/** Every machine with CC's own art and its live Half / Full multipliers (or what it's waiting for). */
export function MachineShowcase() {
  const { config } = useHomeData();
  if (!config) return <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">{Array.from({ length: 6 }, (_, i) => <div key={i} className="h-64 animate-pulse rounded-3xl bg-white" />)}</div>;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {config.machines.map(m => {
        const live = m.offers.some(o => o.available);
        return (
          <Link key={m.code} href={`/open?machine=${m.code}`}
            className="group flex flex-col overflow-hidden rounded-3xl border border-line bg-white shadow-card transition hover:-translate-y-1 hover:shadow-lift">
            <div className="relative flex h-36 items-end justify-center bg-gradient-to-b from-mist to-white pt-3">
              <MachineArt image={m.image} name={m.name} className="h-32 w-28 transition duration-300 group-hover:scale-105" />
              {!live && <span className="absolute right-2 top-2 rounded-full bg-white/90 px-2 py-0.5 shadow-sm"><Locked /></span>}
            </div>
            <div className="flex flex-1 flex-col p-3.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-display text-xl font-extrabold">${m.priceUsd}</span>
                <span className="truncate text-xs text-muted">{m.name}</span>
              </div>
              <div className="mt-2.5 space-y-1.5 text-xs">
                {m.offers.map(o => (
                  <div key={o.level} className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-muted"><span className={`h-1.5 w-1.5 rounded-full ${o.level === 'full' ? 'bg-poke-red' : 'bg-poke-blue'}`} />{o.level === 'full' ? 'Full' : 'Half'}</span>
                    {o.available ? <span className="font-bold tabular-nums">{mult(o.multiplierBps)}</span> : <Locked>{o.reason?.startsWith('Unlocks') ? usdShort(o.unlockAtUsd) : 'data'}</Locked>}
                  </div>
                ))}
              </div>
              <span className="mt-auto flex items-center gap-1 pt-3 text-xs font-semibold text-poke-red opacity-0 transition group-hover:opacity-100">Open <ArrowRight size={13} /></span>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
