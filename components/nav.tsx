'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { useWallet } from '@solana/wallet-adapter-react';
import { Menu, X } from 'lucide-react';
import { PokeBall } from './pokeball';
import { useSession } from './providers';
import { APP_NAME } from '@/lib/shared/brand';

// The wallet button reads browser-only wallet state, so it renders on the client only.
const WalletMultiButton = dynamic(() => import('@solana/wallet-adapter-react-ui').then(m => m.WalletMultiButton), { ssr: false, loading: () => <div className="h-10 w-28 rounded-full bg-mist sm:w-36" /> });

const LINKS = [{ href: '/', label: 'Home' }, { href: '/open', label: 'Open' }, { href: '/pool', label: 'Pool' }, { href: '/history', label: 'History' }, { href: '/docs', label: 'Docs' }];

export function Nav() {
  const path = usePathname();
  const { connected } = useWallet();
  const { practice, signedIn, signingIn, signIn, me } = useSession();
  // The menu belongs to the page it was opened on, so navigating closes it.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === path;
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenOn(null); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [open]);

  const links = [...LINKS, ...(me?.wallet && me.owner ? [{ href: '/admin', label: 'Admin' }] : [])];
  const needsSignIn = connected && !signedIn;
  const doSignIn = () => void signIn().catch(e => alert((e as Error).message));

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-white/90 backdrop-blur">
      {practice && (
        <div className="bg-poke-yellow px-4 py-1.5 text-center text-xs font-semibold text-ink">
          Practice mode<span className="hidden sm:inline">: play money, real Collector Crypt odds. Nothing here costs anything.</span><span className="sm:hidden"> · play money</span>
        </div>
      )}
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-2 px-4 sm:gap-3">
        <Link href="/" className="flex min-w-0 shrink-0 items-center gap-2" onClick={() => setOpenOn(null)}>
          <PokeBall size={26} />
          <span className="truncate text-[15px] font-bold tracking-tight max-[360px]:hidden">{APP_NAME}</span>
        </Link>

        <nav className="ml-3 hidden items-center gap-1 md:flex" aria-label="Main">
          {links.map(l => (
            <Link key={l.href} href={l.href} aria-current={path === l.href ? 'page' : undefined}
              className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${path === l.href ? 'bg-ink text-white' : 'text-muted hover:bg-mist hover:text-ink'}`}>
              {l.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {needsSignIn && (
            <button onClick={doSignIn} disabled={signingIn}
              className="hidden h-10 rounded-full bg-poke-blue px-4 text-sm font-semibold text-white transition hover:bg-poke-blue-dark disabled:opacity-50 md:inline-flex md:items-center">
              {signingIn ? 'Signing…' : 'Sign in'}
            </button>
          )}
          <WalletMultiButton />
          <button onClick={() => setOpenOn(open ? null : path)} aria-expanded={open} aria-controls="mobile-menu" aria-label={open ? 'Close menu' : 'Open menu'}
            className="relative flex h-10 w-10 items-center justify-center rounded-full bg-mist text-ink transition hover:bg-line md:hidden">
            {open ? <X size={20} /> : <Menu size={20} />}
            {needsSignIn && !open && <span className="absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-poke-blue" />}
          </button>
        </div>
      </div>

      {open && (
        <div id="mobile-menu" className="border-t border-line bg-white px-4 pb-5 pt-2 shadow-sm md:hidden">
          <nav className="flex flex-col" aria-label="Main">
            {links.map(l => (
              <Link key={l.href} href={l.href} onClick={() => setOpenOn(null)} aria-current={path === l.href ? 'page' : undefined}
                className={`flex h-12 items-center justify-between rounded-2xl px-4 text-base font-medium ${path === l.href ? 'bg-mist text-ink' : 'text-muted'}`}>
                {l.label}
                {path === l.href && <span className="h-2 w-2 rounded-full bg-poke-red" />}
              </Link>
            ))}
          </nav>
          {needsSignIn && (
            <button onClick={doSignIn} disabled={signingIn} className="mt-3 h-12 w-full rounded-full bg-poke-blue text-sm font-semibold text-white disabled:opacity-50">
              {signingIn ? 'Signing…' : 'Sign in with your wallet'}
            </button>
          )}
        </div>
      )}
    </header>
  );
}
