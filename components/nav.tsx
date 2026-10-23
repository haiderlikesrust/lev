'use client';
import { useEffect, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { useWallet } from '@solana/wallet-adapter-react';
import { BookOpen, Check, ChevronDown, Coins, History, House, Menu, PackageOpen, Settings2, Trophy, X, type LucideIcon } from 'lucide-react';
import { Wordmark } from './logo';
import { useSession } from './providers';

// The wallet button reads browser-only wallet state, so it renders on the client only.
const WalletMultiButton = dynamic(() => import('@solana/wallet-adapter-react-ui').then(m => m.WalletMultiButton), { ssr: false, loading: () => <div className="h-10 w-28 rounded-full bg-white/10 sm:w-36" /> });

/** Each page is a divider tab in a card binder, with its own coloured label strip. */
type Tab = {
  href: string; label: string; hint: string; icon: LucideIcon; color: string;
  /** The icon's colour on paper, where the strip colour is too light. */
  ink?: string;
};
const TABS: Tab[] = [
  { href: '/', label: 'Home', hint: 'How it works and live stats', icon: House, color: 'var(--color-poke-red)' },
  { href: '/open', label: 'Open', hint: 'Leverage packs and shorts', icon: PackageOpen, color: 'var(--color-poke-yellow)', ink: 'var(--color-poke-yellow-dark)' },
  { href: '/pool', label: 'Pool', hint: 'Balance, health and every settlement', icon: Coins, color: 'var(--color-uncommon)' },
  { href: '/leaderboard', label: 'Leaderboard', hint: 'Biggest wins, with proof', icon: Trophy, color: 'var(--color-rare)' },
  { href: '/history', label: 'History', hint: 'Your packs and limits', icon: History, color: 'var(--color-epic)' },
  { href: '/docs', label: 'Docs', hint: 'The rules and the math', icon: BookOpen, color: 'var(--color-push)' },
];
const ADMIN: Tab = { href: '/admin', label: 'Admin', hint: 'Owner settings and review', icon: Settings2, color: 'var(--color-common)' };

/**
 * A navy band. On wide screens its bottom edge holds binder tabs: the current page's tab is paper-coloured
 * and flows into the page below, the others sit a little sunk until hovered. Narrower screens get a dropdown
 * of the same tabs as index cards. The practice banner scrolls away; the band stays.
 */
export function Nav() {
  const path = usePathname();
  const { connected } = useWallet();
  const { practice, signedIn, signingIn, signIn, me } = useSession();
  const tabs = [...TABS, ...(me?.wallet && me.owner ? [ADMIN] : [])];
  const current = tabs.find(t => t.href === path) ?? null;
  const needsSignIn = connected && !signedIn;
  const doSignIn = () => void signIn().catch(e => alert((e as Error).message));

  // The dropdown belongs to the page it was opened on, so navigating closes it.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === path, close = () => setOpenOn(null);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenOn(null); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [open]);

  return (
    <header className={`sticky z-30 ${practice ? '-top-7' : 'top-0'}`}>
      {practice && (
        <div className="h-7 truncate bg-poke-yellow px-4 text-center text-xs font-semibold leading-7 text-ink">
          Practice mode<span className="hidden sm:inline">: play money, real Collector Crypt odds. Nothing here costs anything.</span><span className="sm:hidden"> · play money</span>
        </div>
      )}
      <div className="nav-band dots relative bg-navy text-white">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-2 px-4 sm:gap-3 xl:h-16">
          <Link href="/" onClick={close} className="shrink-0 rounded-lg transition hover:scale-[1.04] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-poke-yellow">
            <Wordmark priority className="h-8 xl:h-9" />
          </Link>

          <nav className="ml-4 hidden self-stretch xl:flex" aria-label="Main">
            <TabRow tabs={tabs} path={path} />
          </nav>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            {needsSignIn && (
              <button onClick={doSignIn} disabled={signingIn}
                className="hidden h-10 items-center rounded-full bg-poke-blue px-4 text-sm font-semibold text-white transition hover:bg-poke-blue-dark disabled:opacity-50 sm:inline-flex">
                {signingIn ? 'Signing…' : 'Sign in'}
              </button>
            )}
            <WalletMultiButton />
            <button onClick={() => setOpenOn(open ? null : path)} aria-expanded={open} aria-controls="site-menu" aria-label={open ? 'Close menu' : 'Open menu'}
              className="relative flex h-10 shrink-0 items-center justify-center gap-2 rounded-full bg-white/10 text-sm font-semibold transition hover:bg-white/[0.16] focus-visible:outline-2 focus-visible:outline-poke-yellow max-sm:w-10 sm:pl-3.5 sm:pr-3 xl:hidden">
              <span className="max-sm:hidden h-2.5 w-2.5 rounded-full" style={{ background: current?.color ?? 'white' }} />
              <span className="max-sm:hidden">{current?.label ?? 'Menu'}</span>
              <span className="max-sm:hidden"><ChevronDown size={16} className={`transition ${open ? 'rotate-180' : ''}`} /></span>
              <span className="sm:hidden">{open ? <X size={20} /> : <Menu size={20} />}</span>
              {needsSignIn && !open && <span className="absolute right-0.5 top-0.5 h-2.5 w-2.5 rounded-full border-2 border-navy bg-poke-blue sm:hidden" />}
            </button>
          </div>
        </div>

        {open && (
          <>
            <button aria-label="Close menu" tabIndex={-1} onClick={close} className="fixed inset-0 -z-10 cursor-default bg-ink/40 xl:hidden" />
            <div id="site-menu" className="menu-drop absolute inset-x-0 top-full max-h-[calc(100dvh-5rem)] overflow-y-auto rounded-b-3xl border-b border-line bg-paper text-ink shadow-lift xl:hidden">
              <nav className="mx-auto grid max-w-6xl grid-cols-1 gap-2 px-4 py-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Main">
                {tabs.map(t => <IndexCard key={t.href} tab={t} on={t.href === path} onPick={close} />)}
              </nav>
              {needsSignIn && (
                <div className="mx-auto max-w-6xl px-4 pb-4 sm:hidden">
                  <button onClick={() => { close(); doSignIn(); }} disabled={signingIn} className="h-12 w-full rounded-full bg-poke-blue text-sm font-semibold text-white disabled:opacity-50">
                    {signingIn ? 'Signing…' : 'Sign in with your wallet'}
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </header>
  );
}

function TabRow({ tabs, path }: { tabs: Tab[]; path: string }) {
  return (
    <div className="flex shrink-0 items-end gap-1.5 overflow-hidden px-3.5">
      {tabs.map(t => {
        const on = path === t.href;
        return (
          <Link key={t.href} href={t.href} aria-current={on ? 'page' : undefined} style={{ '--tab': t.color } as CSSProperties}
            className={`binder-tab flex h-11 shrink-0 items-center gap-1.5 rounded-t-xl border-t-[3px] px-3 text-sm font-semibold transition duration-200 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-poke-yellow ${on
              ? 'border-[var(--tab)] bg-paper text-ink'
              : 'translate-y-1 border-[color-mix(in_srgb,var(--tab)_45%,transparent)] bg-white/[0.07] text-white/70 hover:translate-y-0 hover:bg-white/[0.13] hover:text-white'}`}>
            <t.icon size={16} strokeWidth={2.25} aria-hidden className={`shrink-0 ${on ? '' : 'opacity-80'}`} style={on ? { color: t.ink ?? t.color } : undefined} />
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}

/** A page in the dropdown: an index card with the tab's colour down its edge. */
function IndexCard({ tab, on, onPick }: { tab: Tab; on: boolean; onPick: () => void }) {
  return (
    <Link href={tab.href} onClick={onPick} aria-current={on ? 'page' : undefined} style={{ borderLeftColor: tab.color }}
      className={`flex items-center gap-3 rounded-2xl border border-l-[5px] bg-white py-3 pl-3 pr-4 shadow-card transition hover:-translate-y-0.5 hover:shadow-lift ${on ? 'border-ink' : 'border-line'}`}>
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl" style={{ background: `color-mix(in srgb, ${tab.color} 16%, transparent)`, color: tab.ink ?? tab.color }}>
        <tab.icon size={19} strokeWidth={2.25} aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">{tab.label}</span>
        <span className="block truncate text-xs text-muted">{tab.hint}</span>
      </span>
      {on && <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ink text-white"><Check size={14} strokeWidth={3} aria-label="You are here" /></span>}
    </Link>
  );
}
