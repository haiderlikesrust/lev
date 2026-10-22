/** A flat Poké Ball. `split` renders the halves separately so they can fly apart on the reveal. */
export function PokeBall({ size = 28, className = '', split = false, opening = false }: { size?: number; className?: string; split?: boolean; opening?: boolean }) {
  if (!split) {
    return (
      <svg width={size} height={size} viewBox="0 0 100 100" className={className} aria-hidden>
        <circle cx="50" cy="50" r="46" fill="#fff" stroke="#1c1c1e" strokeWidth="7" />
        <path d="M4 50a46 46 0 0 1 92 0z" fill="#ee1515" stroke="#1c1c1e" strokeWidth="7" strokeLinejoin="round" />
        <circle cx="50" cy="50" r="13" fill="#fff" stroke="#1c1c1e" strokeWidth="7" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" className={className} aria-hidden style={{ overflow: 'visible' }}>
      <g className={opening ? 'ball-open-bottom' : ''} style={{ transformOrigin: '50% 50%', transformBox: 'fill-box' }}>
        <path d="M4 50a46 46 0 0 0 92 0z" fill="#fff" stroke="#1c1c1e" strokeWidth="7" strokeLinejoin="round" />
      </g>
      <g className={opening ? 'ball-open-top' : ''} style={{ transformOrigin: '50% 50%', transformBox: 'fill-box' }}>
        <path d="M4 50a46 46 0 0 1 92 0z" fill="#ee1515" stroke="#1c1c1e" strokeWidth="7" strokeLinejoin="round" />
        <circle cx="50" cy="50" r="13" fill="#fff" stroke="#1c1c1e" strokeWidth="7" />
      </g>
    </svg>
  );
}
