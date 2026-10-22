'use client';
import { useState } from 'react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { useWallet } from '@solana/wallet-adapter-react';
import { useSession } from '@/components/providers';
import { Button, Card, ExternalLink, Label, OutcomeBadge, Stat, TxLink } from '@/components/ui';
import { apiPost, mult, usd, usePoll } from '@/lib/client/api';
import { LEVEL_NAME } from '@/lib/shared/leverage';
import type { ConfigView, MeView, OrderView } from '@/lib/shared/types';

const STATUS: Partial<Record<OrderView['status'], string>> = { awaiting_payment: 'Waiting for payment', paying: 'Confirming payment', paid: 'Buying pack', buying: 'Opening pack', settling: 'Settling', refunding: 'Refunding', refunded: 'Refunded', expired: 'Expired', review: 'Being checked' };

export function HistoryView() {
  const { me, signedIn, signIn, signingIn, setMe } = useSession();
  const { connected } = useWallet();
  const { setVisible } = useWalletModal();
  const { data: config } = usePoll<ConfigView>('/api/config', 0);
  const { data: orders } = usePoll<OrderView[]>(signedIn ? '/api/orders' : null, 10_000);
  const practice = config?.practice ?? true, cluster = config?.cluster ?? '';

  if (!signedIn || !me?.wallet) return (
    <Card className="mx-auto max-w-md text-center">
      <h1 className="text-2xl font-bold">Your leverage packs</h1>
      <p className="mt-2 text-sm text-muted">Connect and sign in with your wallet to see your packs and set your own limits.</p>
      <div className="mt-5">{connected ? <Button onClick={() => void signIn()} disabled={signingIn}>{signingIn ? 'Signing…' : 'Sign in'}</Button> : <Button onClick={() => setVisible(true)}>Connect wallet</Button>}</div>
    </Card>
  );

  const settled = (orders ?? []).filter(o => o.status === 'complete');
  const paid = settled.reduce((s, o) => s + o.priceUsd, 0);
  const back = settled.reduce((s, o) => s + o.bonusUsd + o.floorUsd + (o.outcome === 'loss' ? 0 : o.valueUsd ?? 0), 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Your leverage packs</h1>
        <p className="mt-1 text-muted">Every pack you opened with leverage and how it settled.</p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.5fr_1fr]">
        <Card className="!p-0 overflow-hidden">
          <div className="grid grid-cols-3 gap-4 border-b border-line px-5 py-5 sm:px-6">
            <Stat label="Packs" value={settled.length} />
            <Stat label="Paid" value={usd(paid, 0)} />
            <Stat label="Got back" value={usd(back, 0)} hint="bonuses, floors and cards at insured value" />
          </div>
          {!orders ? <div className="m-5 h-32 animate-pulse rounded-2xl bg-mist" /> : !orders.length ? <p className="px-6 py-10 text-center text-sm text-muted">No leverage packs yet.</p> : (
            <ul>
              {orders.map(o => (
                <li key={o.id} className="border-b border-line px-5 py-4 last:border-0 sm:px-6">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 text-sm">
                      <div className="truncate font-medium">${o.priceUsd} {o.machineName} · {LEVEL_NAME[o.level]} {mult(o.multiplierBps)}</div>
                      <div className="truncate text-xs text-muted">{new Date(o.createdAt).toLocaleString()}{o.card ? ` · ${o.card.name} · ${usd(o.valueUsd ?? 0)}` : ''}</div>
                    </div>
                    <div className="shrink-0 text-right">
                      {o.outcome ? <OutcomeBadge outcome={o.outcome} /> : <span className="text-xs text-muted">{STATUS[o.status] ?? o.status}</span>}
                      {o.outcome && <div className="mt-1 text-xs tabular-nums text-muted">{o.outcome === 'win' ? `card + ${usd(o.bonusUsd)}` : o.outcome === 'push' ? 'card' : o.floorUsd ? `${usd(o.floorUsd)} floor` : '$0'}</div>}
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-3">
                    <TxLink label="payment" signature={o.links.payment} practice={practice} cluster={cluster} />
                    <TxLink label="pack" signature={o.links.packPayment} practice={practice} cluster={cluster} />
                    <TxLink label="sellback" signature={o.links.sellback} practice={practice} cluster={cluster} />
                    <TxLink label="card" signature={o.links.nftTransfer} practice={practice} cluster={cluster} />
                    <TxLink label="bonus" signature={o.links.bonus} practice={practice} cluster={cluster} />
                    <TxLink label="floor" signature={o.links.floor} practice={practice} cluster={cluster} />
                    <TxLink label="refund" signature={o.links.refund} practice={practice} cluster={cluster} />
                    {o.vrfUrl && <ExternalLink href={o.vrfUrl}>VRF</ExternalLink>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Limits me={me} setMe={setMe} cooldownLosses={config?.rules.cooldownLosses ?? 5} />
      </div>
    </div>
  );
}

function Limits({ me, setMe, cooldownLosses }: { me: Extract<MeView, { optedIn: boolean }>; setMe: (m: MeView) => void; cooldownLosses: number }) {
  const [value, setValue] = useState(''), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const save = async (body: object) => {
    setBusy(true); setError(null);
    try { setMe(await apiPost<MeView>('/api/me', body)); setValue(''); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const l = me.limits;
  return (
    <div className="space-y-6">
      <Card>
        <Label>Your daily loss limit</Label>
        <p className="mt-1 text-sm text-muted">The most your losing packs can cost you in any 24 hours. Lowering it is instant; raising or removing it takes 24 hours.</p>
        <div className="mt-4 grid grid-cols-2 gap-4">
          <Stat label="Limit" value={l.dailyLossLimitUsd === null ? 'None' : usd(l.dailyLossLimitUsd, 0)} />
          <Stat label="Lost, last 24h" value={usd(l.lossLast24hUsd, 0)} />
        </div>
        {l.pending && <p className="mt-3 rounded-2xl bg-mist px-4 py-3 text-xs">Changing to {l.pending.dailyLossLimitUsd === null ? 'no limit' : usd(l.pending.dailyLossLimitUsd, 0)} at {new Date(l.pending.at).toLocaleString()}.</p>}
        <form className="mt-4 flex gap-2" onSubmit={e => { e.preventDefault(); const n = Number(value); if (Number.isInteger(n) && n >= 0) void save({ dailyLossLimitUsd: n }); else setError('Use a whole number of dollars.'); }}>
          <div className="relative flex-1">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-muted">$</span>
            <input value={value} onChange={e => setValue(e.target.value)} inputMode="numeric" placeholder="100" aria-label="Daily loss limit in dollars"
              className="h-11 w-full rounded-full border border-line pl-8 pr-4 text-sm outline-none focus:border-ink" />
          </div>
          <Button type="submit" disabled={busy || !value}>Set</Button>
        </form>
        {l.dailyLossLimitUsd !== null && <button className="mt-2 text-xs text-muted underline" onClick={() => void save({ dailyLossLimitUsd: null })} disabled={busy}>Remove limit (takes 24 hours)</button>}
        {error && <p className="mt-2 text-sm text-loss">{error}</p>}
      </Card>
      <Card>
        <Label>Breaks and opt-out</Label>
        <p className="mt-1 text-sm text-muted">After {cooldownLosses} losses in a row, leverage packs pause for this wallet for a short break.</p>
        {l.cooldownUntil && <p className="mt-3 rounded-2xl bg-poke-yellow/30 px-4 py-3 text-sm">On a break until {new Date(l.cooldownUntil).toLocaleTimeString()}.</p>}
        <div className="mt-4 flex items-center justify-between gap-3">
          <span className="text-sm">Leverage packs are <strong>{me.optedIn ? 'on' : 'off'}</strong> for this wallet.</span>
          <Button variant="ghost" disabled={busy} onClick={() => void save({ optIn: !me.optedIn })}>{me.optedIn ? 'Turn off' : 'Turn on'}</Button>
        </div>
      </Card>
    </div>
  );
}
