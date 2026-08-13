/**
 * Lobby Registry API client (talks to the self-hosted storage service).
 * Base URL resolution mirrors the storage backend: STORAGE_BASE_URL runtime
 * config -> build-time env -> "" = same origin (/api/v2).
 */
import { STORAGE_BASE_URL } from "../data/runtimeConfig";

import type {
  CreateLobbyRoomPayload,
  LobbyRoomDetail,
  LobbyRoomSummary,
  UpdateLobbyRoomPayload,
} from "./lobbyTypes";

const baseUrl = `${STORAGE_BASE_URL}/api/v2`;

const bytesToB64 = (bytes: Uint8Array): string => {
  let bin = "";
  for (const byte of bytes) {
    bin += String.fromCharCode(byte);
  }
  return btoa(bin);
};

export const b64ToBytes = (b64: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
};

export class LobbyApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "LobbyApiError";
  }
}

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, init);
  } catch (error) {
    // network-level failure (storage down, proxy down, ...)
    throw new LobbyApiError(
      "无法连接 NAS storage 服务，请检查自托管存储是否可用",
      0,
    );
  }
  if (!res.ok) {
    let message = `lobby request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) {
        message = body.error;
      }
    } catch {
      // keep default message
    }
    throw new LobbyApiError(message, res.status);
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
};

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const lobbyApi = {
  async listRooms(): Promise<LobbyRoomSummary[]> {
    const { rooms } = await request<{ rooms: LobbyRoomSummary[] }>("/rooms");
    return rooms;
  },

  async getRoom(roomId: string): Promise<LobbyRoomDetail> {
    return request<LobbyRoomDetail>(`/rooms/${roomId}`);
  },

  async createRoom(payload: CreateLobbyRoomPayload): Promise<void> {
    await request<{ roomId: string }>("/rooms", jsonInit("POST", payload));
  },

  /** Report a successful join (updates lastOpenedAt for sorting). */
  async reportOpen(roomId: string): Promise<void> {
    await request<{ ok: true }>(`/rooms/${roomId}/open`, { method: "POST" });
  },

  async updateRoom(
    roomId: string,
    payload: UpdateLobbyRoomPayload,
  ): Promise<void> {
    await request<{ ok: true }>(`/rooms/${roomId}`, jsonInit("PATCH", payload));
  },

  /**
   * Live presence counts (roomId -> active socket count). Served by the room
   * service via the nginx exact-location proxy; failures resolve to {} so the
   * lobby keeps working when the room service is briefly unreachable.
   */
  async fetchPresence(): Promise<Record<string, number>> {
    try {
      const res = await fetch(`${baseUrl}/rooms/presence`);
      if (!res.ok) {
        return {};
      }
      return (await res.json()) as Record<string, number>;
    } catch {
      return {};
    }
  },
};

/** Prepare a wrapped-roomKey payload from plain byte material (helper for tests). */
export const encodeKeyMaterial = (payload: {
  wrappedRoomKey: Uint8Array;
  passwordSalt: Uint8Array;
  passwordIv: Uint8Array;
}) => ({
  wrappedRoomKey: bytesToB64(payload.wrappedRoomKey),
  passwordSalt: bytesToB64(payload.passwordSalt),
  passwordIv: bytesToB64(payload.passwordIv),
});
