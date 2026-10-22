import { z } from 'zod';

const flag = z.enum(['true', 'false']).default('false');

const schema = z.object({
  /** true turns on real signing and spending. Anything else is practice mode: mocked money and packs. */
  MAINNET_ENABLED: flag,
  APP_ORIGIN: z.string().url().default('http://localhost:3000'),
  /** Postgres for production. Without it, embedded Postgres (PGlite) in PGLITE_DIR. */
  DATABASE_URL: z.string().default(''),
  PGLITE_DIR: z.string().default('.data/pglite'),
  /** The wallet that can open /admin. In practice mode with this unset, any signed-in wallet can. */
  OWNER_WALLET: z.string().default(''),
  /** LEV_OPS: receives pack payments, buys and opens packs on CC, holds cards for seconds, sells losers back. */
  LEV_OPS_PRIVATE_KEY: z.string().default(''),
  /** LEV_POOL: the leverage pool's USDC. Receives sellbacks and the fee split; pays bonuses and floors. */
  LEV_POOL_PRIVATE_KEY: z.string().default(''),
  /** Pullback's POOL wallet: the only sender whose `fee-split:` transfers count as fee income. */
  PULLBACK_POOL_WALLET: z.string().default(''),
  SOLANA_RPC_URL: z.string().default(''),
  /** DAS-capable RPC for card names and images (defaults to SOLANA_RPC_URL). */
  DAS_RPC_URL: z.string().default(''),
  COLLECTOR_CRYPT_API_KEY: z.string().default(''),
  /** Devnet: https://dev-gacha.collectorcrypt.com */
  COLLECTOR_CRYPT_BASE_URL: z.string().url().default('https://gacha.collectorcrypt.com'),
  /** CC's gacha wallet (docs.collectorcrypt.com/gacha/vrf). Confirm with CC before launch. */
  COLLECTOR_CRYPT_PAYMENT_WALLET: z.string().default('GachaNgyXTU3zFogQ8Z5jR2BLXs8215X2AtEH18VxJq3'),
  USDC_MINT: z.string().default('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  /** Priority fee on our own transactions (CC-built ones are never altered). */
  PRIORITY_MICRO_LAMPORTS: z.coerce.number().int().min(0).default(50_000),
  /** Run the background worker inside the server process. */
  WORKER_ENABLED: z.enum(['true', 'false']).default('true'),
  /** Practice mode reads real CC pull data instead of the bundled sample. */
  PRACTICE_LIVE_DATA: flag,
  /** Solscan cluster suffix for links, e.g. "devnet". */
  SOLANA_CLUSTER: z.string().default(''),
});

const parsed = schema.parse(process.env);

export const config = {
  ...parsed,
  live: parsed.MAINNET_ENABLED === 'true',
  workerEnabled: parsed.WORKER_ENABLED === 'true',
  practiceLiveData: parsed.PRACTICE_LIVE_DATA === 'true',
  dasRpcUrl: parsed.DAS_RPC_URL || parsed.SOLANA_RPC_URL,
};
export type Config = typeof config;
