import { Check, PackageOpen, Scale, Sparkles, Wallet, type LucideIcon } from 'lucide-react';
import type { OrderStatus } from '@/lib/shared/types';

const STEPS: { label: string; icon: LucideIcon; status: OrderStatus[] }[] = [
  { label: 'Payment', icon: Wallet, status: ['awaiting_payment', 'paying'] },
  { label: 'Opening', icon: PackageOpen, status: ['paid', 'buying'] },
  { label: 'Settling', icon: Scale, status: ['settling'] },
  { label: 'Done', icon: Sparkles, status: ['complete'] },
];

export const stepIndex = (status: OrderStatus) => Math.max(0, STEPS.findIndex(s => s.status.includes(status)));

/**
 * A pack's progress as a track that fills between steps: finished steps pop into a check, the current one
 * spins and glows, and a shimmer runs along the filled track while the server works.
 */
export function ProgressSteps({ status }: { status: OrderStatus }) {
  const done = status === 'complete', current = done ? STEPS.length - 1 : stepIndex(status);
  const fill = current / (STEPS.length - 1) * 100;
  return (
    <div className="relative" role="progressbar" aria-valuemin={1} aria-valuemax={STEPS.length} aria-valuenow={current + 1} aria-valuetext={STEPS[current].label}>
      <div className="absolute left-8 right-8 top-4 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-mist">
        <div className="relative h-full overflow-hidden rounded-full bg-gradient-to-r from-poke-red via-poke-red to-poke-yellow transition-[width] duration-700 ease-out" style={{ width: `${fill}%` }}>
          {!done && <span className="progress-shimmer absolute inset-0" />}
        </div>
      </div>
      <ol className="relative flex justify-between">
        {STEPS.map((s, i) => {
          const state = done || i < current ? 'done' : i === current ? 'active' : 'todo';
          const Icon = state === 'done' ? Check : s.icon;
          return (
            <li key={s.label} className="flex w-16 flex-col items-center gap-1.5">
              <span className="relative flex h-8 w-8 items-center justify-center">
                {state === 'active' && <span className="step-halo absolute inset-0 rounded-full bg-poke-yellow/50" />}
                {state === 'active' && <span className="absolute -inset-1 animate-spin rounded-full border-2 border-transparent border-t-poke-red border-r-poke-red/40" />}
                <span className={`relative flex h-8 w-8 items-center justify-center rounded-full transition-colors duration-500 ${
                  state === 'done' ? 'bg-ink text-white' : state === 'active' ? 'bg-poke-yellow text-ink' : 'border-2 border-line bg-white text-muted'}`}>
                  {/* Re-keyed per state so the pop replays when a step finishes. */}
                  <Icon key={state} size={15} strokeWidth={2.5} className={state === 'done' ? 'step-pop' : state === 'active' ? 'step-bob' : ''} aria-hidden />
                </span>
              </span>
              <span className={`text-[11px] transition-colors duration-500 ${state === 'todo' ? 'text-muted' : 'font-semibold text-ink'}`}>{s.label}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
