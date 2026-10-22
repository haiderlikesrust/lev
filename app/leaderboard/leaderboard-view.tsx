'use client';
import { useState, type ReactNode } from 'react';
import { ChevronDown, Coins, Gift, Layers, Trophy, Undo2 } from 'lucide-react';
import { usePoll, mult, pct, timeAgo, usd } from '@/lib/client/api';
import { Card, OutcomeBadge, SectionHead } from '@/components/ui';
import { CardPhoto, MachineArt } from '@/components/machine-art';
import { Proof } from '@/components/proof';
import { OutcomeBar } from '@/components/home/stats-band';
import { LEVEL_NAME } from '@/lib/shared/leverage';
import type { ConfigView, LeaderboardView as Board, Period, SettlementView } from '@/lib/shared/types';

const PERIODS: { id: Period; label: string }[] = [{ id: '24h', label: '24 hours' }, { id: '7d', label: '7 days' }, { id: 'all', label: 'All time' }];
const MEDAL = ['bg-poke-yellow text-ink', 'bg-[#c9ced9] text-ink', 'bg-[#d39058] text-white'];

export function LeaderboardView() {
  const [period, setPeriod] = useState<Period>('7d');
  const { data } = usePoll<Board>(`/api/leaderboard?period=${period}`, 15_000);
  const { data: config } = usePoll<ConfigView>('/api/config', 0);
  const practice = config?.practice ?? true, cluster = config?.cluster ?? '';
  const t = data?.totals;
  return (
    <div className="space-y-10">
      <section className="dots relative overflow-hidden rounded-[2rem] bg-navy px-6 py-8 text-white sm:px-10">
        <div className="hero-glow absolute inset-0" />
        <div className="relative flex flex-wrap items-end justify-between gap-6">
          <div>
            <div className="flex items-center gap-2 font-pixel text-[11px] uppercase tracking-wider text-poke-yellow"><Trophy size={14} /> Leaderboard</div>
            <h1 className="mt-2 text-4xl font-extrabold sm:text-5xl">Biggest pulls &amp; bonuses</h1>
            <p className="mt-2 max-w-xl text-white/70">Every entry is a settled leverage pack, with each transaction behind it so anyone can check it.</p>
          </div>
          <div className="flex rounded-full bg-white/10 p-1 ring-1 ring-white/15" role="tablist" aria-label="Period">
            {PERIODS.map(p => (
              <button key={p.id} role="tab" aria-selected={period === p.id} onClick={() => setPeriod(p.id)}
                className={`rounded-full px-4 py-2 text-sm font-semibold transition ${period === p.id ? 'bg-white text-ink' : 'text-white/75 hover:text-white'}`}>{p.label}</button>
            ))}
          </div>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Tile icon={<Layers size={18} />} tone="bg-poke-blue/10 text-poke-blue" label="Packs settled" value={t ? t.packs.toLocaleString('en-US') : '—'}>
          <OutcomeBar wins={t?.wins ?? 0} pushes={t?.pushes ?? 0} losses={t?.losses ?? 0} />
        </Tile>
        <Tile icon={<Gift size={18} />} tone="bg-poke-red/10 text-poke-red" label="Bonuses paid" value={t ? usd(t.bonusesUsd, 0) : '—'}>
          <div className="text-xs text-muted">biggest single bonus {t ? usd(t.biggestBonusUsd) : '—'}</div>
        </Tile>
        <Tile icon={<Undo2 size={18} />} tone="bg-uncommon/12 text-uncommon" label="Back to players" value={t ? usd(t.returnedUsd, 0) : '—'}>
          <div className="text-xs text-muted">cards, bonuses and floors, from {t ? usd(t.volumeUsd, 0) : '—'} of packs</div>
        </Tile>
        <Tile icon={<Coins size={18} />} tone="bg-poke-yellow/25 text-poke-yellow-dark" label="Biggest pull" value={t ? usd(t.biggestPullUsd, 0) : '—'}>
          <div className="text-xs text-muted">insured value of the best card</div>
        </Tile>
      </section>

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Ranked title="Biggest bonuses" kicker="Wins" rows={data?.topBonuses} amount={s => `+${usd(s.bonusUsd)}`} sub={s => `card worth ${usd(s.valueUsd)}`} practice={practice} cluster={cluster} />
        <Ranked title="Biggest pulls" kicker="Cards" rows={data?.topPulls} amount={s => usd(s.valueUsd)} sub={s => s.outcome === 'win' ? `+${usd(s.bonusUsd)} bonus` : s.outcome === 'push' ? 'push' : 'loss'} practice={practice} cluster={cluster} />
      </section>

      <section>
        <SectionHead kicker="Machines" title="How each machine is playing" lede="Real results against the pool's target edge. Short runs swing a lot; the target is what holds over many packs." />
        <Card className="!p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-mist text-left text-xs text-muted">
                <tr><th className="px-5 py-3 font-medium">Machine</th><th className="px-3 py-3 font-medium">Packs</th><th className="px-3 py-3 font-medium">Win · push · loss</th><th className="px-3 py-3 font-medium">Bonuses paid</th><th className="px-3 py-3 font-medium">Sold back</th><th className="px-3 py-3 font-medium">Pool result</th></tr>
              </thead>
              <tbody>
                {(data?.machines ?? []).map(m => (
                  <tr key={m.code} className="border-t border-line">
                    <td className="px-5 py-3"><div className="flex items-center gap-3"><MachineArt image={m.image} name={m.name} className="h-10 w-9" /><span><span className="font-semibold">${m.code.split('_')[1]}</span> <span className="text-muted">{m.name}</span></span></div></td>
                    <td className="px-3 py-3 tabular-nums">{m.packs}</td>
                    <td className="w-48 px-3 py-3">{m.packs ? <OutcomeBar wins={m.wins} pushes={m.pushes} losses={m.losses} /> : <span className="text-muted">—</span>}</td>
                    <td className="px-3 py-3 tabular-nums">{usd(m.bonusesUsd, 0)}</td>
                    <td className="px-3 py-3 tabular-nums">{usd(m.sellbackUsd, 0)}</td>
                    <td className="px-3 py-3 tabular-nums">{m.realizedEdge === null ? <span className="text-muted">—</span> : <span className={m.realizedEdge >= 0 ? 'text-uncommon' : 'text-loss'}>{pct(m.realizedEdge)}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <p className="mt-3 text-xs text-muted">Pool result = (sellbacks − floors − bonuses) ÷ pack volume. Positive means the pool came out ahead on that machine in this period.</p>
      </section>
    </div>
  );
}

function Tile({ icon, tone, label, value, children }: { icon: ReactNode; tone: string; label: string; value: string; children: ReactNode }) {
  return (
    <div className="rounded-3xl border border-line bg-white p-4 shadow-card sm:p-5">
      <div className="flex items-center gap-2.5"><span className={`inline-flex h-9 w-9 items-center justify-center rounded-xl ${tone}`}>{icon}</span><span className="text-sm font-medium text-muted">{label}</span></div>
      <div className="mt-3 font-display text-3xl font-extrabold tabular-nums">{value}</div>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function Ranked({ title, kicker, rows, amount, sub, practice, cluster }: {
  title: string; kicker: string; rows: SettlementView[] | undefined; amount: (s: SettlementView) => string; sub: (s: SettlementView) => string; practice: boolean; cluster: string;
}) {
  return (
    <div>
      <SectionHead kicker={kicker} title={title} />
      <Card className="!p-0 overflow-hidden">
        {!rows ? <div className="m-5 h-40 animate-pulse rounded-2xl bg-mist" /> : !rows.length ? (
          <p className="px-6 py-12 text-center text-sm text-muted">Nothing settled in this period yet.</p>
        ) : (
          <ol>
            {rows.map((s, i) => (
              <li key={s.orderId} className="border-b border-line last:border-0">
                <details className="group">
                  <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 hover:bg-mist/60 sm:px-5">
                    <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full font-pixel text-[10px] ${MEDAL[i] ?? 'bg-mist text-muted'}`}>{i + 1}</span>
                    <CardPhoto image={s.card?.image} name={s.card?.name} className="h-14 w-10 shrink-0 bg-mist" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold">{s.card?.name ?? 'Card'}</div>
                      <div className="truncate text-xs text-muted">${s.priceUsd} {s.machineName} · {LEVEL_NAME[s.level]} {mult(s.multiplierBps)} · {s.wallet} · {timeAgo(s.settledAt)}</div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="font-display text-lg font-extrabold tabular-nums">{amount(s)}</div>
                      <div className="flex items-center justify-end gap-1.5 text-xs text-muted">{s.outcome !== 'win' && <OutcomeBadge outcome={s.outcome} />}{s.outcome === 'win' && sub(s)}</div>
                    </div>
                    <ChevronDown size={16} className="shrink-0 text-muted transition group-open:rotate-180" />
                  </summary>
                  <div className="px-4 pb-4 sm:px-5"><Proof s={s} practice={practice} cluster={cluster} /></div>
                </details>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
