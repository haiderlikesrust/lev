import Link from 'next/link';
import { Card, HighRisk, Label } from '@/components/ui';
import { PokeBall } from '@/components/pokeball';
import { LiveLevels } from '@/components/live-levels';
import { APP_NAME } from '@/lib/shared/brand';

const EXAMPLE = [
  { card: 60, full: 'You get $0. The pool keeps the card and sells it back to Collector Crypt.', half: 'You get $27: half of the $54 sellback.' },
  { card: 100, full: 'You get the card.', half: 'You get the card.' },
  { card: 300, full: 'You get the card + a $100 bonus.', half: 'You get the card + a $100 bonus.' },
];

export default function Home() {
  return (
    <div className="space-y-14">
      <section className="grid items-center gap-10 md:grid-cols-[1.2fr_1fr]">
        <div>
          <HighRisk />
          <h1 className="mt-4 text-4xl font-bold leading-tight tracking-tight sm:text-5xl">
            Leverage your next<br /><span className="text-poke-red">Collector Crypt</span> pull.
          </h1>
          <p className="mt-5 max-w-xl text-lg text-muted">
            Beat the pack price and the pool pays you a bonus on top of your card. Miss it, and you lose the card. It&apos;s optional, and you can lose your entire pack price.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link href="/open" className="inline-flex h-12 items-center rounded-full bg-poke-red px-6 font-semibold text-white transition hover:bg-poke-red-dark">Choose a machine</Link>
            <Link href="/pool" className="inline-flex h-12 items-center rounded-full bg-mist px-6 font-semibold text-ink transition hover:bg-line">See the pool</Link>
          </div>
        </div>
        <div className="relative mx-auto hidden aspect-square w-full max-w-sm items-center justify-center md:flex">
          <div className="absolute inset-6 rounded-full bg-poke-yellow/30" />
          <PokeBall size={220} className="relative" />
        </div>
      </section>

      <section>
        <Label>How it works</Label>
        <div className="mt-3 grid gap-4 md:grid-cols-3">
          {[
            ['1', 'You pay the pack price', 'Our pool wallet buys and opens the Collector Crypt pack for you, so it holds the card until the result is in.'],
            ['2', 'The card’s value decides', 'Below the pack price is a loss. About the pack price (within 5%) is a push. Above it is a win. The value is Collector Crypt’s insured value.'],
            ['3', 'Settled automatically', 'Win: the card and your bonus go to your wallet. Push: you get the card. Loss: the pool sells the card back. Every pack is logged publicly with transaction links.'],
          ].map(([n, title, text]) => (
            <Card key={n}>
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-ink font-pixel text-xs text-white">{n}</div>
              <h3 className="mt-4 font-semibold">{title}</h3>
              <p className="mt-1.5 text-sm text-muted">{text}</p>
            </Card>
          ))}
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-[1.1fr_1fr]">
        <Card>
          <Label>Example at 1.5x on a $100 pack</Label>
          <p className="mt-2 text-sm text-muted">Bonus = (card value − pack price) × (multiplier − 1). Here, (300 − 100) × 0.5 = $100.</p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[420px] text-sm">
              <thead><tr className="text-left text-xs text-muted"><th className="pb-2 font-medium">Card worth</th><th className="pb-2 font-medium">Full risk</th><th className="pb-2 font-medium">Half risk</th></tr></thead>
              <tbody>
                {EXAMPLE.map(row => (
                  <tr key={row.card} className="border-t border-line align-top">
                    <td className="py-3 pr-3 font-semibold tabular-nums">${row.card}</td>
                    <td className="py-3 pr-3">{row.full}</td>
                    <td className="py-3">{row.half}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-muted">1.5x is only for the example; the half-risk sellback assumes a 90% buyback machine. Each machine&apos;s real multiplier is set from Collector Crypt&apos;s pull data so the pool keeps a small edge of about 3–5%.</p>
        </Card>
        <div className="grid gap-4">
          <Card>
            <div className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-poke-blue" /><h3 className="font-semibold">Half risk</h3></div>
            <p className="mt-1.5 text-sm text-muted">On a loss you get half of what Collector Crypt pays to buy the card back. The multiplier is lower (about 1.4–1.9x).</p>
          </Card>
          <Card>
            <div className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-poke-red" /><h3 className="font-semibold">Full risk</h3></div>
            <p className="mt-1.5 text-sm text-muted">On a loss you get nothing. The multiplier is higher (about 2.1–2.9x).</p>
          </Card>
          <Card className="bg-mist !border-transparent">
            <h3 className="font-semibold">The pool sits in the middle</h3>
            <p className="mt-1.5 text-sm text-muted">Losing cards are sold back to Collector Crypt and that money pays winners&apos; bonuses. The pool also gets 15% of our coin&apos;s creator fees, kept apart from Pullback&apos;s loss coverage. Bigger machines unlock as the pool grows.</p>
          </Card>
        </div>
      </section>

      <section><LiveLevels /></section>

      <section>
        <Card>
          <Label>Play responsibly</Label>
          <ul className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            <li>• Leverage is off until you turn it on for your wallet.</li>
            <li>• Every pack asks you to confirm “HIGH RISK — you can lose your entire pack price”.</li>
            <li>• Set your own daily loss limit on the History page.</li>
            <li>• After 5 losses in a row, {APP_NAME} pauses your wallet for a short break.</li>
            <li>• No discounts and no “open another” prompts after a loss.</li>
            <li>• On average every level returns less than you pay, like a normal open.</li>
          </ul>
        </Card>
      </section>
    </div>
  );
}
