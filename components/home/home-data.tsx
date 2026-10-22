'use client';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { usePoll } from '@/lib/client/api';
import type { ConfigView, LeaderboardView, SettlementView } from '@/lib/shared/types';

type HomeData = { config: ConfigView | null; stats: LeaderboardView | null; latest: SettlementView[] | null };
const Ctx = createContext<HomeData>({ config: null, stats: null, latest: null });
export const useHomeData = () => useContext(Ctx);

/** Fetches the home page's live data once and shares it with every section. */
export function HomeDataProvider({ children }: { children: ReactNode }) {
  const { data: config } = usePoll<ConfigView>('/api/config', 30_000);
  const { data: stats } = usePoll<LeaderboardView>('/api/leaderboard?period=all', 20_000);
  const { data: latest } = usePoll<SettlementView[]>('/api/settlements?limit=16', 8_000);
  return <Ctx.Provider value={{ config, stats, latest }}>{children}</Ctx.Provider>;
}

/** Counts up to `target` (eased), or jumps straight there for reduced-motion users. */
export function useCountUp(target: number, ms = 1_100) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    let raf = 0;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches, start = performance.now();
    const tick = (now: number) => {
      const p = reduce ? 1 : Math.min(1, (now - start) / ms);
      setValue(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return value;
}
