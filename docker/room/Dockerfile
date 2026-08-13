# syntax=docker/dockerfile:1
#
# Self-hosted collaboration room server.
#
# Vendored from https://github.com/excalidraw/excalidraw-room (HEAD
# 03ff435, "Barnabasmolnar/follow mode (#361)") — business code is untouched,
# only the outdated node:12 base image is fixed and a healthcheck added.
# See notes/05-UPSTREAM-MAINTENANCE.md for sync instructions.
#
# Hardening vs. upstream: digest-pinned base image, BuildKit-cached yarn
# install, non-root runtime user. Kept single-stage on purpose: upstream
# declares ALL tooling (typescript/eslint/...) under "dependencies", so a
# multi-stage split would not shrink the image, only add a second install.

FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43

WORKDIR /app

COPY package.json yarn.lock ./
# yarn 1.x cache dir on the node:alpine image (uid 0): /usr/local/share/.cache/yarn
RUN --mount=type=cache,target=/usr/local/share/.cache/yarn \
    yarn install --frozen-lockfile --network-timeout 600000

COPY tsconfig.json ./
COPY src ./src
RUN yarn build

ENV NODE_ENV=production
ENV PORT=80

# drop privileges for the runtime (uid 1000 "node" ships with the base image)
USER node

# simple liveness probe (the server itself has no health endpoint)
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:80/ || exit 1

EXPOSE 80

CMD ["node", "dist/index.js"]
