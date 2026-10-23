'use client';
import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { PokeBall } from './pokeball';
import type { CoinView } from '@/lib/shared/types';

const short = (mint: string) => `${mint.slice(0, 6)}…${mint.slice(-6)}`;
const LINKS = [
  { label: 'pump.fun', href: (mint: string) => `https://pump.fun/coin/${mint}` },
  { label: 'DexScreener', href: (mint: string) => `https://dexscreener.com/solana/${mint}` },
  { label: 'Solscan', href: (mint: string) => `https://solscan.io/token/${mint}` },
];

function useCopy(text: string) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1600); }
    catch { window.prompt('Copy the contract address:', text); }
  };
  return { copied, copy };
}

/**
 * Our coin's contract address on the navy bands, with copy and market links. It shows once MEMECOIN_MINT
 * is set; until then practice mode shows where it will go, and mainnet shows nothing.
 */
export function CoinAddress({ coin, practice, variant }: { coin: CoinView | null; practice: boolean; variant: 'hero' | 'footer' }) {
  if (!coin) return practice ? <Placeholder variant={variant} /> : null;
  return variant === 'hero' ? <HeroCoin coin={coin} /> : <FooterCoin coin={coin} />;
}

function HeroCoin({ coin }: { coin: CoinView }) {
  const { copied, copy } = useCopy(coin.mint);
  return (
    <div className="w-full max-w-xl rounded-2xl bg-white/[0.07] p-3 ring-1 ring-white/15 backdrop-blur-sm">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-1">
        <span className="flex items-center gap-2 text-xs font-semibold text-white/80">
          <PokeBall size={16} />Our coin{coin.ticker && <span className="text-poke-yellow">{coin.ticker}</span>}<span className="font-normal text-white/50">· contract address</span>
        </span>
        <span className="flex gap-3 text-xs">
          {LINKS.map(l => <a key={l.label} href={l.href(coin.mint)} target="_blank" rel="noreferrer" className="text-white/60 underline-offset-2 hover:text-white hover:underline">{l.label}</a>)}
        </span>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button onClick={() => void copy()} title={coin.mint} aria-label={`Copy contract address ${coin.mint}`}
          className="min-w-0 flex-1 truncate rounded-xl bg-navy/60 px-3 py-2.5 text-left font-mono text-[13px] text-white transition hover:bg-navy/80">
          <span className="sm:hidden">{short(coin.mint)}</span><span className="hidden sm:inline">{coin.mint}</span>
        </button>
        <button onClick={() => void copy()} aria-live="polite"
          className={`inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl px-3.5 text-sm font-semibold transition ${copied ? 'bg-uncommon text-white' : 'bg-poke-yellow text-ink hover:bg-[#ffd83d]'}`}>
          {copied ? <><Check size={15} strokeWidth={3} />Copied</> : <><Copy size={15} />Copy</>}
        </button>
      </div>
    </div>
  );
}

function FooterCoin({ coin }: { coin: CoinView }) {
  const { copied, copy } = useCopy(coin.mint);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      <span className="rounded-md bg-white/10 px-1.5 py-0.5 font-semibold text-white">CA{coin.ticker ? ` ${coin.ticker}` : ''}</span>
      <button onClick={() => void copy()} title={coin.mint} aria-label={`Copy contract address ${coin.mint}`} className="inline-flex items-center gap-1.5 font-mono text-white/80 hover:text-white">
        {short(coin.mint)}{copied ? <Check size={13} className="text-uncommon" /> : <Copy size={13} />}
      </button>
      <a href={LINKS[0].href(coin.mint)} target="_blank" rel="noreferrer" className="underline-offset-2 hover:text-white hover:underline">pump.fun</a>
    </div>
  );
}

function Placeholder({ variant }: { variant: 'hero' | 'footer' }) {
  if (variant === 'footer') return <span className="text-xs"><span className="rounded-md bg-white/10 px-1.5 py-0.5 font-semibold text-white">CA</span> <span className="text-white/50">coming at launch</span></span>;
  return (
    <div className="flex w-full max-w-xl items-center gap-2 rounded-2xl border border-dashed border-white/25 px-4 py-3 text-xs text-white/60">
      <PokeBall size={16} /><span className="font-semibold text-white/80">Our coin</span> · contract address coming at launch
    </div>
  );
}
