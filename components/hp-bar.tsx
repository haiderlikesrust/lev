/** Pool health as a Pokémon HP bar: green, then yellow below half, red below a fifth. */
export function HpBar({ bps, paused = false, label = 'Pool HP' }: { bps: number; paused?: boolean; label?: string }) {
  const pct = Math.max(0, Math.min(100, bps / 100));
  const color = paused ? '#85858a' : pct > 50 ? '#3fae49' : pct > 20 ? '#f2b705' : '#ee1515';
  return (
    <div>
      <div className="flex items-center gap-3">
        <span className="font-pixel text-xs text-ink">{label}</span>
        <div className="relative h-3.5 flex-1 overflow-hidden rounded-full border-2 border-ink bg-mist" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={label}>
          <div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${pct}%`, background: color }} />
        </div>
        <span className="w-12 text-right font-pixel text-xs tabular-nums">{Math.round(pct)}%</span>
      </div>
      {paused && <div className="mt-1 text-xs text-muted">Paused</div>}
    </div>
  );
}
