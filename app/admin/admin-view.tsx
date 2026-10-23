'use client';
import { useState } from 'react';
import { Flame } from 'lucide-react';
import { useSession } from '@/components/providers';
import { Button, Card, Label } from '@/components/ui';
import { apiPost, mult, timeAgo, usePoll } from '@/lib/client/api';
import { LEVELS, LEVEL_NAME } from '@/lib/shared/leverage';
import { MACHINES } from '@/lib/shared/machines';
import type { Settings } from '@/lib/shared/settings';
import type { OrderView } from '@/lib/shared/types';

type Buyback = { heldUsd: number; totalHeldUsd: number; mintSet: boolean; burns: { id: string; status: string; usdcUsd: number; tokens: string | null; swapSignature: string | null; burnSignature: string | null; createdAt: number; error: string | null }[] };
type AdminData = { settings: Settings; review: (OrderView & { error: string | null })[]; audit: { event: string; data: { error?: string; id?: string } | null; at: number }[]; buyback: Buyback };

const FIELDS: { key: keyof Settings; label: string; hint: string }[] = [
  { key: 'edgeBps', label: 'Launch pool edge (bps)', hint: '500 = 5% of each pack price' },
  { key: 'minEdgeBps', label: 'Lower pool edge (bps)', hint: 'used once a machine’s data supports it' },
  { key: 'capBps', label: 'Bonus cap (bps of free pool)', hint: '1000 = 10% of the free pool per pack' },
  { key: 'minCapMultiple', label: 'Min cap (× pack price)', hint: 'a level opens only with at least this cap' },
  { key: 'pauseThresholdUsd', label: 'Auto-pause below ($)', hint: 'free pool' },
  { key: 'targetReserveUsd', label: 'Health target ($)', hint: '100% on the HP bar' },
  { key: 'cooldownLosses', label: 'Cool-down after losses in a row', hint: '0 = off' },
  { key: 'cooldownMinutes', label: 'Cool-down minutes', hint: '' },
  { key: 'perWalletDailyPacks', label: 'Packs per wallet / 24h', hint: '0 = no limit' },
  { key: 'perWalletDailyUsd', label: 'Spend per wallet / 24h ($)', hint: '0 = no limit' },
  { key: 'globalDailyUsd', label: 'Total volume / 24h ($)', hint: '0 = no limit' },
  { key: 'calibrationWindowDays', label: 'Calibration window (days)', hint: '' },
  { key: 'minSamples', label: 'Min pulls per machine', hint: '' },
  { key: 'shortGuardSeconds', label: 'Short guard (seconds)', hint: 'a short rides pulls CC stamps this long after payment' },
  { key: 'shortWaitMinutes', label: 'Short max wait (minutes)', hint: 'refunded in full if no pull comes' },
  { key: 'feePoolShareBps', label: 'Creator fees to pool (bps)', hint: '8500 = 85%; the rest is held for your buyback' },
  { key: 'buybackSlippageBps', label: 'Buyback slippage (bps)', hint: '100 = 1%' },
];

export function AdminView() {
  const { me } = useSession();
  const owner = !!me?.wallet && me.owner;
  const { data, setData, error: loadError } = usePoll<AdminData>(owner ? '/api/admin' : null, 15_000);
  const [edited, setDraft] = useState<Settings | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  // The form shows the saved settings until the owner edits something.
  const draft = edited ?? data?.settings ?? null;

  if (!owner) return <Card className="mx-auto max-w-md text-center"><p className="text-sm text-muted">Sign in with the owner wallet to use this page.</p></Card>;
  if (loadError) return <Card><p className="text-sm text-loss">{loadError}</p></Card>;
  if (!data || !draft) return <div className="h-96 animate-pulse rounded-3xl bg-mist" />;

  const act = async (body: object) => {
    setBusy(true); setError(null);
    try { const next = await apiPost<{ settings: Settings; review: AdminData['review']; buyback: Buyback }>('/api/admin', body); setData({ ...data, ...next }); setDraft(next.settings); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-bold tracking-tight">Admin</h1>
        <div className="flex gap-2">
          <Button variant={draft.paused ? 'primary' : 'red'} disabled={busy} onClick={() => void act({ action: 'settings', settings: { ...draft, paused: !draft.paused } })}>{draft.paused ? 'Resume leverage packs' : 'Pause leverage packs'}</Button>
          <Button variant="ghost" disabled={busy} onClick={() => void act({ action: 'recalibrate' })}>Recalibrate now</Button>
        </div>
      </div>
      {error && <p className="text-sm text-loss">{error}</p>}

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <Label>Coin buyback &amp; burn · owner only</Label>
            <p className="mt-1 max-w-xl text-sm text-muted">{100 - draft.feePoolShareBps / 100}% of incoming creator fees is held here instead of joining the pool. It only moves when you click: LEV_POOL swaps it into the coin on Jupiter and burns it.</p>
          </div>
          <div className="text-right">
            <div className="text-3xl font-bold tabular-nums">${data.buyback.heldUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}</div>
            <div className="text-xs text-muted">held now · ${data.buyback.totalHeldUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })} all time</div>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button variant="red" disabled={busy || data.buyback.heldUsd < 1 || !data.buyback.mintSet || data.buyback.burns.some(b => b.status === 'pending')}
            onClick={() => { if (confirm(`Buy back and burn with $${data.buyback.heldUsd.toFixed(2)}?`)) void act({ action: 'buyback' }); }}>
            <Flame size={16} /> Buy back &amp; burn
          </Button>
          {!data.buyback.mintSet && <span className="text-xs text-loss">Set MEMECOIN_MINT and JUPITER_API_KEY first.</span>}
        </div>
        {data.buyback.burns.length > 0 && (
          <ul className="mt-4 divide-y divide-line text-sm">
            {data.buyback.burns.map(b => (
              <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <span className="tabular-nums">${b.usdcUsd.toFixed(2)} · <span className={b.status === 'done' ? 'text-ink' : b.status === 'review' ? 'text-loss' : 'text-muted'}>{b.status}</span>{b.tokens ? ` · ${Number(b.tokens).toLocaleString('en-US')} base units burned` : ''}</span>
                <span className="flex items-center gap-3 text-xs text-muted">{timeAgo(b.createdAt)}{b.error && <span className="text-loss">{b.error}</span>}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <Label>Packs needing review ({data.review.length})</Label>
        {!data.review.length ? <p className="mt-3 text-sm text-muted">Nothing waiting.</p> : (
          <ul className="mt-3 divide-y divide-line">
            {data.review.map(o => (
              <li key={o.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                <div className="min-w-0">
                  <div className="font-medium">${o.priceUsd} {o.machineName} · {o.side === 'short' ? 'Short' : LEVEL_NAME[o.level]} {mult(o.multiplierBps)} · <span className="font-mono text-xs">{o.id.slice(0, 8)}</span></div>
                  <div className="text-xs text-loss">{o.error}</div>
                </div>
                <div className="flex gap-2">
                  <Button variant="ghost" disabled={busy} onClick={() => void act({ action: 'retry', id: o.id })}>Retry</Button>
                  <Button variant="ghost" disabled={busy} onClick={() => void act({ action: 'refund', id: o.id })}>Refund</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <Label>Settings</Label>
        <p className="mt-1 text-sm text-muted">Player limits default to off. The pool is protected by the bonus cap, the unlock rule and the auto-pause. Changing an edge recalibrates every machine.</p>
        <form className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" onSubmit={e => { e.preventDefault(); void act({ action: 'settings', settings: draft }); }}>
          {FIELDS.map(f => (
            <label key={f.key} className="text-sm">
              <span className="font-medium">{f.label}</span>
              <input type="number" step="any" value={draft[f.key] as number} onChange={e => setDraft({ ...draft, [f.key]: Number(e.target.value) })}
                className="mt-1 h-10 w-full rounded-xl border border-line px-3 tabular-nums outline-none focus:border-ink" />
              {f.hint && <span className="mt-0.5 block text-xs text-muted">{f.hint}</span>}
            </label>
          ))}
          <div className="text-sm sm:col-span-2 lg:col-span-3">
            <div className="font-medium">Levels</div>
            <div className="mt-2 flex flex-wrap gap-4">
              {LEVELS.map(l => (
                <label key={l} className="flex items-center gap-2"><input type="checkbox" checked={draft.levels[l]} onChange={e => setDraft({ ...draft, levels: { ...draft.levels, [l]: e.target.checked } })} className="accent-ink" />{LEVEL_NAME[l]}</label>
              ))}
              <label className="flex items-center gap-2"><input type="checkbox" checked={draft.shortsEnabled} onChange={e => setDraft({ ...draft, shortsEnabled: e.target.checked })} className="accent-ink" />Short</label>
            </div>
            <div className="mt-4 font-medium">Machines</div>
            <div className="mt-2 flex flex-wrap gap-4">
              {MACHINES.map(m => (
                <label key={m.code} className="flex items-center gap-2"><input type="checkbox" checked={!draft.disabledMachines.includes(m.code)} onChange={e => setDraft({ ...draft, disabledMachines: e.target.checked ? draft.disabledMachines.filter(c => c !== m.code) : [...draft.disabledMachines, m.code] })} className="accent-ink" />${m.priceUsd} {m.name}</label>
              ))}
            </div>
          </div>
          <div className="sm:col-span-2 lg:col-span-3"><Button type="submit" disabled={busy}>Save settings</Button></div>
        </form>
      </Card>

      <Card>
        <Label>Recent problems</Label>
        {!data.audit.length ? <p className="mt-3 text-sm text-muted">None.</p> : (
          <ul className="mt-3 space-y-2 text-xs">
            {data.audit.map((a, i) => <li key={i} className="flex gap-3"><span className="w-16 shrink-0 text-muted">{timeAgo(a.at)}</span><span className="font-medium">{a.event}</span><span className="truncate text-muted">{a.data?.error ?? a.data?.id ?? ''}</span></li>)}
          </ul>
        )}
      </Card>
    </div>
  );
}
