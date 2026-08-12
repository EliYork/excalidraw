# Self-hosted collaboration room server.
#
# Vendored from https://github.com/excalidraw/excalidraw-room (HEAD
# 03ff435, "Barnabasmolnar/follow mode (#361)") — business code is untouched,
# only the outdated node:12 base image is fixed and a healthcheck added.
# See notes/05-UPSTREAM-MAINTENANCE.md for sync instructions.

FROM node:24-alpine

WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --network-timeout 600000

COPY tsconfig.json ./
COPY src ./src
RUN yarn build

ENV NODE_ENV=production
ENV PORT=80

# simple liveness probe (the server itself has no health endpoint)
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:80/ || exit 1

EXPOSE 80

CMD ["node", "dist/index.js"]
