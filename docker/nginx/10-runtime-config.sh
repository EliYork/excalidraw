#!/bin/sh
# Generate /usr/share/nginx/html/config.js from environment variables at
# container start. Runs before nginx starts (docker-entrypoint.d).
#
# Every field is written explicitly: an empty value means "same origin /
# disabled" and wins over the build-time VITE_APP_* default (see
# excalidraw-app/data/runtimeConfig.ts).
set -eu

: "${WS_SERVER_URL:=}"
: "${STORAGE_BASE_URL:=}"
: "${BACKEND_V2_GET_URL:=}"
: "${BACKEND_V2_POST_URL:=}"
: "${LIBRARY_URL:=}"
: "${LIBRARY_BACKEND:=}"
: "${PLUS_LP:=}"
: "${PLUS_APP:=}"
: "${AI_BACKEND:=}"
: "${MAX_FILE_UPLOAD_BYTES:=20971520}" # 20 MiB

export WS_SERVER_URL STORAGE_BASE_URL BACKEND_V2_GET_URL BACKEND_V2_POST_URL \
  LIBRARY_URL LIBRARY_BACKEND PLUS_LP PLUS_APP AI_BACKEND MAX_FILE_UPLOAD_BYTES

# escape double quotes and backslashes for safe embedding in JS strings
escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

cat > /usr/share/nginx/html/config.js <<EOF
window.__EXCALIDRAW_RUNTIME_CONFIG__ = {
  wsServerUrl: "$(escape "$WS_SERVER_URL")",
  storageBaseUrl: "$(escape "$STORAGE_BASE_URL")",
  backendV2GetUrl: "$(escape "$BACKEND_V2_GET_URL")",
  backendV2PostUrl: "$(escape "$BACKEND_V2_POST_URL")",
  libraryUrl: "$(escape "$LIBRARY_URL")",
  libraryBackend: "$(escape "$LIBRARY_BACKEND")",
  plusLp: "$(escape "$PLUS_LP")",
  plusApp: "$(escape "$PLUS_APP")",
  aiBackend: "$(escape "$AI_BACKEND")",
  maxFileUploadBytes: ${MAX_FILE_UPLOAD_BYTES},
};
EOF

echo "generated /usr/share/nginx/html/config.js"
