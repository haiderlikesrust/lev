#!/bin/sh
# Container entrypoint: publish this build's static files, then run Next as PID 1 so it receives SIGTERM.
set -e
node deploy/publish-static.mjs
exec node node_modules/next/dist/bin/next start --hostname 0.0.0.0 --port "${PORT:-3000}"
