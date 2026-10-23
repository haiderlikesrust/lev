# long.cards

An optional, **high-risk** leverage add-on to Collector Crypt (CC) packs, next to Pullback (loss coverage).
The name lives in one place: `lib/shared/brand.ts`. The logo master is `public/brand/long-logo.png`; the wordmark, favicon and link preview are cut from it (`public/brand/long-wordmark.png`, `app/icon.png`, `app/apple-icon.png`, `app/opengraph-image.png`).

**What happens to a pack:**
- **You pay:** you pay the pack price.
- **We open it:** our `LEV_OPS` wallet buys and opens the CC pack, so it holds the card. A losing card can never be kept.
- **The value decides** (CC's insured value):

| Card value | Outcome | Full risk | Half risk |
|---|---|---|---|
| < 0.95× price | loss | $0. The pool sells the card back to CC. | 50% of the sellback |
| 0.95–1.05× price | push | the card | the card |
| ≥ 1.05× price | win | card + `(value − price) × (M − 1)` | same |

The bonus is capped. Every settlement is logged publicly with transaction links and CC's VRF proof.

**Shorts** are the opposite bet: that the next pull anyone opens on a machine comes out under the pack price. No pack is bought. The stake (the pack price) waits in `LEV_OPS`, and the first CC pull on that machine stamped at least `shortGuardSeconds` after the payment decides it:

| Next card | Outcome | Player gets |
|---|---|---|
| < 0.95× price | win | stake + `(price − value) × S` (from the pool) |
| 0.95–1.05× price | push | stake back |
| ≥ 1.05× price | loss | $0; the stake goes to the pool |

## Run it (practice mode)

```bash
npm install
npm run dev
```

Open http://localhost:3000.

**With no `.env`, the app runs in practice mode:**
- **Money:** play money in memory.
- **Packs:** mocked CC purchases drawn from a saved sample of 5,830 real CC pulls (values and tiers only), so outcomes and multipliers match reality.
- **Database:** embedded Postgres (PGlite) in `.data/`.
- **Wallet:** pick **Burner Wallet** in the wallet list. It is a fresh throwaway wallet on every page load.

On the Pool page, "simulate a fee split" adds play money to the pool, so you can watch levels unlock.

**If pages keep reloading on their own,** a production build in `.next` is confusing the dev server. Stop `npm run dev`, delete `.next`, and start it again. Don't run `npm run build` while dev is running.

**Other commands:**
- `npm test`: 35 tests covering the math, the payout identity, every settlement path (packs and shorts), refunds, cool-down, loss limits, unlocks and pause.
- `npm run calibrate`: read-only; prints fair multipliers from CC's live pull history (`--sample` uses the saved sample, `--pool 50000` sets the pool size).
- `npm run snapshot`: refreshes the practice sample from CC.
- `npm run check`: read-only launch checks (CC endpoints, wallets, fee-split source).

## What Collector Crypt provides (all documented at docs.collectorcrypt.com)

| Use | Endpoint |
|---|---|
| Machines, price, odds, tier ranges, buyback % | `GET /api/machines`, `GET /api/status` |
| Buy and open | `POST /api/generatePack` → sign → `POST /api/submitTransaction` → `POST /api/openPack` |
| Result and value | `GET /api/pack/status?memo=` (`send.insured_value`, `to_wallet`) |
| Sell a losing card back | `GET /api/buyback/available`, `POST /api/buyback` with `altRecipient` = LEV_POOL |
| Fairness proof | `GET /api/vrf/verify?memo=` |
| Calibration data | `GET /api/getAllWinners` (latest 200 per machine), `GET /api/getWinners?slug=&cursor=` |

**Not documented by CC:**
- How insured value is set.
- A Terms of Service about buying packs for others (TODO: ask CC).

**Hard limits from CC's docs:**
- Open a paid pack within 2 h.
- Sell back within 72 h.
- At most 30 unopened packs per wallet and machine per 2 h.

## How multipliers are set

There are no fixed tiers. Each machine × level gets the multiplier that leaves the pool a small edge, solved daily from the last 30 days of real pulls (`lib/shared/calibration.ts`):

- **Fair multiplier:** `M = 1 + ((1−φ)·b·L − edge) / W`.
  - `L` is the average take on losses; `W` is how far wins beat the price.
  - `b` is the machine's buyback; `φ` is the floor (0 for Full, 0.5 for Half).
  - With the bonus cap applied, it is solved numerically.
- **What players see:** valued at CC's sellback price, **player return = normal-open return − pool edge**, exactly. The Open page shows both numbers.
- **Edge:** 5% at launch. A machine drops to 3% once the data supports it, meaning the pool's 95% lower bound is ≥ 0 (bootstrap uncapped, normal approximation capped).
- **Thin data:** if the data supports neither edge, the level stays locked ("collecting pulls"). It is never offered at a worse multiple.
- **Unlocking:** a level opens once the free pool covers both of these:
  - its 1%-ruin bankroll `σ²·ln(100)/(2·edge)·price`;
  - a bonus cap of at least 10× the pack price.

On today's one-day sample at a $50k pool, three levels are live: $25 Half 1.50x, $25 Full 2.10x and $50 Half 1.70x. The rest open as pulls accumulate. The collector adds about 80 an hour on busy machines.

### Shorts

The same pulls price shorts (`lib/shared/short.ts`): the pool's EV per short is `H − S·D`, where `H` is the hit rate and `D` the average shortfall of a miss, so

- **Fair S:** `S = (H − edge) / D`, rounded down to 0.05x. No pack is bought, so CC's cut is not in it: **player return = −pool edge**, exactly.
- **Pool risk is small:** the most one short can win is `S × (price − cheapest card)`. On the saved sample, shorts need roughly 3–100× less pool than Full-risk longs, so every machine can open at today's pool size.
- **One pull, one bet:** every short waiting on a machine rides the same next pull, so together their top payouts share the per-pack cap (10% of the free pool).
- **No pull within `shortWaitMinutes`** (60 by default): the stake is refunded in full.
- **TODO:** CC's feed has no VRF request slot, so a short relies on CC's `created_at` stamp. Confirm on devnet that it is stamped no later than the reveal; the guard covers a short lag. If not, settle shorts only on packs this app opens.

## Pool safety and responsible play

- **Separate wallet:** `LEV_POOL`, so leverage can never touch Pullback's loss-coverage money.
- **Bonus cap:** 10% of the free pool per pack, locked at quote. Every pack in progress reserves its cap.
- **Auto-pause:**
  - globally, below the safety line ($1,000 free by default);
  - per machine, when calibration is over 48 h old.
- **Volume limits:** per-wallet and global daily limits exist but default to **off** (0), like Pullback.
- **Responsible play:**
  - Opt-in per wallet.
  - The HIGH RISK checkbox starts unticked on every pack.
  - Each player can set a daily loss limit: lowering is instant, raising takes 24 h.
  - A 10-minute cool-down after 5 losses in a row (packs and shorts count together).
  - The result screen offers no "open another" and no discounts.

## Design versions

The current design (v2) is a Pokédex-navy palette with Collector Crypt's own machine art and card photos, and a pack-opening sequence: the machine runs, then a burst, and the card flips. Design v1 (plain white) is saved as the git tag `design-v1`. To compare or go back:

```bash
git diff design-v1 -- app components
```

## Layout

| Path | What it does |
|---|---|
| `lib/shared/leverage.ts`, `calibration.ts` | Pure math: outcomes, bonus, floor, fair-multiplier solver, bootstrap, offers |
| `lib/server/orders.ts` | Order state machine: pay → buy → open → settle (loss / push / win) → log; refunds and review |
| `lib/server/cc/*` | CC client, purchase flow and pack-payment validator (ported from Pullback), plus the new sellback flow |
| `lib/server/chain.ts`, `payment.ts` | Persist-then-broadcast transactions and payment validation (ported from Pullback) |
| `lib/server/collector.ts`, `calibration.ts` | CC pull feed into the database; daily recalibration |
| `lib/server/services.ts` | Wiring, plus the background worker |
| `app/` | Pages (Home, Open, Pool, History, Admin) and `app/api/*` routes |

The worker runs inside the server process, started by `instrumentation.ts`, the way Pullback's coordinator does. That way exactly one process owns the database and every money-moving step. Run one instance.

## Before mainnet

1. **Fill in `.env.local`** from `.env.example`, then run `npm run check` until it is all green.
2. **Creator fees.** Whatever claims the coin's creator fees and swaps $CARDS to USDC sends the USDC to `LEV_POOL` from `FEE_SOURCE_WALLET` with memo `fee-split:<cycleId>`. This app indexes those transfers; the pool's share (85% by default) is set in `/admin`.
3. **Run on devnet first** against `https://dev-gacha.collectorcrypt.com`, through every settlement path. In particular, confirm the shape of CC's buyback transaction (`lib/server/cc/sellback.ts`).
4. **Mainnet smoke test:** a tiny pool and one $25 Half-risk pack. Reconcile the ledger against the chain.

**TODO / assumptions:**
- A CC API key and CC's OK to buy packs for users.
- pNFT/legacy card transfers (CC cards are Core today).
- The launch numbers (edge, cap, pause line, target, cool-down).
- The leverage-pool target for the fee split.
- Legal review (age/geo gating).
