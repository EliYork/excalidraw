FROM node:24-alpine

WORKDIR /app

COPY package.json ./
COPY src ./src

ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/data

# healthcheck against the storage API
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:8080/health || exit 1

EXPOSE 8080
VOLUME /data

CMD ["node", "src/server.js"]
