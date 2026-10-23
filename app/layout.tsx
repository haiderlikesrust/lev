import type { Metadata } from 'next';
import { Suspense, type ReactNode } from 'react';
import { connection } from 'next/server';
import { Bricolage_Grotesque, Inter, Silkscreen } from 'next/font/google';
import './globals.css';
import { Providers } from '@/components/providers';
import { Nav } from '@/components/nav';
import { Wordmark } from '@/components/logo';
import { CoinAddress } from '@/components/coin-address';
import { coinView } from '@/lib/server/coin';
import { APP_NAME, APP_TAGLINE } from '@/lib/shared/brand';

const inter = Inter({ variable: '--font-inter', subsets: ['latin'] });
const silkscreen = Silkscreen({ variable: '--font-silkscreen', weight: '400', subsets: ['latin'] });
const bricolage = Bricolage_Grotesque({ variable: '--font-bricolage', subsets: ['latin'] });

// Icons and the link preview come from app/icon.png, apple-icon.png and opengraph-image.png.
export const metadata: Metadata = {
  metadataBase: new URL(process.env.APP_ORIGIN || 'https://long.cards'),
  title: { default: APP_NAME, template: `%s · ${APP_NAME}` },
  description: `${APP_TAGLINE}. High risk: you can lose your entire stake.`,
  openGraph: { siteName: APP_NAME },
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`${inter.variable} ${silkscreen.variable} ${bricolage.variable} h-full`}>
      <body className="flex min-h-full flex-col">
        <Suspense><Site>{children}</Site></Suspense>
      </body>
    </html>
  );
}

/**
 * Rendered per request, so the server's environment decides practice mode and the coin address. Read
 * at build time instead, a Docker image would keep whatever the build machine had (nothing).
 */
async function Site({ children }: { children: ReactNode }) {
  await connection();
  // Practice mode unless mainnet is explicitly on.
  const practice = process.env.MAINNET_ENABLED !== 'true';
  return (
    <Providers practice={practice}>
      <Nav />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-20 pt-6 sm:pt-10">{children}</main>
      <footer className="bg-navy text-white/70">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 text-xs sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-2.5">
            <Wordmark className="h-7" />
            <CoinAddress coin={coinView()} practice={practice} variant="footer" />
          </div>
          <span className="max-w-2xl sm:text-right">An independent add-on to Collector Crypt packs, funded by our coin&apos;s creator fees. Leverage packs are high risk: you can lose your entire pack price. 18+.</span>
        </div>
      </footer>
    </Providers>
  );
}
