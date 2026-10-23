import { config } from './config';
import type { CoinView } from '../shared/types';

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Our coin's contract address and ticker for the site, or null until MEMECOIN_MINT holds a real mint. */
export function coinView(): CoinView | null {
  const mint = config.MEMECOIN_MINT.trim();
  const ticker = config.COIN_TICKER.trim().replace(/^\$/, '');
  return BASE58.test(mint) ? { mint, ticker: ticker ? `$${ticker}` : null } : null;
}
