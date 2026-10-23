import { ShieldCheck } from 'lucide-react';
import { ExternalLink, TxLink } from './ui';
import type { SettlementView } from '@/lib/shared/types';

/**
 * Every on-chain step behind one settled pack, in order, so anyone can check it: the player's payment,
 * the pack bought on CC, the card CC delivered, then where the card and the money went. A short shows the
 * pull it rode (someone else's card) and where the stake went.
 */
export function Proof({ s, practice, cluster }: { s: SettlementView; practice: boolean; cluster: string }) {
  const short = s.side === 'short';
  const steps: { label: string; note: string; sig?: string | null; href?: string | null }[] = [
    { label: short ? 'Player staked' : 'Player paid', note: 'USDC from the player to LEV_OPS', sig: s.links.payment },
    { label: 'Pack bought', note: 'LEV_OPS paid Collector Crypt for the pack', sig: s.links.packPayment },
    { label: 'Card delivered', note: 'Collector Crypt sent the card to LEV_OPS', sig: s.links.cardDelivery },
    { label: 'Card to player', note: 'LEV_OPS sent the card on', sig: s.links.nftTransfer },
    { label: 'Bonus paid', note: 'LEV_POOL paid the bonus', sig: s.links.bonus },
    { label: 'Sold back', note: 'Collector Crypt bought the card back into LEV_POOL', sig: s.links.sellback },
    { label: 'Floor paid', note: 'The half-risk share to the player', sig: s.links.floor },
    { label: 'Stake back', note: 'LEV_OPS returned the stake', sig: s.links.stakeBack },
    { label: 'Short paid', note: 'LEV_POOL paid (price − value) × the short multiple', sig: s.links.payout },
    { label: 'Stake to pool', note: 'The next card hit, so the stake went to LEV_POOL', sig: s.links.stakeToPool },
  ].filter(x => x.sig);
  const cardMint = practice ? null : short ? s.pull?.mint : s.card?.mint;
  return (
    <div className="rounded-2xl bg-mist px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
        <span className="flex items-center gap-1.5 font-semibold text-ink"><ShieldCheck size={14} className="text-uncommon" aria-hidden />Proof</span>
        {practice && <span className="text-muted">· practice mode: simulated signatures</span>}
      </div>
      {short && s.pull && (
        <p className="mt-2 text-xs leading-relaxed text-muted">
          Rode the first {s.machineName} pull Collector Crypt stamped after the payment: {s.card?.name ?? 'a card'} worth ${s.valueUsd.toFixed(2)}, pulled {new Date(s.pull.pulledAt).toLocaleString()}.
        </p>
      )}
      {/* A timeline: numbered steps joined by a line, each with its transaction on the right. */}
      <ol className="mt-4">
        {steps.map((x, i) => (
          <li key={x.label} className="relative flex gap-3 pb-4 last:pb-0">
            {i < steps.length - 1 && <span className="absolute bottom-1 left-[11.5px] top-7 w-px bg-line" aria-hidden />}
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white text-[11px] font-semibold tabular-nums text-muted ring-1 ring-line">{i + 1}</span>
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="text-sm font-medium leading-5 text-ink">{x.label}</div>
              <div className="mt-0.5 text-xs text-muted">{x.note}</div>
            </div>
            <span className="shrink-0 pt-1"><TxLink label="tx" signature={x.sig} practice={practice} cluster={cluster} /></span>
          </li>
        ))}
      </ol>
      {(s.vrfUrl || cardMint) && (
        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 border-t border-line pt-3">
          {s.vrfUrl && <ExternalLink href={s.vrfUrl}>Fairness proof (VRF)</ExternalLink>}
          {cardMint && <ExternalLink href={`https://collectorcrypt.com/assets/solana/${cardMint}`}>{short ? 'The pulled card on Collector Crypt' : 'Card on Collector Crypt'}</ExternalLink>}
        </div>
      )}
    </div>
  );
}
