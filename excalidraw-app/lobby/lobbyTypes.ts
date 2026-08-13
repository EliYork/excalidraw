/**
 * Lobby Registry types (self-hosted permanent rooms).
 *
 * Wire format mirrors the storage service endpoints:
 *   POST /api/v2/rooms            create
 *   GET  /api/v2/rooms            list (public metadata only)
 *   GET  /api/v2/rooms/:roomId    details incl. wrapped key material
 *   POST /api/v2/rooms/:roomId/open  report successful join
 *   PATCH /api/v2/rooms/:roomId   owner-only update (manageToken)
 */

/** Public room metadata (no key material). */
export type LobbyRoomSummary = {
  roomId: string;
  name: string;
  createdAt: number;
  lastOpenedAt: number | null;
  hasPassword: boolean;
};

/**
 * Room details incl. wrapped key material. The wrapped roomKey is an
 * AES-GCM ciphertext under a KEK derived (PBKDF2-SHA256) from the lobby
 * password — exposing it is by design: only the correct password unwraps it.
 */
export type LobbyRoomDetail = LobbyRoomSummary & {
  wrappedRoomKey: string; // base64
  passwordSalt: string; // base64
  passwordIv: string; // base64 (12 bytes)
  kdfVersion: number;
  kdfIterations: number;
};

/** Payload for creating a lobby room. */
export type CreateLobbyRoomPayload = {
  roomId: string;
  name: string;
  wrappedRoomKey: string; // base64
  passwordSalt: string; // base64
  passwordIv: string; // base64
  kdfVersion: number;
  kdfIterations: number;
  manageTokenHash: string; // SHA-256 hex
  hasPassword: boolean;
};

/** Owner-only update payload (PATCH). manageToken is the bearer credential. */
export type UpdateLobbyRoomPayload = {
  manageToken: string;
  name?: string;
  hasPassword?: boolean;
  wrappedRoomKey?: string; // base64
  passwordSalt?: string; // base64
  passwordIv?: string; // base64
  kdfVersion?: number;
  kdfIterations?: number;
};

/** KDF parameters stored in the registry (kdfVersion 1 = PBKDF2-SHA256). */
export const KDF_VERSION = 1;
export const KDF_ITERATIONS = 210000;
