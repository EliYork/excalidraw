/**
 * Lobby crypto / sorting / local-cache unit tests.
 * Runs in the default vitest (jsdom) suite — no node:sqlite dependency.
 */
import { describe, expect, it } from "vitest";

import {
  deriveKek,
  generateLobbyPassword,
  generateManageToken,
  LOBBY_PASSWORD_ALPHABET,
  sha256Hex,
  unwrapRoomKey,
  wrapRoomKey,
} from "../lobby/lobbyCrypto";
import { lobbyStorage } from "../lobby/lobbyStorage";
import { sortLobbyRooms } from "../lobby/lobbySort";

import type { LobbyRoomSummary } from "../lobby/lobbyTypes";

const room = (overrides: Partial<LobbyRoomSummary>): LobbyRoomSummary => ({
  roomId: "0123456789abcdef0123",
  name: "Untitled canvas",
  createdAt: 1000,
  lastOpenedAt: null,
  hasPassword: true,
  ...overrides,
});

describe("generateLobbyPassword", () => {
  it("formats as 4-4-2 from the safe alphabet (no 0/O/1/I/L)", () => {
    for (let i = 0; i < 200; i++) {
      const password = generateLobbyPassword();
      expect(password).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{2}$/);
      for (const char of password.replace(/-/g, "")) {
        expect(LOBBY_PASSWORD_ALPHABET).toContain(char);
        expect("0O1IL").not.toContain(char);
      }
    }
  });
});

describe("generateManageToken", () => {
  it("is 64 hex chars and unique per call", () => {
    const a = generateManageToken();
    const b = generateManageToken();
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(b).toMatch(/^[a-f0-9]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe("PBKDF2-SHA256 + AES-GCM wrap/unwrap of the roomKey", () => {
  const ROOM_KEY = "AbCdEfGhIjKlMnOpQrStUv"; // 22-char base64url-style key
  const PASSWORD = "K7PM-4XQH-Z2";

  it("roundtrips with the correct password", async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const kek = await deriveKek(PASSWORD, salt, 210000);
    const { wrappedRoomKey, iv } = await wrapRoomKey(kek, ROOM_KEY);

    // the ciphertext must not contain the plaintext roomKey
    expect(new TextDecoder().decode(wrappedRoomKey)).not.toContain(ROOM_KEY);

    const unwrapped = await unwrapRoomKey(kek, wrappedRoomKey, iv);
    expect(unwrapped).toBe(ROOM_KEY);
  });

  it("returns null for a wrong password (AES-GCM authentication fails)", async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const kek = await deriveKek(PASSWORD, salt, 210000);
    const { wrappedRoomKey, iv } = await wrapRoomKey(kek, ROOM_KEY);

    const wrongKek = await deriveKek("WRONG-PASSWORD", salt, 210000);
    expect(await unwrapRoomKey(wrongKek, wrappedRoomKey, iv)).toBeNull();
  });

  it("different salts produce different wraps", async () => {
    const saltA = crypto.getRandomValues(new Uint8Array(16));
    const saltB = crypto.getRandomValues(new Uint8Array(16));
    const kekA = await deriveKek(PASSWORD, saltA, 210000);
    const kekB = await deriveKek(PASSWORD, saltB, 210000);
    const wrapA = await wrapRoomKey(kekA, ROOM_KEY);
    const wrapB = await wrapRoomKey(kekB, ROOM_KEY);
    expect(wrapA.wrappedRoomKey).not.toEqual(wrapB.wrappedRoomKey);
    // cross-unwrap must fail (wrong KEK => wrong key => auth failure)
    expect(
      await unwrapRoomKey(kekB, wrapA.wrappedRoomKey, wrapA.iv),
    ).toBeNull();
  });
});

describe("sha256Hex", () => {
  it("matches the known SHA-256 test vector", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("sortLobbyRooms", () => {
  it("pinned rooms come first in pinned order; rest by lastOpenedAt DESC", () => {
    const rooms = [
      room({ roomId: "a".repeat(20), lastOpenedAt: 5000 }),
      room({ roomId: "b".repeat(20), lastOpenedAt: 1000 }),
      room({ roomId: "c".repeat(20), lastOpenedAt: 3000 }),
      room({ roomId: "d".repeat(20), lastOpenedAt: null }),
    ];
    const sorted = sortLobbyRooms(rooms, ["b".repeat(20), "d".repeat(20)]);
    expect(sorted.map((r) => r.roomId)).toEqual([
      "b".repeat(20), // pinned
      "d".repeat(20), // pinned (never opened, still before unpinned)
      "a".repeat(20), // lastOpenedAt 5000
      "c".repeat(20), // lastOpenedAt 3000
    ]);
  });

  it("ties break by createdAt DESC", () => {
    const rooms = [
      room({ roomId: "a".repeat(20), lastOpenedAt: 1000, createdAt: 100 }),
      room({ roomId: "b".repeat(20), lastOpenedAt: 1000, createdAt: 200 }),
    ];
    const sorted = sortLobbyRooms(rooms, []);
    expect(sorted.map((r) => r.roomId)).toEqual([
      "b".repeat(20),
      "a".repeat(20),
    ]);
  });

  it("is purely local — no server fields involved", () => {
    const rooms = [room({ roomId: "a".repeat(20), lastOpenedAt: null })];
    const sorted = sortLobbyRooms(rooms, ["a".repeat(20)]);
    expect(sorted).toHaveLength(1);
    expect(sorted[0].roomId).toBe("a".repeat(20));
  });
});

describe("lobbyStorage roomKey cache (passwordless re-entry)", () => {
  const ROOM_ID = "feedfacefeedfacefeed";

  it("stores and returns the cached roomKey", () => {
    lobbyStorage.setRoomKey(ROOM_ID, "some-room-key");
    expect(lobbyStorage.getRoomKey(ROOM_ID)).toBe("some-room-key");
  });

  it("returns null for unknown rooms (=> lobby password is required)", () => {
    expect(lobbyStorage.getRoomKey("deadbeefdeadbeefdead")).toBeNull();
  });

  it("keeps pinned ids ordered and local-only", () => {
    lobbyStorage.setPinned(["a".repeat(20), "b".repeat(20)]);
    expect(lobbyStorage.getPinned()).toEqual(["a".repeat(20), "b".repeat(20)]);
    expect(lobbyStorage.togglePinned("c".repeat(20))).toBe(true);
    expect(lobbyStorage.getPinned()).toEqual([
      "a".repeat(20),
      "b".repeat(20),
      "c".repeat(20),
    ]);
    expect(lobbyStorage.togglePinned("a".repeat(20))).toBe(false);
    expect(lobbyStorage.getPinned()).toEqual(["b".repeat(20), "c".repeat(20)]);
    lobbyStorage.setPinned([]);
  });

  it("manage token cache is per-room", () => {
    lobbyStorage.setManageToken(ROOM_ID, "m".repeat(64));
    expect(lobbyStorage.getManageToken(ROOM_ID)).toBe("m".repeat(64));
    expect(lobbyStorage.getManageToken("ffffffffffffffffffff")).toBeNull();
  });
});
