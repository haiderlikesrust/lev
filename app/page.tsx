import Link from 'next/link';
import { Suspense, type ReactNode } from 'react';
import { connection } from 'next/server';
import { ArrowDown, ArrowRight, Ban, Coins, Eye, Flame, HandCoins, PackageOpen, Receipt, Scale, Shield, ShieldCheck, Timer, Trophy, TrendingDown, Wallet } from 'lucide-react';
import { HomeDataProvider } from '@/components/home/home-data';
import { Hero } from '@/components/home/hero';
import { StatsBand } from '@/components/home/stats-band';
import { MachineShowcase } from '@/components/home/machine-showcase';
import { LivePulls } from '@/components/home/live-pulls';
import { PayoutCalculator } from '@/components/home/payout-calculator';
import { IconBadge, SectionHead } from '@/components/ui';
import { PokeBall } from '@/components/pokeball';
import { CoinAddress } from '@/components/coin-address';
import { APP_NAME } from '@/lib/shared/brand';
import { config } from '@/lib/server/config';
import { coinView } from '@/lib/server/coin';

const STEPS = [
  { icon: <Wallet size={20} />, tone: 'blue', title: 'Pay the pack price', text: 'One USDC payment from your wallet. Terms are locked when you confirm.' },
  { icon: <PackageOpen size={20} />, tone: 'red', title: 'The pool opens it', text: 'Our pool wallet buys and opens the Collector Crypt pack, so it holds the card.' },
  { icon: <Scale size={20} />, tone: 'yellow', title: 'Value decides', text: 'Below the price is a loss, within 5% a push, above it a win, by CC’s insured value.' },
  { icon: <Receipt size={20} />, tone: 'green', title: 'Settled & logged', text: 'Card and bonus to you, or the card is sold back. Every transaction is public.' },
] as const;

export default function Home() {
  return (
    <HomeDataProvider>
      <div className="space-y-16 sm:space-y-20">
        <div className="space-y-4">
          <Hero coinAddress={<Suspense><HeroCoinAddress /></Suspense>} />
          <StatsBand />
        </div>

        <section>
          <SectionHead kicker="Machines" title="Pick a machine" lede="Real Collector Crypt machines. Each one gets its own multipliers, worked out from its recent pulls."
            action={<Link href="/open" className="inline-flex items-center gap-1.5 text-sm font-semibold text-poke-red hover:underline">Open a pack <ArrowRight size={16} /></Link>} />
          <MachineShowcase />
        </section>

        <LivePulls />

        <section>
          <SectionHead kicker="How it works" title="Four steps, fully on-chain" />
          <ol className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((s, i) => (
              <li key={s.title} className="relative rounded-3xl border border-line bg-white p-5 shadow-card">
                <div className="flex items-center justify-between">
                  <IconBadge tone={s.tone}>{s.icon}</IconBadge>
                  <span className="font-pixel text-xs text-muted">0{i + 1}</span>
                </div>
                <h3 className="mt-4 text-lg font-bold">{s.title}</h3>
                <p className="mt-1 text-sm text-muted">{s.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="grid grid-cols-1 gap-6 lg:grid-cols-[1.15fr_1fr]">
          <div>
            <SectionHead kicker="Try it" title="What would you get?" lede="Drag the card's value, or tap a row of the example." />
            <PayoutCalculator />
          </div>
          <div>
            <SectionHead kicker="Levels" title="Pick your risk" />
            <div className="grid grid-cols-1 gap-3">
              <Level icon={<Shield size={20} />} tone="blue" name="Half risk" range="about 1.4–1.9x" text="Lose, and you still get half of what Collector Crypt pays to buy the card back." />
              <Level icon={<Flame size={20} />} tone="red" name="Full risk" range="about 2.1–2.9x" text="Lose, and you get nothing. The multiplier is higher." />
              <Link href="/open?side=short" className="block transition hover:-translate-y-0.5">
                <Level icon={<TrendingDown size={20} />} tone="navy" name="Short" range="about 0.5–2x per $1 under" text="Bet the next card anyone pulls is under the pack price. Wins often but small; a good card takes your stake." />
              </Link>
              <div className="rounded-3xl border border-dashed border-line p-5 text-sm text-muted">
                Every level leaves the pool the same small edge (about 3–5%): your average is a normal open&apos;s minus that edge, or just minus the edge on a short. <Link href="/docs#multipliers" className="font-semibold text-poke-blue hover:underline">See the math</Link>
              </div>
            </div>
          </div>
        </section>

        <section>
          <SectionHead kicker="The pool" title="The pool sits in the middle" lede="A separate wallet, so leverage never touches Pullback's loss coverage. Bigger machines unlock as it grows." />
          <div className="grid grid-cols-1 items-stretch gap-3 lg:grid-cols-[1fr_auto_1.1fr_auto_1fr]">
            <FlowNode icon={<TrendingDown size={20} />} tone="red" title="Losing packs" text="The card is sold back to Collector Crypt; the USDC goes to the pool." />
            <FlowArrow />
            <div className="dots relative flex flex-col items-center justify-center overflow-hidden rounded-3xl bg-navy p-6 text-center text-white">
              <PokeBall size={44} />
              <div className="mt-3 font-display text-xl font-bold">Leverage pool</div>
              <div className="mt-1 text-sm text-white/70">+ 85% of our coin&apos;s creator fees</div>
              <Link href="/pool" className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-poke-yellow hover:underline">See it live <ArrowRight size={14} /></Link>
            </div>
            <FlowArrow />
            <FlowNode icon={<Trophy size={20} />} tone="yellow" title="Winning packs" text="The card plus a bonus, paid from the pool straight to the winner." />
          </div>
        </section>

        <section className="rounded-[2rem] bg-white p-6 shadow-card sm:p-8">
          <SectionHead kicker="Play responsibly" title="Built to keep it a game" />
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Rule icon={<ShieldCheck size={18} />} text="Off until you turn it on for your wallet." />
            <Rule icon={<Eye size={18} />} text="“HIGH RISK — you can lose your entire pack price” on every pack." />
            <Rule icon={<HandCoins size={18} />} text="Set your own daily loss limit any time." />
            <Rule icon={<Timer size={18} />} text={`5 losses in a row and ${APP_NAME} gives your wallet a short break.`} />
            <Rule icon={<Ban size={18} />} text="No discounts or “open another” prompts after a loss." />
            <Rule icon={<Coins size={18} />} text="On average every level returns less than you pay, like a normal open." />
          </ul>
        </section>

        <section className="dots relative overflow-hidden rounded-[2rem] bg-navy px-6 py-10 text-center text-white sm:px-10">
          <div className="hero-glow absolute inset-0" />
          <div className="relative">
            <h2 className="text-3xl font-extrabold sm:text-4xl">See every outcome before you pay.</h2>
            <p className="mx-auto mt-3 max-w-xl text-white/70">Odds, the biggest possible bonus and the average result are on screen before you confirm, and every pack&apos;s transactions are public.</p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <Link href="/open" className="inline-flex h-12 items-center gap-2 rounded-full bg-poke-red px-6 font-semibold transition hover:bg-poke-red-dark">Choose a machine <ArrowRight size={18} /></Link>
              <Link href="/leaderboard" className="inline-flex h-12 items-center gap-2 rounded-full bg-white/10 px-6 font-semibold ring-1 ring-white/20 transition hover:bg-white/15"><Trophy size={18} /> Leaderboard</Link>
            </div>
          </div>
        </section>
      </div>
    </HomeDataProvider>
  );
}

/** Per request: the coin address and practice mode come from the server's environment, not the build's (see app/layout.tsx). */
async function HeroCoinAddress() {
  await connection();
  return <CoinAddress coin={coinView()} practice={!config.live} variant="hero" />;
}

function Level({ icon, tone, name, range, text }: { icon: ReactNode; tone: 'blue' | 'red' | 'navy'; name: string; range: string; text: string }) {
  return (
    <div className="flex gap-4 rounded-3xl border border-line bg-white p-5 shadow-card">
      <IconBadge tone={tone}>{icon}</IconBadge>
      <div>
        <div className="flex flex-wrap items-baseline gap-x-2"><h3 className="text-lg font-bold">{name}</h3><span className="text-sm text-muted">{range}</span></div>
        <p className="mt-1 text-sm text-muted">{text}</p>
      </div>
    </div>
  );
}

function FlowNode({ icon, tone, title, text }: { icon: ReactNode; tone: 'red' | 'yellow'; title: string; text: string }) {
  return (
    <div className="rounded-3xl border border-line bg-white p-5 shadow-card">
      <IconBadge tone={tone}>{icon}</IconBadge>
      <h3 className="mt-4 text-lg font-bold">{title}</h3>
      <p className="mt-1 text-sm text-muted">{text}</p>
    </div>
  );
}

function FlowArrow() {
  return <div className="flex items-center justify-center text-muted"><ArrowDown size={22} className="lg:-rotate-90" /></div>;
}

function Rule({ icon, text }: { icon: ReactNode; text: string }) {
  return <li className="flex items-start gap-3 text-sm"><span className="mt-0.5 text-poke-red">{icon}</span><span>{text}</span></li>;
}
