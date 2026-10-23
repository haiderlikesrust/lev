'use client';
import { useState } from 'react';
import { apiGet, playLabel, playResult, timeAgo, usd, usePoll } from '@/lib/client/api';
import type { SettlementView } from '@/lib/shared/types';
import { Card, ExternalLink, Label, OutcomeBadge, TxLink } from './ui';

/** The public log of every settled pack and short, newest first, refreshing live. */
export function SettlementFeed({ practice, cluster }: { practice: boolean; cluster: string }) {
  const { data } = usePoll<SettlementView[]>('/api/settlements?limit=25', 5_000);
  const [older, setOlder] = useState<SettlementView[]>([]), [end, setEnd] = useState(false);
  const rows = [...(data ?? []), ...older.filter(o => !data?.some(d => d.orderId === o.orderId))];
  const loadOlder = async () => {
    const last = rows.at(-1); if (!last) return;
    const more = await apiGet<SettlementView[]>(`/api/settlements?limit=25&before=${last.settledAt}`);
    setOlder(o => [...o, ...more]); if (more.length < 25) setEnd(true);
  };
  return (
    <Card className="!p-0 overflow-hidden">
      <div className="flex items-center justify-between border-b border-line px-5 py-4 sm:px-6">
        <Label>Settlements · live</Label>
        <span className="flex items-center gap-1.5 text-xs text-muted"><span className="glow h-2 w-2 rounded-full bg-poke-red" />updating</span>
      </div>
      {!data ? <div className="m-5 h-32 animate-pulse rounded-2xl bg-mist" /> : !rows.length ? (
        <p className="px-6 py-10 text-center text-sm text-muted">Nothing settled yet.</p>
      ) : (
        <ul>
          {rows.map(s => (
            <li key={s.orderId} className="grid grid-cols-[auto_1fr_auto] items-center gap-x-4 gap-y-1 border-b border-line px-5 py-3 last:border-0 sm:px-6">
              <OutcomeBadge outcome={s.outcome} />
              <div className="min-w-0 text-sm">
                <div className="truncate"><span className="font-medium">{playLabel(s)}</span> <span className="text-muted">· {s.wallet}</span></div>
                <div className="truncate text-xs text-muted">{s.side === 'short' ? 'next pull: ' : ''}{s.card?.name ?? 'Card'} · worth {usd(s.valueUsd)}</div>
              </div>
              <div className="text-right text-sm tabular-nums">
                <div className="font-semibold">{playResult(s)}</div>
                <div className="text-xs text-muted">{timeAgo(s.settledAt)}</div>
              </div>
              <div className="col-span-3 flex flex-wrap gap-x-3 gap-y-0.5 pl-[3.25rem]">
                <TxLink label="payment" signature={s.links.payment} practice={practice} cluster={cluster} />
                <TxLink label="pack" signature={s.links.packPayment} practice={practice} cluster={cluster} />
                <TxLink label="sellback" signature={s.links.sellback} practice={practice} cluster={cluster} />
                <TxLink label="card" signature={s.links.nftTransfer} practice={practice} cluster={cluster} />
                <TxLink label="bonus" signature={s.links.bonus} practice={practice} cluster={cluster} />
                <TxLink label="floor" signature={s.links.floor} practice={practice} cluster={cluster} />
                <TxLink label="stake back" signature={s.links.stakeBack} practice={practice} cluster={cluster} />
                <TxLink label="short payout" signature={s.links.payout} practice={practice} cluster={cluster} />
                <TxLink label="stake to pool" signature={s.links.stakeToPool} practice={practice} cluster={cluster} />
                {s.vrfUrl && <ExternalLink href={s.vrfUrl}>VRF</ExternalLink>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {rows.length >= 25 && !end && <button onClick={() => void loadOlder()} className="w-full border-t border-line py-3 text-sm font-medium text-muted hover:bg-mist">Load older</button>}
    </Card>
  );
}
