'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...init, headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(body?.error ?? `Request failed (${response.status}).`, response.status);
  return body as T;
}
export const apiGet = <T,>(url: string) => request<T>(url);
export const apiPost = <T,>(url: string, body: unknown = {}) => request<T>(url, { method: 'POST', body: JSON.stringify(body) });

/** Fetches `url` and re-fetches every `everyMs` (0 = once). `null` skips. */
export function usePoll<T>(url: string | null, everyMs = 0) {
  const [data, setData] = useState<T | null>(null), [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  const reload = useCallback(async () => {
    if (!url) return;
    try { const next = await apiGet<T>(url); if (live.current) { setData(next); setError(null); } }
    catch (e) { if (live.current) setError((e as Error).message); }
  }, [url]);
  useEffect(() => {
    live.current = true;
    if (!url) return;
    const load = () => apiGet<T>(url).then(next => { if (live.current) { setData(next); setError(null); } }, e => { if (live.current) setError((e as Error).message); });
    void load();
    const timer = everyMs > 0 ? setInterval(load, everyMs) : null;
    return () => { live.current = false; if (timer) clearInterval(timer); };
  }, [url, everyMs, reload]);
  // With no url there is nothing to show, whatever an earlier url loaded.
  return { data: url ? data : null, error: url ? error : null, reload, setData };
}

export const usd = (n: number, digits = 2) => `$${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
export const usdShort = (n: number) => n >= 10_000 ? `$${Math.round(n / 1_000).toLocaleString('en-US')}k` : `$${Math.round(n).toLocaleString('en-US')}`;
export const pct = (x: number, digits = 1) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(digits)}%`;
export const chance = (p: number) => p < 0.01 && p > 0 ? '<1%' : `${Math.round(p * 100)}%`;
export const mult = (bps: number) => `${(bps / 10_000).toFixed(2)}x`;
export const shortKey = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;
export const fromBase64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
export const toBase64 = (bytes: Uint8Array) => { let out = ''; for (const b of bytes) out += String.fromCharCode(b); return btoa(out); };
export const timeAgo = (at: number) => {
  const s = Math.max(1, Math.round((Date.now() - at) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86_400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86_400)}d ago`;
};
