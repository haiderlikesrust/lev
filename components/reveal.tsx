'use client';
/* eslint-disable @next/next/no-img-element -- Collector Crypt's own CDN images and videos, shown as-is. */
import Link from 'next/link';
import type { CSSProperties } from 'react';
import { History, X } from 'lucide-react';
import { PokeBall } from './pokeball';
import { ProgressSteps } from './progress-steps';
import { Card, ExternalLink, Label, OutcomeBadge, TxLink, rarityColor } from './ui';
import { mult, usd } from '@/lib/client/api';
import { LEVEL_NAME } from '@/lib/shared/leverage';
import type { CardView, MachineView, OrderView } from '@/lib/shared/types';

/** The card itself: its back (a Poké Ball) flips over to Collector Crypt's photo of the graded card. */
export function CardArt({ card, valueUsd, flip = false }: { card: CardView; valueUsd: number | null; flip?: boolean }) {
  const color = rarityColor(card.rarity);
  return (
    <div className="relative mx-auto w-52 sm:w-60" style={{ perspective: '1200px' }}>
      <div className="glow absolute -inset-5 rounded-[32px] blur-2xl" style={{ background: color, opacity: 0.55 }} />
      <div className={`relative aspect-[5/8] ${flip ? 'card-flip' : ''}`} style={{ transformStyle: 'preserve-3d' }}>
        <div className="card-shine absolute inset-0 overflow-hidden rounded-2xl border-4 bg-white shadow-xl [backface-visibility:hidden]" style={{ borderColor: color }}>
          {card.image
            ? <img src={card.image} alt={card.name} className="h-full w-full object-contain p-1.5" />
            : (
              <div className="flex h-full flex-col justify-between bg-gradient-to-b from-mist to-white p-4">
                <div className="font-pixel text-[10px] uppercase" style={{ color }}>{card.rarity ?? 'card'}</div>
                <PokeBall size={84} className="mx-auto opacity-90" />
                <div>
                  <div className="text-sm font-semibold leading-snug">{card.name}</div>
                  {valueUsd !== null && <div className="mt-1 font-pixel text-xs text-muted">{usd(valueUsd)}</div>}
                </div>
              </div>
            )}
        </div>
        <div className="dots absolute inset-0 flex items-center justify-center rounded-2xl border-4 border-poke-yellow bg-navy [backface-visibility:hidden] [transform:rotateY(180deg)]">
          <PokeBall size={96} />
        </div>
      </div>
    </div>
  );
}

const SPARKS = Array.from({ length: 10 }, (_, i) => { const a = (i / 10) * Math.PI * 2; return { dx: `${Math.cos(a) * 150}px`, dy: `${Math.sin(a) * 150}px` }; });

/**
 * The pack's progress and result. While the server works, CC's own machine runs; when the pack settles, a
 * burst of light, the capsule pops open and the card flips over, then the result rises in. The sequence is the
 * same for every outcome (no extra celebration for wins, no near-miss effects), and there is no "open another".
 * A short runs the same sequence on the pull it rode: someone else's card.
 */
export function Reveal({ order, machine, practice, cluster, onClose }: { order: OrderView; machine: MachineView | null; practice: boolean; cluster: string; onClose: () => void }) {
  const done = order.status === 'complete', stopped = ['refunded', 'expired', 'review'].includes(order.status);
  const short = order.side === 'short';
  const got = short
    ? order.outcome === 'win' ? `${usd(order.priceUsd, 0)} + ${usd(order.bonusUsd)}` : order.outcome === 'push' ? `${usd(order.priceUsd, 0)} back` : '$0'
    : order.outcome === 'win' ? `The card + ${usd(order.bonusUsd)}` : order.outcome === 'push' ? 'The card' : order.floorUsd > 0 ? `${usd(order.floorUsd)} (half the sellback)` : '$0';
  const color = rarityColor(order.card?.rarity);
  return (
    <Card className="overflow-hidden !p-0">
      <div className="border-b border-line px-5 py-4">
        <Label>{short ? <>Short · next ${order.priceUsd} {order.machineName} pull · {mult(order.multiplierBps)} per $1 under</> : <>${order.priceUsd} {order.machineName} · {LEVEL_NAME[order.level]} · {mult(order.multiplierBps)}</>}</Label>
        {!stopped && <div className="mx-auto mt-4 max-w-md"><ProgressSteps status={order.status} side={order.side} /></div>}
      </div>

      <div className="dots relative flex min-h-[23rem] flex-col items-center justify-center overflow-hidden bg-navy px-4 py-10">
        <div className="hero-glow absolute inset-0" />
        {stopped ? (
          <div className="relative max-w-sm text-center text-white">
            <PokeBall size={64} className="mx-auto opacity-50" />
            <p className="mt-4 text-sm text-white/80">{order.message}</p>
          </div>
        ) : done && order.card ? (
          <div className="relative flex w-full items-center justify-center">
            <div className="rays pointer-events-none absolute left-1/2 top-1/2 h-[34rem] w-[34rem] -translate-x-1/2 -translate-y-1/2" />
            <div className="flash pointer-events-none absolute inset-[-50%] bg-white" />
            <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
              <div className="capsule-pop relative h-24 w-24">
                <svg viewBox="0 0 100 100" className="capsule-top absolute inset-0" aria-hidden><path d="M4 50a46 46 0 0 1 92 0z" fill="#e3350d" stroke="#10143a" strokeWidth="7" /><circle cx="50" cy="50" r="12" fill="#fff" stroke="#10143a" strokeWidth="7" /></svg>
                <svg viewBox="0 0 100 100" className="capsule-bottom absolute inset-0" aria-hidden><path d="M4 50a46 46 0 0 0 92 0z" fill="#fff" stroke="#10143a" strokeWidth="7" /></svg>
              </div>
              {SPARKS.map((s, i) => <span key={i} className="sparkle left-1/2 top-1/2" style={{ background: i % 2 ? color : '#ffcb05', '--dx': s.dx, '--dy': s.dy } as CSSProperties} />)}
            </div>
            <div className="relative">
              <CardArt card={order.card} valueUsd={order.valueUsd} flip />
              {short && <p className="rise mt-4 text-center text-xs text-white/70 [animation-delay:1.9s]">The next pull, opened by another player</p>}
            </div>
          </div>
        ) : (
          <div className="relative text-center">
            <div className="absolute left-1/2 top-1/2 h-56 w-56 -translate-x-1/2 -translate-y-1/2 rounded-full bg-poke-yellow/20 blur-2xl" />
            {machine?.video
              ? <video src={machine.video} poster={machine.image ?? undefined} autoPlay muted loop playsInline className="machine-work relative mx-auto h-60 w-auto" />
              : machine?.image ? <img src={machine.image} alt="" className="machine-work relative mx-auto h-60 w-auto object-contain" /> : <PokeBall size={120} className="machine-work relative mx-auto" />}
            <p className="relative mt-5 text-sm text-white/80" aria-live="polite">{order.message ?? 'Working…'}</p>
          </div>
        )}
      </div>

      {done && order.outcome && (
        <div className="rise px-5 py-5 [animation-delay:2.3s]">
          <div className="flex flex-wrap items-center gap-3"><OutcomeBadge outcome={order.outcome} /><span className="text-sm text-muted">{order.card?.name}</span></div>
          <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="text-sm text-muted">{short ? 'Next card' : 'Card value'} {usd(order.valueUsd ?? 0)} vs pack {usd(order.priceUsd, 0)}</div>
              <div className="mt-1 font-display text-3xl font-extrabold">You get: {got}</div>
            </div>
          </div>
          <p className="mt-2 text-sm text-muted">{order.message}</p>
          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5 rounded-2xl bg-mist px-4 py-3">
            <TxLink label="Your payment" signature={order.links.payment} practice={practice} cluster={cluster} />
            <TxLink label="Pack purchase" signature={order.links.packPayment} practice={practice} cluster={cluster} />
            <TxLink label="Sellback" signature={order.links.sellback} practice={practice} cluster={cluster} />
            <TxLink label="Floor" signature={order.links.floor} practice={practice} cluster={cluster} />
            <TxLink label="Card to you" signature={order.links.nftTransfer} practice={practice} cluster={cluster} />
            <TxLink label="Bonus" signature={order.links.bonus} practice={practice} cluster={cluster} />
            <TxLink label="Stake back" signature={order.links.stakeBack} practice={practice} cluster={cluster} />
            <TxLink label="Short payout" signature={order.links.payout} practice={practice} cluster={cluster} />
            <TxLink label="Stake to pool" signature={order.links.stakeToPool} practice={practice} cluster={cluster} />
            {order.vrfUrl && <ExternalLink href={order.vrfUrl}>Fairness proof (VRF)</ExternalLink>}
            {short && !practice && order.pull?.mint && <ExternalLink href={`https://collectorcrypt.com/assets/solana/${order.pull.mint}`}>The pulled card</ExternalLink>}
          </div>
        </div>
      )}

      {(done || stopped) && (
        <div className={`flex flex-wrap gap-3 px-5 pb-5 ${done ? 'rise [animation-delay:2.5s]' : 'pt-5'}`}>
          <Link href="/history" className="inline-flex h-11 items-center gap-2 rounded-full bg-mist px-5 text-sm font-semibold hover:bg-line"><History size={16} /> View history</Link>
          <button onClick={onClose} className="inline-flex h-11 items-center gap-2 rounded-full bg-mist px-5 text-sm font-semibold hover:bg-line"><X size={16} /> Close</button>
        </div>
      )}
    </Card>
  );
}
