'use client';
import Link from 'next/link';
import { PokeBall } from './pokeball';
import { Button, Card, ExternalLink, Label, OutcomeBadge, TxLink, rarityColor } from './ui';
import { mult, usd } from '@/lib/client/api';
import { LEVEL_NAME } from '@/lib/shared/leverage';
import type { CardView, OrderView } from '@/lib/shared/types';

const STEPS: { status: OrderView['status'][]; label: string }[] = [
  { status: ['awaiting_payment', 'paying'], label: 'Payment' },
  { status: ['paid', 'buying'], label: 'Opening pack' },
  { status: ['settling'], label: 'Settling' },
  { status: ['complete'], label: 'Done' },
];

export function CardArt({ card, valueUsd }: { card: CardView; valueUsd: number | null }) {
  const color = rarityColor(card.rarity);
  return (
    <div className="relative mx-auto w-56">
      <div className="glow absolute -inset-4 rounded-[28px] blur-xl" style={{ background: color, opacity: 0.6 }} />
      <div className="relative aspect-[5/7] overflow-hidden rounded-2xl border-4 bg-white shadow-lg" style={{ borderColor: color }}>
        {card.image
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={card.image} alt={card.name} className="h-full w-full object-cover" />
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
    </div>
  );
}

/**
 * The pack's progress and result. The ball shakes until the server has settled the pack, so the
 * reveal and the result always arrive together. The result reads the same for every outcome: there
 * is no "open another" here, and nothing extra after a loss.
 */
export function Reveal({ order, practice, cluster, onClose }: { order: OrderView; practice: boolean; cluster: string; onClose: () => void }) {
  const done = order.status === 'complete', stopped = ['refunded', 'expired', 'review'].includes(order.status);
  const active = STEPS.findIndex(s => s.status.includes(order.status));
  const got = order.outcome === 'win' ? `The card + a ${usd(order.bonusUsd)} bonus` : order.outcome === 'push' ? 'The card' : order.floorUsd > 0 ? `${usd(order.floorUsd)} (half the sellback)` : '$0';
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label>${order.priceUsd} {order.machineName} · {LEVEL_NAME[order.level]} · {mult(order.multiplierBps)}</Label>
        {!stopped && (
          <ol className="flex items-center gap-1.5 text-xs">
            {STEPS.map((s, i) => (
              <li key={s.label} className={`rounded-full px-2.5 py-1 ${i < active || done ? 'bg-ink text-white' : i === active ? 'bg-poke-yellow text-ink' : 'bg-mist text-muted'}`}>{s.label}</li>
            ))}
          </ol>
        )}
      </div>

      <div className="flex min-h-72 flex-col items-center justify-center py-8">
        {stopped ? (
          <div className="max-w-sm text-center">
            <PokeBall size={64} className="mx-auto opacity-40" />
            <p className="mt-4 text-sm">{order.message}</p>
          </div>
        ) : done && order.card ? (
          <div className="relative w-full">
            <div className="pointer-events-none absolute inset-x-0 top-1/2 flex -translate-y-1/2 justify-center"><PokeBall size={120} split opening /></div>
            <div className="card-in"><CardArt card={order.card} valueUsd={order.valueUsd} /></div>
          </div>
        ) : (
          <div className="text-center">
            <PokeBall size={120} className="ball-shake mx-auto" />
            <p className="mt-6 text-sm text-muted" aria-live="polite">{order.message ?? 'Working…'}</p>
          </div>
        )}
      </div>

      {done && order.outcome && (
        <div className="card-in rounded-2xl bg-mist p-5" style={{ animationDelay: '0.9s' }}>
          <div className="flex items-center gap-3"><OutcomeBadge outcome={order.outcome} /><span className="text-sm text-muted">Card value {usd(order.valueUsd ?? 0)} vs pack {usd(order.priceUsd, 0)}</span></div>
          <div className="mt-3 text-2xl font-bold">You get: {got}</div>
          <p className="mt-2 text-sm text-muted">{order.message}</p>
          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5">
            <TxLink label="Your payment" signature={order.links.payment} practice={practice} cluster={cluster} />
            <TxLink label="Pack purchase" signature={order.links.packPayment} practice={practice} cluster={cluster} />
            <TxLink label="Sellback" signature={order.links.sellback} practice={practice} cluster={cluster} />
            <TxLink label="Floor" signature={order.links.floor} practice={practice} cluster={cluster} />
            <TxLink label="Card to you" signature={order.links.nftTransfer} practice={practice} cluster={cluster} />
            <TxLink label="Bonus" signature={order.links.bonus} practice={practice} cluster={cluster} />
            {order.vrfUrl && <ExternalLink href={order.vrfUrl}>Fairness proof (VRF)</ExternalLink>}
          </div>
        </div>
      )}

      {(done || stopped) && (
        <div className="mt-5 flex flex-wrap gap-3">
          <Link href="/history" className="inline-flex h-11 items-center rounded-full bg-mist px-5 text-sm font-semibold hover:bg-line">View history</Link>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
      )}
    </Card>
  );
}
