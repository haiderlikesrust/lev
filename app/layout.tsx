import type { Metadata } from 'next';
import { Bricolage_Grotesque, Inter, Silkscreen } from 'next/font/google';
import './globals.css';
import { Providers } from '@/components/providers';
import { Nav } from '@/components/nav';
import { APP_NAME, APP_TAGLINE } from '@/lib/shared/brand';

const inter = Inter({ variable: '--font-inter', subsets: ['latin'] });
const silkscreen = Silkscreen({ variable: '--font-silkscreen', weight: '400', subsets: ['latin'] });
const bricolage = Bricolage_Grotesque({ variable: '--font-bricolage', subsets: ['latin'] });

export const metadata: Metadata = { title: APP_NAME, description: `${APP_TAGLINE}. You can lose your entire pack price.` };

export default function RootLayout({ children }: LayoutProps<'/'>) {
  // Practice mode unless mainnet is explicitly on; read at build/start, never per request.
  const practice = process.env.MAINNET_ENABLED !== 'true';
  return (
    <html lang="en" className={`${inter.variable} ${silkscreen.variable} ${bricolage.variable} h-full`}>
      <body className="flex min-h-full flex-col">
        <Providers practice={practice}>
          <Nav />
          <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-20 pt-6 sm:pt-10">{children}</main>
          <footer className="bg-navy text-white/70">
            <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 text-xs sm:flex-row sm:items-center sm:justify-between">
              <span className="font-display text-sm font-bold text-white">{APP_NAME}</span>
              <span className="max-w-2xl sm:text-right">An independent add-on to Collector Crypt packs, funded by our coin&apos;s creator fees. Leverage packs are high risk: you can lose your entire pack price. 18+.</span>
            </div>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
