import type { ReactNode } from 'react';
import { ArrowUpRight, Lock } from 'lucide-react';
import type { Outcome } from '@/lib/shared/leverage';

/** A link that opens in a new tab, marked with an arrow icon. */
export function ExternalLink({ href, children, className = 'text-xs' }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={`inline-flex items-center gap-0.5 text-poke-blue underline-offset-2 hover:underline ${className}`}>
      {children}<ArrowUpRight size={12} strokeWidth={2.25} aria-hidden className="shrink-0" />
    </a>
  );
}

/** A locked level or machine, with a lock icon. */
export function Locked({ children, title }: { children?: ReactNode; title?: string }) {
  return <span title={title} className="inline-flex items-center gap-1 text-xs text-muted"><Lock size={12} strokeWidth={2.25} aria-hidden className="shrink-0" />{children}</span>;
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-3xl border border-line bg-white p-5 shadow-card sm:p-6 ${className}`}>{children}</div>;
}

/** A section heading: pixel kicker, display title, optional lede and action. */
export function SectionHead({ kicker, title, lede, action }: { kicker: string; title: ReactNode; lede?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="max-w-2xl">
        <div className="font-pixel text-[11px] uppercase tracking-wider text-poke-red">{kicker}</div>
        <h2 className="mt-1.5 text-2xl font-bold sm:text-3xl">{title}</h2>
        {lede && <p className="mt-2 text-muted">{lede}</p>}
      </div>
      {action}
    </div>
  );
}

/** A small round icon badge. */
export function IconBadge({ children, tone = 'red' }: { children: ReactNode; tone?: 'red' | 'blue' | 'yellow' | 'navy' | 'green' }) {
  const tones = { red: 'bg-poke-red/10 text-poke-red', blue: 'bg-poke-blue/10 text-poke-blue', yellow: 'bg-poke-yellow/25 text-poke-yellow-dark', navy: 'bg-ink/8 text-ink', green: 'bg-uncommon/12 text-uncommon' };
  return <span className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ${tones[tone]}`}>{children}</span>;
}

export function Label({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`font-pixel text-[11px] uppercase tracking-wider text-muted ${className}`}>{children}</div>;
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="min-w-0">
      <Label>{label}</Label>
      <div className="mt-1 truncate text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </div>
  );
}

export function Button({ children, onClick, disabled, variant = 'primary', type = 'button', className = '' }: {
  children: ReactNode; onClick?: () => void; disabled?: boolean; variant?: 'primary' | 'red' | 'ghost'; type?: 'button' | 'submit'; className?: string;
}) {
  const styles = {
    primary: 'bg-ink text-white hover:bg-black',
    red: 'bg-poke-red text-white hover:bg-poke-red-dark',
    ghost: 'bg-mist text-ink hover:bg-line',
  }[variant];
  return (
    <button type={type} onClick={onClick} disabled={disabled}
      className={`inline-flex h-11 items-center justify-center gap-2 rounded-full px-5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${styles} ${className}`}>
      {children}
    </button>
  );
}

const OUTCOME = {
  loss: { label: 'Loss', className: 'bg-loss/10 text-loss' },
  push: { label: 'Push', className: 'bg-push/15 text-ink' },
  win: { label: 'Win', className: 'bg-poke-yellow/40 text-ink' },
} as const;
export function OutcomeBadge({ outcome }: { outcome: Outcome }) {
  const o = OUTCOME[outcome];
  return <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${o.className}`}>{o.label}</span>;
}

export function HighRisk({ className = '' }: { className?: string }) {
  return <span className={`inline-flex items-center rounded-full bg-poke-red px-2.5 py-0.5 font-pixel text-[10px] uppercase tracking-wider text-white ${className}`}>High risk</span>;
}

/** The rarity colour CC's tiers map to. */
export function rarityColor(rarity: string | null | undefined) {
  const r = (rarity ?? '').toLowerCase();
  return r === 'epic' ? 'var(--color-epic)' : r === 'rare' ? 'var(--color-rare)' : r === 'uncommon' ? 'var(--color-uncommon)' : 'var(--color-common)';
}

/** A transaction link (Solscan), or the bare signature in practice mode. */
export function TxLink({ label, signature, practice, cluster }: { label: string; signature?: string | null; practice: boolean; cluster?: string }) {
  if (!signature) return null;
  const short = `${signature.slice(0, 6)}…`;
  // Practice signatures are simulated, so there is nothing on Solscan to link to.
  if (practice) return <span className="cursor-help text-xs text-muted underline decoration-dotted underline-offset-2" title="Simulated in practice mode. On mainnet this links to the transaction on Solscan.">{label} <span className="font-mono">{short}</span></span>;
  return <ExternalLink href={`https://solscan.io/tx/${signature}${cluster ? `?cluster=${cluster}` : ''}`}>{label}</ExternalLink>;
}
