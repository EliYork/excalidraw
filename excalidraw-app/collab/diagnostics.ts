/**
 * Lightweight collaboration diagnostics (self-hosted operations aid).
 *
 * Polls every 2s and publishes to `window.__EXCALIDRAW_DIAG__`; also exposes
 * `window.excalidrawDiag()` to print a snapshot to the console. Default UI is
 * untouched. Purpose: surface silent transport degradation (polling fallback),
 * socket state, storage reachability, and pending image loads — the things
 * that usually explain "collaboration feels slow".
 */
import { appJotaiStore } from "../app-jotai";
import { collabAPIAtom } from "./Collab";
import { FileStatusStore } from "../data/fileStatusStore";
import { STORAGE_BASE_URL } from "../data/runtimeConfig";

export type ExcalidrawDiagnostics = {
  ts: number;
  collaborating: boolean;
  socketConnected: boolean | null;
  socketInitialized: boolean | null;
  /** "websocket" | "polling" | null — polling means the WS upgrade failed */
  transport: string | null;
  reconnectCount: number | null;
  roomId: string | null;
  filePending: number;
  fileTotal: number;
  storageBaseUrl: string;
  storage: "ok" | "unreachable" | "unknown";
  storageDb: string | null;
};

declare global {
  interface Window {
    __EXCALIDRAW_DIAG__: ExcalidrawDiagnostics | null;
    excalidrawDiag: () => void;
  }
}

const POLL_MS = 2000;

const checkStorage = async (): Promise<Pick<ExcalidrawDiagnostics, "storage" | "storageDb">> => {
  try {
    const res = await fetch(`${STORAGE_BASE_URL}/api/v2/health`, {
      cache: "no-store",
    });
    if (!res.ok) {
      return { storage: "unreachable", storageDb: null };
    }
    const body = await res.json();
    return { storage: "ok", storageDb: body.db ?? null };
  } catch {
    return { storage: "unreachable", storageDb: null };
  }
};

const collect = async (): Promise<ExcalidrawDiagnostics> => {
  const collab = appJotaiStore.get(collabAPIAtom);
  const diag = collab?.getDiagnostics ? collab.getDiagnostics() : null;

  const { pending, total } = FileStatusStore.getPendingCount(
    FileStatusStore.getSnapshot().value,
  );

  const storage = await checkStorage();

  return {
    ts: Date.now(),
    collaborating: collab?.isCollaborating() ?? false,
    socketConnected: diag?.socketConnected ?? null,
    socketInitialized: diag?.socketInitialized ?? null,
    transport: diag?.transport ?? null,
    reconnectCount: diag?.reconnectCount ?? null,
    roomId: diag?.roomId ?? null,
    filePending: pending,
    fileTotal: total,
    storageBaseUrl: STORAGE_BASE_URL || "(same origin /api/v2)",
    storage: storage.storage,
    storageDb: storage.storageDb,
  };
};

let initialized = false;

export const initDiagnostics = () => {
  if (initialized) {
    return;
  }
  initialized = true;

  window.__EXCALIDRAW_DIAG__ = null;
  window.excalidrawDiag = () => {
    // eslint-disable-next-line no-console
    console.table(window.__EXCALIDRAW_DIAG__);
  };

  const tick = async () => {
    window.__EXCALIDRAW_DIAG__ = await collect();
  };
  tick();
  setInterval(tick, POLL_MS);
};
