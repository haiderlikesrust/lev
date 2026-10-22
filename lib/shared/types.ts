import type { Level, Outcome } from './leverage';
import type { Offer } from './calibration';

export type OrderStatus = 'awaiting_payment' | 'paying' | 'paid' | 'buying' | 'settling' | 'complete' | 'refunding' | 'refunded' | 'expired' | 'review';

export type CardView = { mint: string; name: string; image: string | null; rarity: string | null };

/** Transaction signatures behind one pack, for the public log. */
export type SettlementLinks = {
  payment?: string | null; packPayment?: string | null; cardDelivery?: string | null;
  sellback?: string | null; floor?: string | null; nftTransfer?: string | null; bonus?: string | null; refund?: string | null;
};

export type OrderView = {
  id: string; status: OrderStatus; wallet: string; code: string; machineName: string; level: Level;
  priceUsd: number; multiplierBps: number; floorBps: number; capUsd: number; maxLossUsd: number;
  playerReturn: number; normalReturn: number; createdAt: number; expiresAt: number;
  card: CardView | null; valueUsd: number | null; outcome: Outcome | null;
  bonusUsd: number; floorUsd: number; sellbackUsd: number;
  message: string | null; links: SettlementLinks; memo: string | null; vrfUrl: string | null;
};

export type SettlementView = {
  orderId: string; wallet: string; code: string; machineName: string; level: Level; multiplierBps: number;
  priceUsd: number; valueUsd: number; outcome: Outcome; bonusUsd: number; floorUsd: number; sellbackUsd: number;
  card: CardView | null; settledAt: number; links: SettlementLinks; vrfUrl: string | null;
};

/** An offer as the browser sees it (USD instead of micros). */
export type OfferView = Omit<Offer, 'capMicros' | 'maxLossMicros' | 'unlockAtMicros'> & { capUsd: number; maxLossUsd: number; unlockAtUsd: number };

export type MachineView = {
  code: string; name: string; priceUsd: number; buybackPct: number; image: string | null; video: string | null; open: boolean; disabled: boolean;
  calibratedAt: number | null; pulls: number; offers: OfferView[];
};

export type PoolView = {
  balanceUsd: number; reservedUsd: number; freeUsd: number; targetUsd: number; healthBps: number; pauseReason: string | null;
  totals: { bonusesUsd: number; floorsUsd: number; sellbackUsd: number; feeSplitsUsd: number; packs: number; wins: number; pushes: number; losses: number };
  feeSplits: { signature: string; amountUsd: number; cycle: string | null; receivedAt: number }[];
};

export type Period = '24h' | '7d' | 'all';

export type LeaderboardView = {
  period: Period;
  totals: {
    packs: number; wins: number; pushes: number; losses: number; volumeUsd: number; bonusesUsd: number; floorsUsd: number; sellbackUsd: number;
    /** Bonuses, floors and the insured value of cards sent to players. */
    returnedUsd: number; biggestBonusUsd: number; biggestPullUsd: number;
  };
  topBonuses: SettlementView[];
  topPulls: SettlementView[];
  machines: { code: string; name: string; image: string | null; packs: number; wins: number; pushes: number; losses: number; volumeUsd: number; bonusesUsd: number; sellbackUsd: number; floorsUsd: number;
    /** Pool profit per dollar of packs (sellbacks − floors − bonuses) / volume. */
    realizedEdge: number | null }[];
};

export type PlayerLimitView = {
  dailyLossLimitUsd: number | null;
  /** A raised (or removed) limit waiting out its 24 hours. */
  pending: { dailyLossLimitUsd: number | null; at: number } | null;
  lossLast24hUsd: number;
  cooldownUntil: number | null;
};

export type MeView = { wallet: null } | { wallet: string; owner: boolean; optedIn: boolean; limits: PlayerLimitView };

export type ConfigView = {
  appName: string; practice: boolean; cluster: string; opsAddress: string | null; poolAddress: string | null;
  machines: MachineView[]; pool: PoolView;
  rules: {
    cooldownLosses: number; cooldownMinutes: number; capBps: number; edgeBps: number; minEdgeBps: number;
    minCapMultiple: number; pauseThresholdUsd: number; targetReserveUsd: number; calibrationWindowDays: number; ruinProbability: number;
  };
};
