import type { Metadata } from 'next';
import { Inter, Silkscreen } from 'next/font/google';
import './globals.css';
import { Providers } from '@/components/providers';
import { Nav } from '@/components/nav';
import { APP_NAME, APP_TAGLINE } from '@/lib/shared/brand';

const inter = Inter({ variable: '--font-inter', subsets: ['latin'] });
const silkscreen = Silkscreen({ variable: '--font-silkscreen', weight: '400', subsets: ['latin'] });

export const metadata: Metadata = { title: APP_NAME, description: `${APP_TAGLINE}. You can lose your entire pack price.` };

export default function RootLayout({ children }: LayoutProps<'/'>) {
  // Practice mode unless mainnet is explicitly on; read at build/start, never per request.
  const practice = process.env.MAINNET_ENABLED !== 'true';
  return (
    <html lang="en" className={`${inter.variable} ${silkscreen.variable} h-full`}>
      <body className="flex min-h-full flex-col">
        <Providers practice={practice}>
          <Nav />
          <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-20 pt-6 sm:pt-10">{children}</main>
          <footer className="border-t border-line px-4 py-6 text-center text-xs text-muted">
            {APP_NAME} is an independent add-on to Collector Crypt packs, funded by our coin&apos;s creator fees. Leverage packs are high risk: you can lose your entire pack price. 18+.
          </footer>
        </Providers>
      </body>
    </html>
  );
}
