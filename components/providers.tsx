'use client';
import '@solana/wallet-adapter-react-ui/styles.css';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ConnectionProvider, WalletProvider, useWallet } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare';
import { UnsafeBurnerWalletAdapter } from '@solana/wallet-adapter-unsafe-burner';
import bs58 from 'bs58';
import { apiGet, apiPost } from '@/lib/client/api';
import type { MeView } from '@/lib/shared/types';

type Session = {
  practice: boolean;
  me: MeView | null;
  /** The connected wallet has a server session. */
  signedIn: boolean;
  signingIn: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  setMe: (me: MeView) => void;
  refresh: () => Promise<void>;
};
const SessionContext = createContext<Session | null>(null);
export const useSession = () => { const s = useContext(SessionContext); if (!s) throw new Error('useSession outside Providers'); return s; };

function SessionProvider({ practice, children }: { practice: boolean; children: ReactNode }) {
  const { publicKey, signMessage, disconnect } = useWallet();
  const [me, setMe] = useState<MeView | null>(null), [signingIn, setSigningIn] = useState(false);
  const loadMe = () => apiGet<MeView>('/api/me').catch((): MeView => ({ wallet: null }));
  const refresh = useCallback(async () => { setMe(await loadMe()); }, []);
  // Re-read the session whenever the connected wallet changes.
  useEffect(() => { let live = true; void loadMe().then(m => { if (live) setMe(m); }); return () => { live = false; }; }, [publicKey]);
  const address = publicKey?.toBase58() ?? null;
  const signedIn = !!address && me?.wallet === address;

  const signIn = useCallback(async () => {
    if (!address || !signMessage) throw new Error('This wallet cannot sign messages. Try Phantom or Solflare.');
    setSigningIn(true);
    try {
      const { id, message } = await apiPost<{ id: string; message: string }>('/api/auth/challenge', { wallet: address });
      const signature = await signMessage(new TextEncoder().encode(message));
      await apiPost('/api/auth/verify', { id, signature: bs58.encode(signature) });
      await refresh();
    } finally { setSigningIn(false); }
  }, [address, signMessage, refresh]);

  const signOut = useCallback(async () => { await apiPost('/api/auth/logout').catch(() => {}); await disconnect().catch(() => {}); await refresh(); }, [disconnect, refresh]);

  const value = useMemo(() => ({ practice, me, signedIn, signingIn, signIn, signOut, setMe, refresh }), [practice, me, signedIn, signingIn, signIn, signOut, refresh]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function Providers({ practice, children }: { practice: boolean; children: ReactNode }) {
  // Payments are signed in the wallet and sent by the server, so this RPC is only a fallback for the adapters.
  const endpoint = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter(), ...(practice ? [new UnsafeBurnerWalletAdapter()] : [])], [practice]);
  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <SessionProvider practice={practice}>{children}</SessionProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
