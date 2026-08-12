// Runtime configuration placeholder for self-hosted deployments.
// The nginx entrypoint overwrites this file at container start from
// environment variables (WS_SERVER_URL, STORAGE_BASE_URL, ...). When this
// file is served unchanged (e.g. `vite dev`), the app falls back to the
// build-time VITE_APP_* defaults.
window.__EXCALIDRAW_RUNTIME_CONFIG__ = {};
