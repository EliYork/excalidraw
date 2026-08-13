# syntax=docker/dockerfile:1
#
# Self-hosted storage backend (scenes + encrypted files). Zero npm
# dependencies — plain Node.js + SQLite + filesystem, no install step.
#
# Hardening: digest-pinned base image, non-root runtime user, data dir
# pre-created and owned by that user (an empty named volume mounted on
# /data inherits this ownership on first use).

FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43

WORKDIR /app

COPY package.json ./
COPY src ./src

ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/data

RUN mkdir -p /data && chown -R node:node /data

# drop privileges for the runtime (uid 1000 "node" ships with the base image)
USER node

# healthcheck against the storage API
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:8080/health || exit 1

EXPOSE 8080
VOLUME /data

CMD ["node", "src/server.js"]
