# syntax=docker/dockerfile:1
# One Next.js server: the site, the API and the background worker. Dokploy runs it as a Swarm service
# and updates it start-first, so the new version takes over before the old one stops (docs/DOKPLOY.md).
FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM dependencies AS build
COPY . .
# A new id per build: a browser still on the previous version reloads on its next navigation instead of
# mixing old and new code. Pass the commit as DEPLOYMENT_ID if you like; the build time is the fallback.
ARG DEPLOYMENT_ID
ENV NEXT_TELEMETRY_DISABLED=1
RUN NEXT_DEPLOYMENT_ID="${DEPLOYMENT_ID:-$(date +%s)}" npm run build \
 && rm -rf .next/cache \
 && mv .next/static static-build

FROM dependencies AS production-dependencies
RUN npm prune --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim AS app
WORKDIR /app
# NEXT_MANUAL_SIG_HANDLE: instrumentation.ts handles SIGTERM, so a stopping server finishes its work and
# hands the database to the new one. DATABASE_REQUIRED: no embedded Postgres, whose data an update would wipe.
ENV NODE_ENV=production PORT=3000 NEXT_TELEMETRY_DISABLED=1 NEXT_MANUAL_SIG_HANDLE=true DATABASE_REQUIRED=true
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json next.config.ts tsconfig.json ./
COPY --chown=node:node public ./public
# Source for the npm scripts (`npm run check`, `npm run calibrate`) in the container's terminal.
COPY --chown=node:node lib ./lib
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node deploy ./deploy
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/static-build ./static-build
# .next/static is filled at start (deploy/publish-static.mjs); a Dokploy volume there keeps earlier builds' files.
RUN mkdir -p .next/static reports && chown node:node .next/static reports
USER node
EXPOSE 3000
# Healthy includes "standby": during an update the new server waits for the old one to hand over the database.
HEALTHCHECK --interval=5s --timeout=3s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["sh", "deploy/start.sh"]
