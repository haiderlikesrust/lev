'use client';
import { useState } from 'react';
import { usd } from '@/lib/client/api';

const PRICE = 100, MULT = 1.5, BUYBACK = 0.9, MAX = 400;
const EXAMPLES = [60, 100, 300];

/**
 * The home page's example table, made interactive: drag the card's value (or tap a row) and see what
 * each level pays on a $100 pack at 1.5x.
 */
export function PayoutCalculator() {
  const [value, setValue] = useState(300);
  const outcome = value < PRICE * 0.95 ? 'loss' : value < PRICE * 1.05 ? 'push' : 'win';
  const bonus = outcome === 'win' ? (value - PRICE) * (MULT - 1) : 0;
  const result = (half: boolean) => outcome === 'loss' ? (half ? `${usd(value * BUYBACK * 0.5)}` : '$0') : outcome === 'push' ? 'The card' : `Card + ${usd(bonus)}`;
  const detail = (half: boolean) => outcome === 'loss' ? (half ? `half of the ${usd(value * BUYBACK)} sellback` : 'the pool sells the card back') : outcome === 'push' ? `worth ${usd(value)}, about the pack price` : `(${value} − ${PRICE}) × ${(MULT - 1).toFixed(1)} bonus`;
  const tone = { loss: 'text-poke-red', push: 'text-push', win: 'text-poke-yellow-dark' }[outcome];
  return (
    <div className="rounded-3xl border border-line bg-white p-5 shadow-card sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-sm text-muted">Card pulled from a <span className="font-semibold text-ink">$100 pack at 1.5x</span></div>
        <div className={`font-display text-4xl font-extrabold tabular-nums ${tone}`}>${value}</div>
      </div>

      <div className="relative mt-5">
        <div className="flex h-3 overflow-hidden rounded-full">
          <span className="bg-poke-red/80" style={{ width: `${95 / MAX * 100}%` }} />
          <span className="bg-push" style={{ width: `${10 / MAX * 100}%` }} />
          <span className="flex-1 bg-gradient-to-r from-poke-yellow to-win" />
        </div>
        <input type="range" min={0} max={MAX} step={5} value={value} onChange={e => setValue(Number(e.target.value))} aria-label="Card value in dollars"
          className="absolute inset-x-0 -top-1.5 h-6 w-full cursor-pointer appearance-none bg-transparent [&::-webkit-slider-thumb]:h-6 [&::-webkit-slider-thumb]:w-6 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-4 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:bg-ink [&::-webkit-slider-thumb]:shadow-md [&::-moz-range-thumb]:h-5 [&::-moz-range-thumb]:w-5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-4 [&::-moz-range-thumb]:border-white [&::-moz-range-thumb]:bg-ink" />
        <div className="mt-2 flex justify-between text-[11px] text-muted"><span>$0</span><span>loss · push $95–105 · win</span><span>${MAX}</span></div>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        {[false, true].map(half => (
          <div key={String(half)} className="rounded-2xl bg-mist p-4">
            <div className="flex items-center gap-2 text-xs font-semibold text-muted"><span className={`h-2 w-2 rounded-full ${half ? 'bg-poke-blue' : 'bg-poke-red'}`} />{half ? 'Half risk' : 'Full risk'}</div>
            <div className="mt-1 text-xl font-bold">{result(half)}</div>
            <div className="text-xs text-muted">{detail(half)}</div>
          </div>
        ))}
      </div>

      <table className="mt-5 w-full text-sm">
        <caption className="sr-only">Example outcomes on a $100 pack at 1.5x</caption>
        <thead><tr className="text-left text-xs text-muted"><th className="pb-2 font-medium">Card worth</th><th className="pb-2 font-medium">Full risk</th><th className="pb-2 font-medium">Half risk</th></tr></thead>
        <tbody>
          {EXAMPLES.map(v => {
            const o = v < 95 ? 'loss' : v < 105 ? 'push' : 'win', b = (v - PRICE) * (MULT - 1);
            return (
              <tr key={v} onClick={() => setValue(v)} className={`cursor-pointer border-t border-line transition hover:bg-mist ${v === value ? 'bg-poke-yellow/15' : ''}`}>
                <td className="py-2.5 font-semibold tabular-nums">${v}</td>
                <td className="py-2.5">{o === 'loss' ? '$0' : o === 'push' ? 'The card' : `Card + ${usd(b, 0)}`}</td>
                <td className="py-2.5">{o === 'loss' ? `${usd(v * BUYBACK * 0.5, 0)} (half the sellback)` : o === 'push' ? 'The card' : `Card + ${usd(b, 0)}`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-3 text-xs text-muted">1.5x is only for the example. Real multipliers are set per machine from Collector Crypt&apos;s pull data so the pool keeps about a 3–5% edge.</p>
    </div>
  );
}
