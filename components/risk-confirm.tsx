'use client';
import { useEffect, useState } from 'react';
import { Button } from './ui';
import { mult, pct, usd } from '@/lib/client/api';
import { LEVEL_NAME } from '@/lib/shared/leverage';
import type { MachineView, OfferView } from '@/lib/shared/types';

/** The per-pack HIGH RISK confirmation. The box starts unticked every time, and nothing can be skipped. */
export function RiskConfirm({ machine, offer, busy, onCancel, onConfirm }: { machine: MachineView; offer: OfferView; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const [accepted, setAccepted] = useState(false);
  useEffect(() => { const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onCancel(); }; window.addEventListener('keydown', esc); return () => window.removeEventListener('keydown', esc); }, [busy, onCancel]);
  const full = offer.floorBps === 0, short = offer.side === 'short', price = usd(machine.priceUsd, 0);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/50 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="risk-title">
      <div className="w-full max-w-md rounded-t-3xl bg-white p-6 shadow-xl sm:rounded-3xl">
        <div className="rounded-2xl bg-poke-red px-4 py-4 text-white">
          <div className="font-pixel text-[11px] uppercase tracking-wider opacity-90">Warning</div>
          <h2 id="risk-title" className="mt-1 text-xl font-bold leading-snug">
            {short ? <>HIGH RISK — you lose your entire {price} if the next pull is good</>
              : full ? <>HIGH RISK — you can lose your entire pack price ({price})</> : <>HIGH RISK — you can lose up to {usd(offer.maxLossUsd)} of your {price} pack price</>}
          </h2>
        </div>
        {short ? (
          <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <dt className="text-muted">Short</dt><dd className="text-right font-medium">Next ${machine.priceUsd} {machine.name} pull</dd>
            <dt className="text-muted">Per $1 under {price}</dt><dd className="text-right font-medium">You win {usd(offer.multiplierBps / 10_000)}</dd>
            <dt className="text-muted">If the card is good</dt><dd className="text-right font-medium">You lose {price}</dd>
            <dt className="text-muted">Most you can win</dt><dd className="text-right font-medium">{usd(offer.capUsd)}</dd>
            <dt className="text-muted">Chance of a loss</dt><dd className="text-right font-medium">{Math.round(offer.pLoss * 100)}%</dd>
            <dt className="text-muted">Average result</dt><dd className="text-right font-medium">{pct(offer.playerReturn)}</dd>
          </dl>
        ) : (
          <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <dt className="text-muted">Pack</dt><dd className="text-right font-medium">${machine.priceUsd} {machine.name}</dd>
            <dt className="text-muted">Level</dt><dd className="text-right font-medium">{LEVEL_NAME[offer.level]} · {mult(offer.multiplierBps)}</dd>
            <dt className="text-muted">If it loses</dt><dd className="text-right font-medium">{full ? 'You get $0' : 'Half the sellback'}</dd>
            <dt className="text-muted">Biggest possible bonus</dt><dd className="text-right font-medium">{usd(offer.capUsd, 0)}</dd>
            <dt className="text-muted">Chance of a loss</dt><dd className="text-right font-medium">{Math.round(offer.pLoss * 100)}%</dd>
            <dt className="text-muted">Average result</dt><dd className="text-right font-medium">{pct(offer.playerReturn)} <span className="text-muted">(normal {pct(offer.normalReturn)})</span></dd>
          </dl>
        )}
        <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-2xl border border-line p-4">
          <input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-poke-red" />
          <span className="text-sm">{short
            ? `I understand this is high risk: a short wins often but small, and if the next card is good I lose my whole ${price}.`
            : `I understand this is high risk and I accept that I can lose ${full ? 'my entire pack price' : `up to ${usd(offer.maxLossUsd)}`} on this pack.`}</span>
        </label>
        <div className="mt-5 flex gap-3">
          <Button variant="ghost" onClick={onCancel} disabled={busy} className="flex-1">Cancel</Button>
          <Button variant="red" onClick={onConfirm} disabled={!accepted || busy} className="flex-1">{busy ? 'Waiting for wallet…' : short ? `Pay ${price} and short` : `Pay ${price} and open`}</Button>
        </div>
      </div>
    </div>
  );
}
