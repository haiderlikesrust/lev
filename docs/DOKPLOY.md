# Deploy long.cards on Dokploy (zero-downtime updates)

The app is one Docker image (the [`Dockerfile`](../Dockerfile) at the repo root): a Next.js server that serves the site and the API and runs the background worker. Dokploy runs it next to a Postgres database:

| Dokploy service | What it is | Holds |
|---|---|---|
| **Application** `long-cards` | This repository, built from the `Dockerfile` and run as a Docker Swarm service. Traefik sends `long.cards` to it on port 3000. | The wallet keys, at runtime only |
| **Database** `long-cards-db` | PostgreSQL 17 | Orders, the ledger, settlements, pulls, calibration, settings |

## Why not a Compose service like Pullback

Pullback is a Dokploy **Docker Compose** service. On every deploy, Compose stops the old server and only then starts the new one, so the site is down for the restart. Pullback's 60-second stop grace makes that gap longer.

A Dokploy **Application** runs as a Swarm service instead. Swarm can start the new version first and stop the old one only after the new one is healthy. That is what the settings below turn on.

### What happens on an update

1. **Build.** Dokploy builds the new image on the server while the old version keeps serving. If the build fails, nothing changes.
2. **Standby.** The new container starts and connects to Postgres. Only one server may own the database (a Postgres lock), so it waits as a **standby**. Its health check counts that as healthy.
3. **Hand-over.** Swarm stops the old container. The old server lets running requests and its current worker step finish (8 seconds at most, usually well under 1), then closes its database connection. The standby takes the lock within a quarter of a second and starts serving. Requests that reach it during the hand-over wait a moment instead of failing.
4. **Open pages keep working.** Their scripts stay downloadable from the shared static volume (step 6 of the setup). On their next click, they reload into the new version, because every build has its own deployment ID.
5. **Rollback.** If the new version doesn't become healthy within a minute, Swarm puts the previous one back.

Money steps are safe across the hand-over regardless. Every transaction is saved before it is sent, and the new server resumes anything in flight from the database.

## Set up

1. **Database.**
   - In your Dokploy project, choose **Create Service → Database → PostgreSQL**. Name it `long-cards-db`, use image `postgres:17`, set a long alphanumeric password, and deploy.
   - Copy its **Internal Connection URL**. That is `DATABASE_URL`.
   - In its **Backups** tab, add an S3 destination and a daily schedule. Run one restore test before launch.
2. **Application.**
   - Choose **Create Service → Application** and name it `long-cards`.
   - In **General**, set the provider to GitHub (`haiderlikesrust/lev`, branch `master`). A Git URL with a deploy key also works.
   - Set **Build Type** to **Dockerfile**, **Dockerfile Path** to `Dockerfile` and **Docker Context Path** to `.`.
3. **Environment.**
   - Paste [`deploy/dokploy.env.example`](../deploy/dokploy.env.example) and fill in `APP_ORIGIN` and `DATABASE_URL`.
   - For the first deploy, keep `MAINNET_ENABLED=false`. That gives a public practice site with play money.
   - Add the wallet keys only when you are ready (see **Go live**). They are runtime variables, read when the server starts. Never put them in **Build-time Arguments**.
   - `MAINNET_ENABLED`, `MEMECOIN_MINT` and the other settings are read at runtime, so the same image works in practice and on mainnet.
4. **Domain.**
   - In **Domains**, add `long.cards` with path `/`, container port **3000**, and HTTPS with Let's Encrypt. Point the domain's DNS at the VPS.
   - For `www.long.cards`, add it the same way, then add a "www to non-www" redirect under **Advanced → Redirects**.
5. **Zero-downtime settings.** In **Advanced → Cluster Settings**:
   - **Replicas:** leave it at `1`. Only one server can own the database. A second replica would sit in standby, and the requests sent to it would wait.
   - **Swarm Settings → Update Config:**
     ```json
     { "Parallelism": 1, "Delay": 0, "FailureAction": "rollback", "Monitor": 60000000000, "MaxFailureRatio": 0, "Order": "start-first" }
     ```
   - **Swarm Settings → Rollback Config:**
     ```json
     { "Parallelism": 1, "Delay": 0, "FailureAction": "pause", "Monitor": 60000000000, "MaxFailureRatio": 0, "Order": "start-first" }
     ```
   - **Health Check:** the same check that is built into the image. Paste it anyway, so the update never starts without one:
     ```json
     { "Test": ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"], "Interval": 5000000000, "Timeout": 3000000000, "StartPeriod": 60000000000, "Retries": 3 }
     ```
   - Durations in these fields are in nanoseconds (5000000000 = 5 s).
6. **Shared static files.**
   - In **Advanced → Volumes**, add a **Volume Mount** with volume name `long-cards-static` and mount path `/app/.next/static`.
   - Each new container adds its build's scripts and styles there, next to earlier builds'. Files no build has used for 30 days are removed.
   - Without this volume, updates still don't go down. The difference: someone who opened a page just before an update, and then clicks something that loads more code, may need to refresh.
7. **Deploy.** Click **Deploy** and follow the build log. Then check `https://long.cards/api/health`. It should show `"ok": true`, `"state": "active"`, `"database": "postgres"` and `"mode": "practice"`.
8. **Optional:** turn on **Autodeploy** so every push to `master` deploys the same way.

## Check an update yourself

Leave this running while you click **Deploy**. It should print only `200`, with an occasional slower response during the hand-over:

```bash
while true; do curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' https://long.cards/api/config; sleep 0.5; done
```

The new container's log shows `[coordinator] standby: waiting for the running server to hand over the database`, then `[coordinator] active`.

## Go live

1. Add `OWNER_WALLET`, `SOLANA_RPC_URL` (a paid RPC), `COLLECTOR_CRYPT_API_KEY`, `FEE_SOURCE_WALLET`, `MEMECOIN_MINT`, `JUPITER_API_KEY` and both wallet keys, then redeploy.
2. Fund the wallets: SOL for fees in both, a USDC token account in both, and the starting USDC in `LEV_POOL`.
3. Open the application's terminal in Dokploy and run the read-only checks:
   ```sh
   npm run check
   npm run calibrate
   ```
   Calibration also runs by itself every day; the command prints the current numbers.
4. Set `MAINNET_ENABLED=true` and redeploy. Start with a tiny pool: one $25 Half-risk pack, then compare the Pool page with the wallets on Solscan.

To stop spending at any time, use **Pause** in `/admin`. It takes effect immediately and survives updates.

## Rules that keep updates seamless

- **Database changes must be additive.** Add tables and columns (`ADD COLUMN IF NOT EXISTS`); don't rename or drop them in the same release as the code that stops using them. After a rollback, the previous version runs against the new schema.
- **Keep one replica.** A second replica can't help: it would only wait in standby.
- **Changing settings needs a redeploy.** Settings are read when the server starts, and the redeploy goes through the same hand-over.
- **The static volume outlives versions.** Never point two different apps at `long-cards-static`.

## Local check of the image

With Docker running, you can build the image and start it against a local Postgres:

```sh
docker build -t long-cards .
docker network create long-cards-test
docker run -d --name long-cards-db --network long-cards-test -e POSTGRES_PASSWORD=localTestOnly postgres:17-alpine
docker run --rm -p 3000:3000 --network long-cards-test -e DATABASE_URL=postgres://postgres:localTestOnly@long-cards-db:5432/postgres -e APP_ORIGIN=http://localhost:3000 long-cards
```

Reference: [Dokploy zero downtime](https://docs.dokploy.com/docs/core/applications/zero-downtime), [Dokploy advanced settings](https://docs.dokploy.com/docs/core/applications/advanced), [Next.js self-hosting](https://nextjs.org/docs/app/guides/self-hosting).
