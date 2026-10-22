'use client';
import { useState } from 'react';
import { apiPost, timeAgo, usd, usdShort, usePoll } from '@/lib/client/api';
import { Button, Card, ExternalLink, Label, Stat, TxLink } from '@/components/ui';
import { HpBar } from '@/components/hp-bar';
import { SettlementFeed } from '@/components/settlement-feed';
import { LiveLevels } from '@/components/live-levels';
import type { ConfigView, PoolView as Pool } from '@/lib/shared/types';

export function PoolView() {
  const { data: config } = usePoll<ConfigView>('/api/config', 0);
  const { data: pool, setData } = usePoll<Pool>('/api/pool', 5_000);
  const [busy, setBusy] = useState(false);
  const practice = config?.practice ?? true, cluster = config?.cluster ?? '';
  const simulate = async (amount: number) => { setBusy(true); try { setData(await apiPost<Pool>('/api/practice/fee-split', { usd: amount })); } finally { setBusy(false); } };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">The leverage pool</h1>
        <p className="mt-1 max-w-2xl text-muted">Losing cards are sold back to Collector Crypt and the money lands here; winners&apos; bonuses are paid from here. It&apos;s a separate wallet from Pullback&apos;s loss coverage, so leverage can never touch that money.</p>
      </div>

      {!pool ? <div className="h-48 animate-pulse rounded-3xl bg-mist" /> : (
        <>
          <Card>
            <HpBar bps={pool.healthBps} paused={!!pool.pauseReason} />
            {pool.pauseReason && <p className="mt-3 rounded-2xl bg-poke-red/10 px-4 py-3 text-sm text-loss">{pool.pauseReason}</p>}
            <div className="mt-6 grid grid-cols-2 gap-6 md:grid-cols-4">
              <Stat label="Balance" value={usdShort(pool.balanceUsd)} hint={config?.poolAddress ? <TxAddress address={config.poolAddress} practice={practice} cluster={cluster} /> : null} />
              <Stat label="Free" value={usdShort(pool.freeUsd)} hint="after packs in progress" />
              <Stat label="Held for packs" value={usdShort(pool.reservedUsd)} hint="their top bonuses" />
              <Stat label="Health target" value={usdShort(pool.targetUsd)} />
            </div>
          </Card>

          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Card><Stat label="Bonuses paid" value={usdShort(pool.totals.bonusesUsd)} hint={`${pool.totals.wins} wins`} /></Card>
            <Card><Stat label="Sellback collected" value={usdShort(pool.totals.sellbackUsd)} hint={`${pool.totals.losses} losses`} /></Card>
            <Card><Stat label="Half-risk floors paid" value={usdShort(pool.totals.floorsUsd)} /></Card>
            <Card><Stat label="From creator fees" value={usdShort(pool.totals.feeSplitsUsd)} hint="15% fee split" /></Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
            <SettlementFeed practice={practice} cluster={cluster} />
            <div className="space-y-6">
              <Card>
                <Label>Fee splits in</Label>
                <p className="mt-1 text-sm text-muted">After each creator-fee swap, Pullback sends 15% here until this pool reaches its target; then the share stays with Pullback.</p>
                <ul className="mt-4 space-y-2">
                  {pool.feeSplits.length ? pool.feeSplits.map(f => (
                    <li key={f.signature} className="flex items-center justify-between text-sm">
                      <span className="tabular-nums font-medium">+{usd(f.amountUsd)}</span>
                      <span className="flex items-center gap-3 text-xs text-muted">{timeAgo(f.receivedAt)} <TxLink label="tx" signature={f.signature} practice={practice} cluster={cluster} /></span>
                    </li>
                  )) : <li className="text-sm text-muted">None yet.</li>}
                </ul>
                {practice && (
                  <div className="mt-5 border-t border-line pt-4">
                    <div className="text-xs text-muted">Practice: simulate a Pullback fee split</div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {[1_000, 5_000, 25_000].map(a => <Button key={a} variant="ghost" disabled={busy} onClick={() => void simulate(a)}>+{usdShort(a)}</Button>)}
                    </div>
                  </div>
                )}
              </Card>
              <Card>
                <Label>Settled packs</Label>
                <div className="mt-3 grid grid-cols-3 gap-4">
                  <Stat label="Wins" value={pool.totals.wins} />
                  <Stat label="Pushes" value={pool.totals.pushes} />
                  <Stat label="Losses" value={pool.totals.losses} />
                </div>
              </Card>
            </div>
          </div>
        </>
      )}

      <LiveLevels />
    </div>
  );
}

function TxAddress({ address, practice, cluster }: { address: string; practice: boolean; cluster: string }) {
  const short = `${address.slice(0, 4)}…${address.slice(-4)}`;
  if (practice) return <span className="font-mono">{short}</span>;
  return <ExternalLink href={`https://solscan.io/account/${address}${cluster ? `?cluster=${cluster}` : ''}`} className="font-mono">{short}</ExternalLink>;
}
