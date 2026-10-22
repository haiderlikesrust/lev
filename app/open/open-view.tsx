'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { VersionedTransaction } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { useSession } from '@/components/providers';
import { Button, Card, HighRisk, Label, Locked } from '@/components/ui';
import { RiskConfirm } from '@/components/risk-confirm';
import { Reveal } from '@/components/reveal';
import { MachineArt } from '@/components/machine-art';
import { apiGet, apiPost, chance, fromBase64, mult, pct, toBase64, usd, usdShort, usePoll } from '@/lib/client/api';
import { LEVELS, LEVEL_NAME, type Level } from '@/lib/shared/leverage';
import type { ConfigView, MachineView, MeView, OfferView, OrderView } from '@/lib/shared/types';

const FINAL: OrderView['status'][] = ['complete', 'refunded', 'expired', 'review'];

export function OpenView() {
  const { data: config, error: configError, reload } = usePoll<ConfigView>('/api/config', 15_000);
  const { me, signedIn, signIn, signingIn, setMe, practice } = useSession();
  const { connected, signTransaction } = useWallet();
  const { setVisible } = useWalletModal();
  // Deep links from the home table: /open?machine=pokemon_25&level=full. Nothing renders from these before
  // the config loads on the client, so reading the URL here can't cause a hydration mismatch.
  const [picked, setCode] = useState<string | null>(() => typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('machine'));
  const [level, setLevel] = useState<Level>(() => typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('level') === 'full' ? 'full' : 'half');
  const [confirming, setConfirming] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [order, setOrder] = useState<OrderView | null>(null);
  // A clock for the cool-down banner, ticking in the background rather than read during render.
  const [now, setNow] = useState(0);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(timer); }, []);
  // Until the player picks one, the first machine with a live level.
  const code = picked ?? config?.machines.find(m => m.offers.some(o => o.available))?.code ?? config?.machines[0]?.code ?? null;

  // Follow an order until it settles.
  useEffect(() => {
    if (!order || FINAL.includes(order.status)) return;
    const timer = setInterval(async () => { try { setOrder(await apiGet<OrderView>(`/api/orders/${order.id}`)); } catch { /* next tick */ } }, 1_200);
    return () => clearInterval(timer);
  }, [order]);
  useEffect(() => { if (order && FINAL.includes(order.status)) { void reload(); void apiGet<MeView>('/api/me').then(setMe).catch(() => {}); } }, [order, reload, setMe]);

  const machine = config?.machines.find(m => m.code === code) ?? null;
  const offer = machine?.offers.find(o => o.level === level) ?? null;
  const signed = me?.wallet ? me : null;
  const cooldownUntil = signed && 'limits' in signed ? signed.limits.cooldownUntil : null;
  const blocked = useMemo(() => {
    if (!connected) return 'connect';
    if (!signedIn) return 'sign-in';
    if (signed && !signed.optedIn) return 'opt-in';
    // The server only reports a cool-down that is still running; the clock clears it once it ends.
    if (cooldownUntil && cooldownUntil > now) return 'cooldown';
    if (config?.pool.pauseReason) return 'paused';
    return null;
  }, [connected, signedIn, signed, cooldownUntil, config, now]);

  const start = useCallback(async () => {
    if (!machine || !offer) return;
    setBusy(true); setError(null);
    try {
      if (!signTransaction) throw new Error('This wallet cannot sign transactions. Try Phantom or Solflare.');
      const { order: created, transaction } = await apiPost<{ order: OrderView; transaction: string }>('/api/orders', { code: machine.code, level: offer.level, acceptedRisk: true });
      let signedTx: string;
      try { signedTx = toBase64((await signTransaction(VersionedTransaction.deserialize(fromBase64(transaction)))).serialize()); }
      catch { await apiPost(`/api/orders/${created.id}/cancel`).catch(() => {}); throw new Error('The payment was not approved in your wallet. Nothing was charged.'); }
      setConfirming(false);
      setOrder(await apiPost<OrderView>(`/api/orders/${created.id}/pay`, { signed: signedTx }));
    } catch (e) { setError((e as Error).message); setConfirming(false); }
    finally { setBusy(false); }
  }, [machine, offer, signTransaction]);

  const optIn = async () => { setError(null); try { setMe(await apiPost<MeView>('/api/me', { optIn: true })); } catch (e) { setError((e as Error).message); } };

  if (configError) return <Card><p className="text-sm text-loss">{configError}</p></Card>;
  if (!config) return <div className="h-96 animate-pulse rounded-3xl bg-mist" />;

  if (order) return (
    <div className="mx-auto max-w-2xl">
      <Reveal order={order} machine={config.machines.find(m => m.code === order.code) ?? null} practice={config.practice} cluster={config.cluster} onClose={() => { setOrder(null); setError(null); }} />
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <HighRisk />
          <h1 className="mt-3 text-3xl font-extrabold sm:text-4xl">Open a leverage pack</h1>
          <p className="mt-1 text-muted">Pick a machine and a level. You&apos;ll see every outcome before you confirm.</p>
        </div>
      </div>

      <div>
        <Label>1 · Machine</Label>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {config.machines.map(m => <MachineTile key={m.code} m={m} selected={m.code === code} onSelect={() => setCode(m.code)} />)}
        </div>
      </div>

      {machine && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_1.15fr]">
          <div>
            <Label>2 · Level</Label>
            <div className="mt-3 grid gap-3">
              {LEVELS.map(l => {
                const o = machine.offers.find(x => x.level === l);
                return <LevelOption key={l} level={l} offer={o ?? null} selected={l === level} onSelect={() => setLevel(l)} />;
              })}
            </div>
          </div>
          <div>
            <Label>3 · What can happen</Label>
            <div className="mt-3">{offer ? <Outcomes machine={machine} offer={offer} /> : <Card><p className="text-sm text-muted">Not calibrated yet.</p></Card>}</div>
          </div>
        </div>
      )}

      {machine && offer && (
        <Card className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm">
            {blocked === 'connect' && <span>Connect your wallet to open a pack.</span>}
            {blocked === 'sign-in' && <span>Sign in with your wallet (a free message signature) to continue.</span>}
            {blocked === 'opt-in' && <span><strong>Leverage packs are off for this wallet.</strong> They are high risk and optional. Turn them on only if you accept that you can lose your entire pack price.</span>}
            {blocked === 'cooldown' && <span><strong>Take a break.</strong> After {config.rules.cooldownLosses} losses in a row, leverage packs open again for this wallet at {new Date(cooldownUntil!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.</span>}
            {blocked === 'paused' && <span>{config.pool.pauseReason}</span>}
            {!blocked && !offer.available && <span className="text-muted">{offer.reason}</span>}
            {!blocked && offer.available && <span>${machine.priceUsd} {machine.name} · {LEVEL_NAME[offer.level]} · <strong>{mult(offer.multiplierBps)}</strong></span>}
            {error && <p className="mt-2 text-loss">{error}</p>}
          </div>
          <div className="shrink-0">
            {blocked === 'connect' && <Button onClick={() => setVisible(true)}>Connect wallet</Button>}
            {blocked === 'sign-in' && <Button onClick={() => void signIn().catch(e => setError((e as Error).message))} disabled={signingIn}>{signingIn ? 'Signing…' : 'Sign in'}</Button>}
            {blocked === 'opt-in' && <Button variant="red" onClick={() => void optIn()}>Turn on leverage packs</Button>}
            {!blocked && <Button variant="red" disabled={!offer.available} onClick={() => { setError(null); setConfirming(true); }}>Open with leverage</Button>}
          </div>
        </Card>
      )}
      {practice && <p className="text-center text-xs text-muted">Practice wallets: pick “Burner Wallet” in the wallet list for a throwaway practice wallet.</p>}

      {confirming && machine && offer && <RiskConfirm machine={machine} offer={offer} busy={busy} onCancel={() => setConfirming(false)} onConfirm={() => void start()} />}
    </div>
  );
}

function MachineTile({ m, selected, onSelect }: { m: MachineView; selected: boolean; onSelect: () => void }) {
  const live = m.offers.filter(o => o.available);
  return (
    <button onClick={onSelect} aria-pressed={selected}
      className={`group flex flex-col overflow-hidden rounded-3xl border-2 bg-white text-left shadow-card transition ${selected ? 'border-poke-red ring-4 ring-poke-red/10' : 'border-transparent hover:-translate-y-0.5 hover:shadow-lift'}`}>
      <div className={`flex h-28 items-end justify-center pt-2 transition ${selected ? 'bg-gradient-to-b from-poke-yellow/25 to-white' : 'bg-gradient-to-b from-mist to-white'}`}>
        <MachineArt image={m.image} name={m.name} className={`h-24 w-24 transition duration-300 ${selected ? 'scale-105' : 'group-hover:scale-105'}`} />
      </div>
      <div className="p-3">
        <div className="flex items-baseline justify-between gap-2"><span className="font-display text-xl font-extrabold tabular-nums">${m.priceUsd}</span><span className="truncate text-xs text-muted">{m.name}</span></div>
        <div className="mt-2 flex flex-wrap gap-1">
          {live.length ? live.map(o => (
            <span key={o.level} className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${o.level === 'full' ? 'bg-poke-red/10 text-poke-red' : 'bg-poke-blue/10 text-poke-blue'}`}>{o.level === 'full' ? 'Full' : 'Half'} {mult(o.multiplierBps)}</span>
          )) : <Locked>Locked</Locked>}
        </div>
      </div>
    </button>
  );
}

function LevelOption({ level, offer, selected, onSelect }: { level: Level; offer: OfferView | null; selected: boolean; onSelect: () => void }) {
  const accent = level === 'full' ? 'bg-poke-red' : 'bg-poke-blue';
  return (
    <button onClick={onSelect} aria-pressed={selected}
      className={`flex items-center gap-4 rounded-3xl border-2 p-4 text-left transition ${selected ? 'border-ink' : 'border-line hover:border-muted'} ${offer?.available ? '' : 'opacity-70'}`}>
      <span className={`h-10 w-1.5 shrink-0 rounded-full ${accent}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-semibold">{LEVEL_NAME[level]}</span>
          {offer && <span className="text-xl font-bold tabular-nums">{mult(offer.multiplierBps)}</span>}
        </div>
        <div className="text-sm text-muted">{level === 'full' ? 'Lose: you get $0.' : 'Lose: you get half the sellback.'}</div>
        {offer && !offer.available && <div className="mt-1"><Locked>{offer.reason}</Locked></div>}
      </div>
    </button>
  );
}

function Outcomes({ machine, offer }: { machine: MachineView; offer: OfferView }) {
  const p = machine.priceUsd, k = (offer.multiplierBps - 10_000) / 10_000, b = machine.buybackPct / 100, full = offer.floorBps === 0;
  const exampleBonus = Math.min(2 * p * k, offer.capUsd || Infinity);
  const rows = [
    { tag: 'Loss', color: 'bg-loss', when: `Card under ${usd(p * 0.95)}`, chance: offer.pLoss, get: full ? 'You get $0. The pool sells the card back.' : `You get half the sellback: ${Math.round(b * 50)}% of the card's value.` },
    { tag: 'Push', color: 'bg-push', when: `${usd(p * 0.95)} – ${usd(p * 1.05)}`, chance: offer.pPush, get: 'You get the card.' },
    { tag: 'Win', color: 'bg-poke-yellow', when: `Card ${usd(p * 1.05)} or more`, chance: offer.pWin, get: `The card + (value − ${usd(p, 0)}) × ${k.toFixed(2)} bonus.` },
  ];
  return (
    <Card className="!p-0 overflow-hidden">
      <ul>
        {rows.map(r => (
          <li key={r.tag} className="flex gap-4 border-b border-line px-5 py-4 last:border-0">
            <span className={`mt-1 h-3 w-3 shrink-0 rounded-full ${r.color}`} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="font-semibold">{r.tag} <span className="font-normal text-muted">· {r.when}</span></span>
                <span className="text-sm tabular-nums text-muted">{chance(r.chance)} of pulls</span>
              </div>
              <div className="mt-0.5 text-sm">{r.get}</div>
            </div>
          </li>
        ))}
      </ul>
      <div className="grid grid-cols-2 gap-4 bg-mist px-5 py-4 text-sm">
        <div><div className="text-muted">Example: card worth {usd(3 * p, 0)}</div><div className="font-semibold">Card + {usd(exampleBonus)} bonus</div></div>
        <div><div className="text-muted">Biggest bonus right now</div><div className="font-semibold">{offer.capUsd > 0 ? usdShort(offer.capUsd) : '—'}</div></div>
        <div><div className="text-muted">Average result</div><div className="font-semibold">{pct(offer.playerReturn)} <span className="font-normal text-muted">vs {pct(offer.normalReturn)} normal</span></div></div>
        <div><div className="text-muted">Worst case</div><div className="font-semibold text-loss">−{usd(offer.maxLossUsd)}</div></div>
      </div>
      <p className="px-5 py-3 text-xs text-muted">Chances and averages come from recent real Collector Crypt pulls on this machine, selling every card back. Past pulls don&apos;t guarantee the next one.</p>
    </Card>
  );
}
