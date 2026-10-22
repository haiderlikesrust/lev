import type { ReactNode } from 'react';
import Link from 'next/link';
import { Lock } from 'lucide-react';
import { HighRisk, Label } from '@/components/ui';
import { LiveLevels } from '@/components/live-levels';
import { MachineFacts, Rule, Wallets } from '@/components/docs-live';
import { APP_NAME } from '@/lib/shared/brand';

export const metadata = { title: 'Docs', description: `How ${APP_NAME} leverage packs work: outcomes, multipliers, the pool, fairness and responsible play.` };

const SECTIONS = [
  ['overview', 'Overview'], ['flow', 'How a pack works'], ['outcomes', 'Outcomes'], ['examples', 'Worked examples'],
  ['levels', 'Risk levels'], ['multipliers', 'How multipliers are set'], ['value', 'Card value & sellback'], ['pool', 'The pool'],
  ['fairness', 'Fairness & verification'], ['refunds', 'Refunds & problems'], ['responsible', 'Responsible play'], ['faq', 'FAQ'], ['glossary', 'Glossary'],
] as const;

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-28 border-t border-line pt-10 first:border-0 first:pt-0">
      <h2 className="text-2xl font-bold tracking-tight">{title}</h2>
      <div className="mt-4 space-y-4 text-[15px] leading-relaxed text-ink/90 [&_a]:text-poke-blue [&_a:hover]:underline">{children}</div>
    </section>
  );
}

const Formula = ({ children }: { children: ReactNode }) => <div className="overflow-x-auto rounded-2xl bg-mist px-4 py-3 font-mono text-sm">{children}</div>;
const Note = ({ children }: { children: ReactNode }) => <div className="rounded-2xl border-l-4 border-poke-yellow bg-poke-yellow/10 px-4 py-3 text-sm">{children}</div>;

export default function DocsPage() {
  return (
    <div className="grid grid-cols-1 gap-10 lg:grid-cols-[200px_1fr]">
      <aside className="hidden lg:block">
        <nav className="sticky top-28 space-y-0.5 text-sm" aria-label="Docs sections">
          <Label className="mb-3">Docs</Label>
          {SECTIONS.map(([id, title]) => <a key={id} href={`#${id}`} className="block rounded-lg px-2 py-1 text-muted hover:bg-mist hover:text-ink">{title}</a>)}
        </nav>
      </aside>

      <article className="min-w-0 max-w-3xl space-y-10">
        <header>
          <HighRisk />
          <h1 className="mt-3 text-4xl font-bold tracking-tight">How {APP_NAME} works</h1>
          <p className="mt-3 text-lg text-muted">Everything about leverage packs: what you can win, what you can lose, how the numbers are set, and how to check every pack yourself.</p>
          <details className="mt-5 rounded-2xl border border-line px-4 py-3 text-sm lg:hidden">
            <summary className="cursor-pointer font-medium">On this page</summary>
            <div className="mt-2 grid grid-cols-2 gap-1">{SECTIONS.map(([id, title]) => <a key={id} href={`#${id}`} className="text-muted hover:text-ink">{title}</a>)}</div>
          </details>
        </header>

        <Section id="overview" title="Overview">
          <p>A leverage pack is a normal Collector Crypt (CC) pack with a deal attached before it opens. If your card is worth more than the pack price, the pool pays you a bonus on top of the card. If it&apos;s worth less, you don&apos;t get the card: the pool keeps it and sells it back to CC. Losers&apos; sellbacks pay winners&apos; bonuses, and the pool sits in the middle.</p>
          <p>Leverage is optional. It sits next to Pullback&apos;s loss coverage, but they are separate: different wallets, different rules.</p>
          <Note><strong>HIGH RISK — you can lose your entire pack price.</strong> On average every level returns less than you pay, like a normal open. Only play with money you can afford to lose.</Note>
        </Section>

        <Section id="flow" title="How a pack works">
          <ol className="list-decimal space-y-2 pl-5">
            <li><strong>You choose a machine and a level</strong> and see every outcome, its chance, the biggest possible bonus and the average result before you commit.</li>
            <li><strong>You confirm the HIGH RISK warning</strong> and sign one USDC payment for the pack price in your wallet. The terms (multiplier, floor, bonus cap) are locked at this moment.</li>
            <li><strong>Our LEV_OPS wallet buys and opens the CC pack.</strong> Because it&apos;s our wallet that opens it, the card arrives with us, never directly with you. That&apos;s what makes a losing card impossible to keep.</li>
            <li><strong>We read the card&apos;s insured value from CC</strong> (<code className="rounded bg-mist px-1">GET /api/pack/status</code>) and settle automatically: sell it back, or send you the card (and bonus).</li>
            <li><strong>The settlement is logged publicly</strong> on the <Link href="/pool">Pool page</Link> with every transaction link and CC&apos;s fairness proof.</li>
          </ol>
          <p>Most packs settle within a minute. If CC is slow, the pack waits and retries on its own; your payment is never lost (see <a href="#refunds">Refunds</a>).</p>
        </Section>

        <Section id="outcomes" title="Outcomes">
          <p>The card&apos;s value is compared with the pack price <em>P</em>. Values within 5% of the price count as a push.</p>
          <div className="overflow-x-auto rounded-2xl border border-line">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="bg-mist text-left text-xs text-muted"><tr><th className="px-4 py-2.5 font-medium">Card value</th><th className="px-3 py-2.5 font-medium">Outcome</th><th className="px-3 py-2.5 font-medium">Full risk</th><th className="px-3 py-2.5 font-medium">Half risk</th></tr></thead>
              <tbody>
                <tr className="border-t border-line"><td className="px-4 py-3">under 0.95 × P</td><td className="px-3 py-3 font-semibold text-loss">Loss</td><td className="px-3 py-3">$0. The pool sells the card back to CC.</td><td className="px-3 py-3">50% of what CC paid for it</td></tr>
                <tr className="border-t border-line"><td className="px-4 py-3">0.95 × P to 1.05 × P</td><td className="px-3 py-3 font-semibold">Push</td><td className="px-3 py-3">The card</td><td className="px-3 py-3">The card</td></tr>
                <tr className="border-t border-line"><td className="px-4 py-3">1.05 × P or more</td><td className="px-3 py-3 font-semibold text-win">Win</td><td className="px-3 py-3">The card + bonus</td><td className="px-3 py-3">The card + bonus</td></tr>
              </tbody>
            </table>
          </div>
          <Formula>bonus = (card value − pack price) × (multiplier − 1), capped</Formula>
          <p>The cap is <Rule name="cap" />, fixed when you confirm the pack. The Open page always shows the exact cap before you pay.</p>
        </Section>

        <Section id="examples" title="Worked examples">
          <p>A $100 pack at 1.5x (the multiplier is just for the example):</p>
          <ul className="list-disc space-y-1.5 pl-5">
            <li><strong>$60 card:</strong> loss. Full risk gets $0. On a 90% buyback machine, CC pays $54 for the card, so Half risk gets $27.</li>
            <li><strong>$100 card:</strong> push. You get the card.</li>
            <li><strong>$300 card:</strong> win. You get the card plus (300 − 100) × 0.5 = <strong>$100</strong>.</li>
          </ul>
          <p>And one real settlement from practice mode: a $25 Starter pack at Full risk 2.10x pulled a $28 card, so the player got the card plus (28 − 25) × 1.10 = <strong>$3.30</strong>.</p>
        </Section>

        <Section id="levels" title="Risk levels">
          <p><strong>Half risk:</strong> a losing pack still pays you half of what CC pays to buy the card back, so you never lose everything. The multiplier is lower, roughly 1.4–1.9x.</p>
          <p><strong>Full risk:</strong> a losing pack pays nothing. The multiplier is higher, roughly 2.1–2.9x.</p>
          <p>Each machine has its own multipliers. A level shows a <Lock size={14} strokeWidth={2.25} aria-label="lock" className="inline align-[-2px]" /> lock until it&apos;s ready: either more pull data is needed to price it fairly, or the pool needs to grow before it can pay that level&apos;s biggest bonuses. Today:</p>
          <LiveLevels />
        </Section>

        <Section id="multipliers" title="How multipliers are set">
          <p>Multipliers aren&apos;t picked by hand. Every day each one is solved from the machine&apos;s real CC pulls over the last <Rule name="window" />, so the pool keeps only a small, fixed edge.</p>
          <p>Start from a <strong>normal open</strong>: buy the pack and sell the card straight back to CC. On average that returns a little less than the pack price (the &ldquo;normal open&rdquo; column below). Valued the same way, the pool and the leverage player split exactly what a normal open returns, so:</p>
          <Formula>your average result = normal-open result − pool edge</Formula>
          <p>The pool edge is <Rule name="edge" /> at launch, dropping to <Rule name="minEdge" /> on a machine once its data is strong enough. The multiplier that gives exactly that edge is:</p>
          <Formula>M = 1 + ((1 − floor) × buyback × L − edge) / W</Formula>
          <p><em>L</em> is the average value of losing pulls (as a share of the price), <em>W</em> is how far winning pulls beat the price on average, and <em>floor</em> is 0 for Full risk and 0.5 for Half risk. With the bonus cap applied it&apos;s solved numerically. Multipliers are always rounded <em>down</em> to the nearest 0.05x.</p>
          <p>A level only opens when the data is strong enough to be confident the pool really keeps its edge: the 95% lower bound of the pool&apos;s result must stay above zero. A level never opens at a worse multiplier to make up for thin data; it waits for more pulls instead.</p>
          <MachineFacts />
        </Section>

        <Section id="value" title="Card value & sellback">
          <p>A card&apos;s value is CC&apos;s <strong>insured value</strong>, the reference value CC assigns each graded card and shows on its own site. CC doesn&apos;t publish how it sets that value.</p>
          <p>When a pack loses, the pool sells the card back through CC&apos;s instant buyback, which pays a fixed share of the insured value: 85–93% depending on the machine (the &ldquo;CC buyback&rdquo; column above). That money goes straight to the pool, and Half-risk players get half of it.</p>
          <p>CC buys cards back for 72 hours after a pull, so losing cards are sold back right away.</p>
        </Section>

        <Section id="pool" title="The pool">
          <p>The leverage pool is its own wallet (LEV_POOL), separate from Pullback&apos;s loss-coverage pool, so a bad run of leverage packs can never touch loss coverage.</p>
          <ul className="list-disc space-y-1.5 pl-5">
            <li><strong>Money in:</strong> sellbacks of losing cards, plus 85% of our coin&apos;s creator fees. The fees are claimed in $CARDS and swapped to USDC on Jupiter, and every transfer into the pool is listed on the <Link href="/pool">Pool page</Link>.</li>
            <li><strong>Money out:</strong> win bonuses and Half-risk floors.</li>
            <li><strong>Reservations:</strong> while a pack is open, its biggest possible bonus is set aside, so every bonus in progress is always payable. &ldquo;Free&rdquo; balance is what&apos;s left.</li>
            <li><strong>Unlocks:</strong> a level opens only when the free pool can absorb that level&apos;s ups and downs (under a <Rule name="ruin" /> chance of running dry) and its bonus cap is at least <Rule name="minCap" />. Bigger machines unlock as the pool grows.</li>
            <li><strong>Auto-pause:</strong> if the free pool drops under <Rule name="pause" />, new packs pause until it refills; packs in progress still settle. A machine also pauses if its odds haven&apos;t been re-checked in 48 hours.</li>
            <li><strong>Pool HP:</strong> the health bar shows the free pool against a <Rule name="target" /> target.</li>
          </ul>
          <Wallets />
        </Section>

        <Section id="fairness" title="Fairness & verification">
          <p>Every pull comes from CC&apos;s own machines. CC draws them with a verifiable random function (VRF), and each settled pack links to CC&apos;s proof (<code className="rounded bg-mist px-1">/api/vrf/verify</code>).</p>
          <p>The pack&apos;s CC order is tied to your purchase <em>before</em> it opens. A pull can&apos;t be reassigned to someone else after the result is known.</p>
          <p>Each settlement shows its transactions on Solscan, and every entry on the <Link href="/leaderboard">Leaderboard</Link> opens its full proof trail:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li><strong>payment</strong> — your USDC to LEV_OPS</li>
            <li><strong>pack</strong> — LEV_OPS paying CC for the pack</li>
            <li><strong>card</strong> — the card to your wallet (push or win)</li>
            <li><strong>bonus</strong> — the bonus from LEV_POOL (win)</li>
            <li><strong>sellback</strong> — CC buying the card back into LEV_POOL (loss)</li>
            <li><strong>floor</strong> — your Half-risk share (loss)</li>
          </ul>
        </Section>

        <Section id="refunds" title="Refunds & problems">
          <ul className="list-disc space-y-1.5 pl-5">
            <li>You have 2 minutes to approve the payment in your wallet. If you don&apos;t, the pack expires and nothing is charged.</li>
            <li>If CC won&apos;t sell from the machine (&ldquo;machine is low/off&rdquo;), or the pool can no longer cover the pack&apos;s top bonus, you&apos;re refunded the full pack price automatically.</li>
            <li>If something unexpected happens, the pack goes to manual review. Your payment is safe, and the team either finishes the pack or refunds it. A refund only happens if no pack was bought.</li>
          </ul>
        </Section>

        <Section id="responsible" title="Responsible play">
          <ul className="list-disc space-y-1.5 pl-5">
            <li><strong>Opt-in:</strong> leverage is off for every wallet until you turn it on, and you can turn it off any time on the <Link href="/history">History</Link> page.</li>
            <li><strong>Every pack</strong> asks you to tick &ldquo;HIGH RISK — you can lose your entire pack price&rdquo;. The box always starts unticked.</li>
            <li><strong>Your own daily loss limit:</strong> lowering it is instant; raising or removing it takes 24 hours.</li>
            <li><strong>Breaks:</strong> <Rule name="cooldown" />.</li>
            <li><strong>No pressure:</strong> no discounts, no &ldquo;open another&rdquo; buttons after a result, no near-miss animations.</li>
            <li>18+ only. If it stops being fun, stop.</li>
          </ul>
        </Section>

        <Section id="faq" title="FAQ">
          {[
            ['Can I keep a losing card?', 'No. The pool opens the pack, so the card is never in your wallet unless the pack pushes or wins.'],
            ['Why are the multipliers different on each machine?', 'Each machine has different odds, card values and buyback rates, so the multiplier that leaves the pool the same small edge differs too.'],
            ['Why is a level locked?', 'Either more pulls are needed to price it fairly, or the pool needs to grow before it can pay that level’s biggest bonuses. The lock shows which.'],
            ['Is my average result positive?', 'No. Like a normal open, every level returns less than you pay on average. Leverage spreads your result out: more total losses, bigger wins.'],
            ['Which wallets work?', 'Phantom and Solflare. You need USDC for the pack and a little SOL (about 0.002) for the network fee.'],
            ['What if the card’s value isn’t known yet?', 'The pack waits until CC records it, well inside CC’s 72-hour buyback window. If it takes too long, the team settles it by hand.'],
            ['Where does the bonus money come from?', 'From losing packs’ sellbacks, plus 85% of our coin’s creator fees, held in the separate leverage pool.'],
          ].map(([q, a]) => (
            <details key={q} className="group rounded-2xl border border-line px-4 py-3">
              <summary className="cursor-pointer list-none font-medium after:float-right after:text-muted after:content-['+'] group-open:after:content-['−']">{q}</summary>
              <p className="mt-2 text-sm text-muted">{a}</p>
            </details>
          ))}
        </Section>

        <Section id="glossary" title="Glossary">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[160px_1fr]">
            {[
              ['Pack price', 'What the CC machine charges for one pack, in USDC.'],
              ['Insured value', 'CC’s reference value for a graded card; it decides the outcome.'],
              ['Sellback / buyback', 'CC buying a card back for a fixed share of its insured value.'],
              ['Push zone', 'Within 5% of the pack price: you simply get the card.'],
              ['Multiplier', 'Sets the bonus on a win: (value − price) × (multiplier − 1).'],
              ['Floor', 'On a Half-risk loss, your 50% share of the sellback.'],
              ['Pool edge', 'The small share of each pack price the pool keeps on average.'],
              ['Bonus cap', 'The most a single pack can pay as a bonus, fixed when you confirm.'],
              ['Normal open', 'Opening the pack without leverage and selling the card straight back.'],
            ].map(([term, def]) => (
              <div key={term} className="contents"><dt className="font-semibold">{term}</dt><dd className="text-muted">{def}</dd></div>
            ))}
          </dl>
        </Section>
      </article>
    </div>
  );
}
