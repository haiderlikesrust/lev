import type { Level, Outcome } from './leverage';
import type { Offer } from './calibration';
import type { Side } from './short';

export type { Side };

/** `watching`: a paid short waiting for the next pull on its machine. */
export type OrderStatus = 'awaiting_payment' | 'paying' | 'paid' | 'buying' | 'watching' | 'settling' | 'complete' | 'refunding' | 'refunded' | 'expired' | 'review';

export type CardView = { mint: string; name: string; image: string | null; rarity: string | null };

/** Transaction signatures behind one pack, for the public log. */
export type SettlementLinks = {
  payment?: string | null; packPayment?: string | null; cardDelivery?: string | null;
  sellback?: string | null; floor?: string | null; nftTransfer?: string | null; bonus?: string | null; refund?: string | null;
  /** Shorts: the stake back to the player, the payout from the pool, or the stake to the pool. */
  stakeBack?: string | null; payout?: string | null; stakeToPool?: string | null;
};

/** The CC pull a short rode: its card and CC's timestamp. */
export type PullView = { id: string; mint: string | null; pulledAt: number };

export type OrderView = {
  id: string; status: OrderStatus; wallet: string; code: string; machineName: string; side: Side; level: Level;
  priceUsd: number; multiplierBps: number; floorBps: number; capUsd: number; maxLossUsd: number;
  playerReturn: number; normalReturn: number; createdAt: number; expiresAt: number;
  card: CardView | null; valueUsd: number | null; outcome: Outcome | null;
  bonusUsd: number; floorUsd: number; sellbackUsd: number;
  message: string | null; links: SettlementLinks; memo: string | null; vrfUrl: string | null;
  /** Shorts: CC pulls stamped after this count, and the one this short rode once it came. */
  watchFrom: number | null; pull: PullView | null;
};

export type SettlementView = {
  orderId: string; wallet: string; code: string; machineName: string; side: Side; level: Level; multiplierBps: number;
  priceUsd: number; valueUsd: number; outcome: Outcome; bonusUsd: number; floorUsd: number; sellbackUsd: number;
  card: CardView | null; settledAt: number; links: SettlementLinks; vrfUrl: string | null; pull: PullView | null;
};

/** An offer as the browser sees it (USD instead of micros). */
export type OfferView = Omit<Offer, 'capMicros' | 'maxLossMicros' | 'unlockAtMicros'> & { capUsd: number; maxLossUsd: number; unlockAtUsd: number };

export type MachineView = {
  code: string; name: string; priceUsd: number; buybackPct: number; image: string | null; video: string | null; open: boolean; disabled: boolean;
  calibratedAt: number | null; pulls: number; offers: OfferView[];
  /** Shorting the next pull on this machine; null until calibrated. */
  short: OfferView | null;
};

export type PoolView = {
  balanceUsd: number; reservedUsd: number; freeUsd: number; targetUsd: number; healthBps: number; pauseReason: string | null;
  totals: {
    bonusesUsd: number; floorsUsd: number; sellbackUsd: number; feeSplitsUsd: number; packs: number; wins: number; pushes: number; losses: number;
    /** Shorts: payouts the pool made, and stakes it kept. */
    shortPayoutsUsd: number; shortStakesUsd: number; shorts: number;
  };
  feeSplits: { signature: string; amountUsd: number; cycle: string | null; receivedAt: number }[];
};

export type Period = '24h' | '7d' | 'all';

export type LeaderboardView = {
  period: Period;
  /** Wins, pushes and losses are from the player's side, across packs and shorts. */
  totals: {
    packs: number; shorts: number; wins: number; pushes: number; losses: number; volumeUsd: number;
    bonusesUsd: number; shortPayoutsUsd: number; floorsUsd: number; sellbackUsd: number; shortStakesUsd: number;
    /** Bonuses, floors and the insured value of cards sent to players; for shorts, stakes back and payouts. */
    returnedUsd: number;
    /** The biggest single bonus or short payout, and the best card a pack opened. */
    biggestBonusUsd: number; biggestPullUsd: number;
  };
  /** The biggest wins: pack bonuses and short payouts. */
  topBonuses: SettlementView[];
  topPulls: SettlementView[];
  machines: {
    code: string; name: string; image: string | null; packs: number; shorts: number; wins: number; pushes: number; losses: number;
    volumeUsd: number; bonusesUsd: number; shortPayoutsUsd: number; sellbackUsd: number; floorsUsd: number;
    /** Pool profit per dollar played: (sellbacks − floors − bonuses + short stakes kept − short payouts) / volume. */
    realizedEdge: number | null;
  }[];
};

export type PlayerLimitView = {
  dailyLossLimitUsd: number | null;
  /** A raised (or removed) limit waiting out its 24 hours. */
  pending: { dailyLossLimitUsd: number | null; at: number } | null;
  lossLast24hUsd: number;
  cooldownUntil: number | null;
};

/** Our coin's public contract address and ticker. */
export type CoinView = { mint: string; ticker: string | null };

export type MeView = { wallet: null } | { wallet: string; owner: boolean; optedIn: boolean; limits: PlayerLimitView };

export type ConfigView = {
  appName: string; practice: boolean; cluster: string; opsAddress: string | null; poolAddress: string | null;
  machines: MachineView[]; pool: PoolView;
  rules: {
    cooldownLosses: number; cooldownMinutes: number; capBps: number; edgeBps: number; minEdgeBps: number;
    minCapMultiple: number; pauseThresholdUsd: number; targetReserveUsd: number; calibrationWindowDays: number; ruinProbability: number;
    shortsEnabled: boolean; shortGuardSeconds: number; shortWaitMinutes: number;
  };
};
