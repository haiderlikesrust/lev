import { ShieldCheck } from 'lucide-react';
import { ExternalLink, TxLink } from './ui';
import type { SettlementView } from '@/lib/shared/types';

/**
 * Every on-chain step behind one settled pack, in order, so anyone can check it: the player's payment,
 * the pack bought on CC, the card CC delivered, then where the card and the money went.
 */
export function Proof({ s, practice, cluster }: { s: SettlementView; practice: boolean; cluster: string }) {
  const steps: { label: string; note: string; sig?: string | null; href?: string | null }[] = [
    { label: 'Player paid', note: 'USDC from the player to LEV_OPS', sig: s.links.payment },
    { label: 'Pack bought', note: 'LEV_OPS paid Collector Crypt for the pack', sig: s.links.packPayment },
    { label: 'Card delivered', note: 'Collector Crypt sent the card to LEV_OPS', sig: s.links.cardDelivery },
    { label: 'Card to player', note: 'LEV_OPS sent the card on', sig: s.links.nftTransfer },
    { label: 'Bonus paid', note: 'LEV_POOL paid the bonus', sig: s.links.bonus },
    { label: 'Sold back', note: 'Collector Crypt bought the card back into LEV_POOL', sig: s.links.sellback },
    { label: 'Floor paid', note: 'The half-risk share to the player', sig: s.links.floor },
  ].filter(x => x.sig);
  return (
    <div className="rounded-2xl bg-mist p-4">
      <div className="flex items-center gap-2 text-xs font-semibold"><ShieldCheck size={14} className="text-uncommon" /> Proof {practice && <span className="font-normal text-muted">· practice mode: simulated signatures</span>}</div>
      <ol className="mt-3 space-y-2">
        {steps.map((x, i) => (
          <li key={x.label} className="flex items-start gap-3 text-xs">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white font-pixel text-[9px] text-muted">{i + 1}</span>
            <div className="min-w-0 flex-1"><div className="font-medium text-ink">{x.label}</div><div className="text-muted">{x.note}</div></div>
            <TxLink label="tx" signature={x.sig} practice={practice} cluster={cluster} />
          </li>
        ))}
      </ol>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-line pt-3">
        {s.vrfUrl && <ExternalLink href={s.vrfUrl}>Fairness proof (VRF)</ExternalLink>}
        {!practice && s.card?.mint && <ExternalLink href={`https://collectorcrypt.com/assets/solana/${s.card.mint}`}>Card on Collector Crypt</ExternalLink>}
      </div>
    </div>
  );
}
