'use client';
import { mult, pct, timeAgo, usdShort, usePoll } from '@/lib/client/api';
import type { ConfigView } from '@/lib/shared/types';
import { ExternalLink, Locked } from './ui';

/** Docs numbers read from the live config, so the docs never drift from what the app does. */
function useConfig() { return usePoll<ConfigView>('/api/config', 60_000).data; }

/** One live rule value inline in a sentence, e.g. <Rule name="cap" />. */
export function Rule({ name }: { name: 'cap' | 'edge' | 'minEdge' | 'cooldown' | 'pause' | 'target' | 'minCap' | 'window' | 'ruin' | 'shortGuard' | 'shortWait' }) {
  const c = useConfig();
  if (!c) return <span className="inline-block h-4 w-10 animate-pulse rounded bg-mist align-middle" />;
  const r = c.rules;
  const text = {
    cap: `${r.capBps / 100}% of the free pool`,
    edge: `${r.edgeBps / 100}%`,
    minEdge: `${r.minEdgeBps / 100}%`,
    cooldown: `${r.cooldownLosses} losses in a row → ${r.cooldownMinutes}-minute break`,
    pause: usdShort(r.pauseThresholdUsd),
    target: usdShort(r.targetReserveUsd),
    minCap: `${r.minCapMultiple}× the pack price`,
    window: `${r.calibrationWindowDays} days`,
    ruin: `${r.ruinProbability * 100}%`,
    shortGuard: `${r.shortGuardSeconds} seconds`,
    shortWait: `${r.shortWaitMinutes} minutes`,
  }[name];
  return <strong className="font-semibold">{text}</strong>;
}

/** Each machine's buyback rate, sample size, live multipliers and last calibration. */
export function MachineFacts() {
  const c = useConfig();
  if (!c) return <div className="h-40 animate-pulse rounded-2xl bg-mist" />;
  return (
    <div className="overflow-x-auto rounded-2xl border border-line">
      <table className="w-full min-w-[700px] text-sm">
        <thead className="bg-mist text-left text-xs text-muted">
          <tr><th className="px-4 py-2.5 font-medium">Machine</th><th className="px-3 py-2.5 font-medium">CC buyback</th><th className="px-3 py-2.5 font-medium">Pulls used</th><th className="px-3 py-2.5 font-medium">Normal open</th><th className="px-3 py-2.5 font-medium">Half / Full</th><th className="px-3 py-2.5 font-medium">Short</th><th className="px-3 py-2.5 font-medium">Calibrated</th></tr>
        </thead>
        <tbody>
          {c.machines.map(m => {
            const level = (l: 'half' | 'full') => { const o = m.offers.find(x => x.level === l); return !o ? '—' : o.available ? mult(o.multiplierBps) : <Locked title={o.reason ?? ''} />; };
            return (
              <tr key={m.code} className="border-t border-line">
                <td className="px-4 py-2.5"><span className="font-semibold">${m.priceUsd}</span> <span className="text-muted">{m.name}</span></td>
                <td className="px-3 py-2.5 tabular-nums">{m.buybackPct}%</td>
                <td className="px-3 py-2.5 tabular-nums">{m.pulls.toLocaleString('en-US')}</td>
                <td className="px-3 py-2.5 tabular-nums">{m.offers[0] ? pct(m.offers[0].normalReturn) : '—'}</td>
                <td className="px-3 py-2.5 tabular-nums"><span className="inline-flex items-center gap-1.5">{level('half')} <span className="text-muted">/</span> {level('full')}</span></td>
                <td className="px-3 py-2.5 tabular-nums">{!m.short ? '—' : m.short.available ? mult(m.short.multiplierBps) : <Locked title={m.short.reason ?? ''} />}</td>
                <td className="px-3 py-2.5 text-muted">{m.calibratedAt ? timeAgo(m.calibratedAt) : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The wallets that hold the money, linked when they are real. */
export function Wallets() {
  const c = useConfig();
  if (!c) return null;
  const row = (label: string, address: string | null, note: string) => (
    <li className="flex flex-wrap items-baseline justify-between gap-2 border-t border-line py-2.5 first:border-0">
      <span><span className="font-medium">{label}</span> <span className="text-muted">· {note}</span></span>
      {address ? c.practice ? <span className="font-mono text-xs text-muted">{address.slice(0, 6)}…{address.slice(-6)} (practice)</span>
        : <ExternalLink href={`https://solscan.io/account/${address}${c.cluster ? `?cluster=${c.cluster}` : ''}`} className="font-mono text-xs">{address.slice(0, 6)}…{address.slice(-6)}</ExternalLink>
        : <span className="text-xs text-muted">not configured</span>}
    </li>
  );
  return (
    <ul className="rounded-2xl border border-line px-4">
      {row('LEV_OPS', c.opsAddress, 'takes payments, buys and opens packs, holds cards for seconds')}
      {row('LEV_POOL', c.poolAddress, 'the leverage pool: receives sellbacks and fee splits, pays bonuses and floors')}
    </ul>
  );
}
