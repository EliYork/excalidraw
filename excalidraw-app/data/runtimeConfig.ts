/**
 * Runtime configuration for self-hosted deployments.
 *
 * Official Excalidraw injects every setting at build time via `import.meta.env`
 * (VITE_APP_*), which makes container `-e` flags useless after `vite build`.
 * This module adds a runtime override layer: the reverse proxy (nginx) writes
 * a `/config.js` file that assigns `window.__EXCALIDRAW_RUNTIME_CONFIG__`
 * (generated from environment variables at container start). Values here win
 * over the build-time defaults, so deployers never need to rebuild the image
 * to change domains.
 *
 * Priority: window.__EXCALIDRAW_RUNTIME_CONFIG__ > import.meta.env > fallback.
 */

export type RuntimeConfig = {
  /** Socket.IO server URL. Empty string = same origin (`/socket.io`). */
  wsServerUrl?: string;
  /**
   * Storage backend root URL. Empty string = same origin (`/api/v2`).
   * When set it must NOT include the `/api/v2` suffix (it is appended here).
   */
  storageBaseUrl?: string;
  /** Share-link backend (scene JSON). Empty string = same origin `/api/v2`. */
  backendV2GetUrl?: string;
  backendV2PostUrl?: string;
  libraryUrl?: string;
  libraryBackend?: string;
  plusLp?: string;
  plusApp?: string;
  aiBackend?: string;
  /** Max allowed image upload size in bytes (default 20 MiB). */
  maxFileUploadBytes?: number;
};

declare global {
  interface Window {
    __EXCALIDRAW_RUNTIME_CONFIG__?: RuntimeConfig;
  }
}

const runtimeConfig: RuntimeConfig =
  (typeof window !== "undefined" && window.__EXCALIDRAW_RUNTIME_CONFIG__) || {};

export const getRuntimeConfig = () => runtimeConfig;

/**
 * Values below use `??` semantics: a field explicitly set to "" in the runtime
 * config means "same origin / disabled" and WINS over the build-time default.
 * An absent field (undefined) falls back to import.meta.env.
 */

/** Socket.IO server URL; "" lets socket.io-client default to same origin. */
export const WS_SERVER_URL: string =
  runtimeConfig.wsServerUrl !== undefined
    ? runtimeConfig.wsServerUrl
    : import.meta.env.VITE_APP_WS_SERVER_URL || "";

/** Storage API root (without the `/api/v2` suffix). "" = same origin. */
export const STORAGE_BASE_URL: string =
  runtimeConfig.storageBaseUrl !== undefined
    ? runtimeConfig.storageBaseUrl
    : import.meta.env.VITE_APP_STORAGE_BASE_URL || "";

export const BACKEND_V2_GET_URL: string =
  runtimeConfig.backendV2GetUrl !== undefined
    ? runtimeConfig.backendV2GetUrl
    : import.meta.env.VITE_APP_BACKEND_V2_GET_URL || "";

export const BACKEND_V2_POST_URL: string =
  runtimeConfig.backendV2PostUrl !== undefined
    ? runtimeConfig.backendV2PostUrl
    : import.meta.env.VITE_APP_BACKEND_V2_POST_URL || "";

export const LIBRARY_URL: string =
  runtimeConfig.libraryUrl !== undefined
    ? runtimeConfig.libraryUrl
    : import.meta.env.VITE_APP_LIBRARY_URL || "";

export const LIBRARY_BACKEND: string =
  runtimeConfig.libraryBackend !== undefined
    ? runtimeConfig.libraryBackend
    : import.meta.env.VITE_APP_LIBRARY_BACKEND || "";

export const PLUS_LP: string =
  runtimeConfig.plusLp !== undefined
    ? runtimeConfig.plusLp
    : import.meta.env.VITE_APP_PLUS_LP || "";

export const PLUS_APP: string =
  runtimeConfig.plusApp !== undefined
    ? runtimeConfig.plusApp
    : import.meta.env.VITE_APP_PLUS_APP || "";

export const AI_BACKEND: string =
  runtimeConfig.aiBackend !== undefined
    ? runtimeConfig.aiBackend
    : import.meta.env.VITE_APP_AI_BACKEND || "";

/** Default max image upload size: 20 MiB (self-hosted; official default is 4 MiB). */
export const DEFAULT_MAX_FILE_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * Max allowed image upload size in bytes. Single source of truth for the
 * frontend checks (insertion + FileManager.encodeFilesForUpload); the storage
 * service's body limit must be configured >= this (compose uses the same
 * MAX_FILE_UPLOAD_BYTES variable).
 */
export const MAX_FILE_UPLOAD_BYTES: number =
  runtimeConfig.maxFileUploadBytes !== undefined
    ? runtimeConfig.maxFileUploadBytes
    : Number(import.meta.env.VITE_APP_MAX_FILE_UPLOAD_BYTES) ||
      DEFAULT_MAX_FILE_UPLOAD_BYTES;
