# The container EV runs OpenClaw workers in when EV_OPENCLAW_SANDBOX=docker.
# Build: npm run openclaw:image   (docker build -t ev-openclaw docker/openclaw)
# openclaw 2026.10 needs Node 24.16+.
FROM node:24-bookworm-slim
ARG OPENCLAW_VERSION=latest
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git python3 chromium fonts-liberation \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "openclaw@${OPENCLAW_VERSION}" \
 && npm cache clean --force
ENV CHROME_PATH=/usr/bin/chromium
