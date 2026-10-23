'use client';
import Link from 'next/link';
import { usePoll, mult, pct, usdShort } from '@/lib/client/api';
import { LEVEL_NAME } from '@/lib/shared/leverage';
import type { ConfigView } from '@/lib/shared/types';
import { HpBar } from './hp-bar';
import { Card, Label, Locked } from './ui';

/** Every machine's live multipliers (or why a level is still locked), plus the pool's HP. */
export function LiveLevels() {
  const { data, error } = usePoll<ConfigView>('/api/config', 30_000);
  if (error) return <Card><p className="text-sm text-loss">{error}</p></Card>;
  if (!data) return <Card><div className="h-40 animate-pulse rounded-2xl bg-mist" /></Card>;
  return (
    <Card className="!p-0 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4 sm:px-6">
        <div>
          <Label>Live now</Label>
          <p className="mt-1 text-sm text-muted">Multipliers are recalculated daily from real Collector Crypt pulls.</p>
        </div>
        <div className="w-full sm:w-72"><HpBar bps={data.pool.healthBps} paused={!!data.pool.pauseReason} /></div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="px-5 py-3 font-medium sm:px-6">Machine</th>
              <th className="px-3 py-3 font-medium">Normal open</th>
              <th className="px-3 py-3 font-medium">{LEVEL_NAME.half}</th>
              <th className="px-3 py-3 font-medium">{LEVEL_NAME.full}</th>
              <th className="px-3 py-3 font-medium">Short</th>
            </tr>
          </thead>
          <tbody>
            {data.machines.map(m => (
              <tr key={m.code} className="border-t border-line">
                <td className="px-5 py-3 sm:px-6"><span className="font-semibold">${m.priceUsd}</span> <span className="text-muted">{m.name}</span></td>
                <td className="px-3 py-3 tabular-nums text-muted">{m.offers[0] ? pct(m.offers[0].normalReturn) : '—'}</td>
                {(['half', 'full'] as const).map(level => {
                  const o = m.offers.find(x => x.level === level);
                  if (!o) return <td key={level} className="px-3 py-3 text-muted">—</td>;
                  return (
                    <td key={level} className="px-3 py-3">
                      {o.available
                        ? <Link href={`/open?machine=${m.code}&level=${level}`} className="font-semibold tabular-nums text-ink hover:text-poke-blue">{mult(o.multiplierBps)} <span className="font-normal text-muted">· avg {pct(o.playerReturn)}</span></Link>
                        : <Locked title={o.reason ?? ''}>{o.reason?.startsWith('Unlocks') ? `at ${usdShort(o.unlockAtUsd)} pool` : 'collecting data'}</Locked>}
                    </td>
                  );
                })}
                <td className="px-3 py-3">
                  {!m.short ? <span className="text-muted">—</span> : m.short.available
                    ? <Link href={`/open?machine=${m.code}&side=short`} className="font-semibold tabular-nums text-ink hover:text-poke-blue">{mult(m.short.multiplierBps)} <span className="font-normal text-muted">· wins {Math.round(m.short.pWin * 100)}%</span></Link>
                    : <Locked title={m.short.reason ?? ''}>{m.short.reason?.startsWith('Unlocks') ? `at ${usdShort(m.short.unlockAtUsd)} pool` : 'collecting data'}</Locked>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-line px-5 py-3 text-xs text-muted sm:px-6">
        “avg” is the average result per pack as a share of the pack price, selling every card back to Collector Crypt. It is negative, like a normal open: on average you get back less than you pay.
      </p>
    </Card>
  );
}
