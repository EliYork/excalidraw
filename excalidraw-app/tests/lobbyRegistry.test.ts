/**
 * Lobby Registry end-to-end test (needs node:sqlite, Node >= 22.5 — runs via
 * `yarn test:selfhost` / vitest.imagecollab.config.mts, same as the image
 * collaboration regression suite).
 *
 * Exercises the REAL storage server: create -> wrap -> registry -> unwrap with
 * correct/wrong password, manageToken-gated updates, lastOpenedAt semantics,
 * and the presence count derivation. No mocks for the server.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";

import { generateEncryptionKey } from "@excalidraw/excalidraw/data/encryption";

import { createApp } from "../../docker/storage/src/server.js";
import { computePresenceCounts } from "../../docker/room/src/presence";
import {
  deriveKek,
  generateLobbyPassword,
  generateManageToken,
  sha256Hex,
  unwrapRoomKey,
  wrapRoomKey,
} from "../lobby/lobbyCrypto";
import { b64ToBytes, encodeKeyMaterial } from "../lobby/lobbyApi";
import { lobbyStorage } from "../lobby/lobbyStorage";

let dataDir: string;
let baseUrl: string;
let closeServer: () => Promise<void>;
let store: ReturnType<typeof createApp>["store"];

// lobbyApi reads STORAGE_BASE_URL at import time; re-import after pointing the
// runtime config at the test server (same pattern as imageCollabRegression).
let lobbyApi: typeof import("../lobby/lobbyApi")["lobbyApi"];

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "excal-lobby-registry-"));
  const app = createApp({ dataDir, log: false });
  store = app.store;
  await new Promise<void>((resolve) => app.server.listen(0, resolve));
  const addr = app.server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("expected TCP address");
  }
  baseUrl = `http://127.0.0.1:${addr.port}`;
  closeServer = () =>
    new Promise<void>((resolve) => {
      app.server.closeAllConnections();
      app.server.close(() => {
        app.store.close();
        resolve();
      });
    });

  (window as any).__EXCALIDRAW_RUNTIME_CONFIG__ = { storageBaseUrl: baseUrl };
  vi.resetModules();
  ({ lobbyApi } = await import("../lobby/lobbyApi"));
});

afterAll(async () => {
  await closeServer();
  rmSync(dataDir, { recursive: true, force: true });
});

const randomRoomId = () =>
  Array.from(window.crypto.getRandomValues(new Uint8Array(10)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

/**
 * Full client-side creation flow, exactly like the lobby "New canvas" button.
 * Each call registers a fresh room id in the registry.
 */
const createLobbyRoom = async (overrides: { name?: string } = {}) => {
  const roomId = randomRoomId();
  const roomKey = await generateEncryptionKey();
  const password = generateLobbyPassword();
  const manageToken = generateManageToken();
  const salt = new Uint8Array(16);
  window.crypto.getRandomValues(salt);
  const kdfVersion = 1;
  const kdfIterations = 210000;
  const kek = await deriveKek(password, salt, kdfIterations);
  const { wrappedRoomKey, iv } = await wrapRoomKey(kek, roomKey);
  const manageTokenHash = await sha256Hex(manageToken);
  const keyMaterial = encodeKeyMaterial({
    wrappedRoomKey,
    passwordSalt: salt,
    passwordIv: iv,
  });
  await lobbyApi.createRoom({
    roomId,
    name: overrides.name ?? "Untitled canvas",
    hasPassword: true,
    ...keyMaterial,
    kdfVersion,
    kdfIterations,
    manageTokenHash,
  });
  // exactly what the lobby does on successful creation
  lobbyStorage.setRoomKey(roomId, roomKey);
  lobbyStorage.setManageToken(roomId, manageToken);
  lobbyStorage.setPassword(roomId, password);
  return { roomId, roomKey, password, manageToken };
};

describe("lobby registry: create -> wrap -> unwrap", () => {
  it("creates a room, registers it in the lobby, and unwraps with the password", async () => {
    const { roomId, roomKey, password } = await createLobbyRoom();

    const list = await lobbyApi.listRooms();
    const listed = list.find((r) => r.roomId === roomId);
    expect(listed).toBeDefined();
    expect(listed!.name).toBe("Untitled canvas");
    expect(listed!.hasPassword).toBe(true);
    expect(listed!.lastOpenedAt).toBeNull();

    // full share link already contains the roomKey -> no password needed
    expect(roomKey).toHaveLength(22);

    const detail = await lobbyApi.getRoom(roomId);
    expect(detail.kdfVersion).toBe(1);
    expect(detail.kdfIterations).toBe(210000);

    const kek = await deriveKek(
      password,
      b64ToBytes(detail.passwordSalt),
      detail.kdfIterations,
    );
    const unwrapped = await unwrapRoomKey(
      kek,
      b64ToBytes(detail.wrappedRoomKey),
      b64ToBytes(detail.passwordIv),
    );
    expect(unwrapped).toBe(roomKey);

    // successful unlock caches the roomKey locally -> passwordless re-entry
    expect(lobbyStorage.getRoomKey(roomId)).toBe(roomKey);
  });

  it("wrong password cannot unwrap; registry stores no plaintext key material", async () => {
    const { roomId, roomKey, password } = await createLobbyRoom();
    const detail = await lobbyApi.getRoom(roomId);

    const wrongKek = await deriveKek(
      `${password}-wrong`,
      b64ToBytes(detail.passwordSalt),
      detail.kdfIterations,
    );
    expect(
      await unwrapRoomKey(
        wrongKek,
        b64ToBytes(detail.wrappedRoomKey),
        b64ToBytes(detail.passwordIv),
      ),
    ).toBeNull();

    // registry must not contain plaintext password or roomKey
    const row = store.db
      .prepare("SELECT * FROM lobby_rooms WHERE room_id = ?")
      .get(roomId) as { wrapped_room_key: Uint8Array } & Record<
      string,
      unknown
    >;
    const columns = Object.keys(row);
    expect(columns).not.toContain("password");
    expect(columns).not.toContain("room_key");
    expect(columns).toContain("wrapped_room_key");
    expect(columns).toContain("manage_token_hash");
    expect(columns).not.toContain("manage_token");
    expect(Buffer.from(row.wrapped_room_key).toString("utf8")).not.toContain(
      roomKey,
    );
    expect(Buffer.from(row.wrapped_room_key).toString("utf8")).not.toContain(
      password,
    );
  });

  it("a full share link enters without any password (local roomKey cache)", async () => {
    // a client arriving with a full #room=id,key link never touches the
    // password path — the roomKey from the link is usable as-is
    const roomKey = await generateEncryptionKey();
    expect(roomKey).toHaveLength(22);
    expect(lobbyStorage.getRoomKey("not-registered-0000000")).toBeNull();
    lobbyStorage.setRoomKey("abcdef0123456789abcd", roomKey);
    expect(lobbyStorage.getRoomKey("abcdef0123456789abcd")).toBe(roomKey);
  });
});

describe("lobby registry: manageToken gated management", () => {
  it("rename requires the manage token; non-owners get 403", async () => {
    const { roomId, manageToken } = await createLobbyRoom({ name: "设计评审" });

    await expect(
      lobbyApi.updateRoom(roomId, {
        manageToken: "f".repeat(64),
        name: "Hijacked",
      }),
    ).rejects.toThrow();
    expect((await lobbyApi.getRoom(roomId)).name).toBe("设计评审");

    await lobbyApi.updateRoom(roomId, { manageToken, name: "Renamed canvas" });
    expect((await lobbyApi.getRoom(roomId)).name).toBe("Renamed canvas");
  });

  it("rotating the lobby password re-wraps the roomKey; old password stops working", async () => {
    const {
      roomId,
      roomKey,
      manageToken,
      password: oldPassword,
    } = await createLobbyRoom();

    const newPassword = generateLobbyPassword();
    const salt = new Uint8Array(16);
    window.crypto.getRandomValues(salt);
    const kek = await deriveKek(newPassword, salt, 210000);
    const { wrappedRoomKey, iv } = await wrapRoomKey(kek, roomKey);
    const keyMaterial = encodeKeyMaterial({
      wrappedRoomKey,
      passwordSalt: salt,
      passwordIv: iv,
    });
    await lobbyApi.updateRoom(roomId, {
      manageToken,
      hasPassword: true,
      ...keyMaterial,
      kdfVersion: 1,
      kdfIterations: 210000,
    });

    const detail = await lobbyApi.getRoom(roomId);

    // new password unwraps
    const newKek = await deriveKek(
      newPassword,
      b64ToBytes(detail.passwordSalt),
      detail.kdfIterations,
    );
    expect(
      await unwrapRoomKey(
        newKek,
        b64ToBytes(detail.wrappedRoomKey),
        b64ToBytes(detail.passwordIv),
      ),
    ).toBe(roomKey);

    // old password no longer unwraps
    const oldKek = await deriveKek(
      oldPassword,
      b64ToBytes(detail.passwordSalt),
      detail.kdfIterations,
    );
    expect(
      await unwrapRoomKey(
        oldKek,
        b64ToBytes(detail.wrappedRoomKey),
        b64ToBytes(detail.passwordIv),
      ),
    ).toBeNull();
  });
});

describe("lobby registry: lastOpenedAt semantics", () => {
  it("updates only after a successful join report", async () => {
    const { roomId, password } = await createLobbyRoom();

    const before = await lobbyApi.getRoom(roomId);
    expect(before.lastOpenedAt).toBeNull();

    // a wrong-password attempt does NOT touch lastOpenedAt
    const detail = await lobbyApi.getRoom(roomId);
    const wrongKek = await deriveKek(
      "not-the-password",
      b64ToBytes(detail.passwordSalt),
      detail.kdfIterations,
    );
    await unwrapRoomKey(
      wrongKek,
      b64ToBytes(detail.wrappedRoomKey),
      b64ToBytes(detail.passwordIv),
    );
    expect((await lobbyApi.getRoom(roomId)).lastOpenedAt).toBeNull();

    // successful join (correct password) -> report -> lastOpenedAt updated
    const kek = await deriveKek(
      password,
      b64ToBytes(detail.passwordSalt),
      detail.kdfIterations,
    );
    const unwrapped = await unwrapRoomKey(
      kek,
      b64ToBytes(detail.wrappedRoomKey),
      b64ToBytes(detail.passwordIv),
    );
    expect(unwrapped).toBeTruthy();
    await new Promise((r) => setTimeout(r, 5));
    await lobbyApi.reportOpen(roomId);
    const after = await lobbyApi.getRoom(roomId);
    expect(after.lastOpenedAt).toBeGreaterThan(after.createdAt);
  });
});

describe("presence counts (room service)", () => {
  it("counts only 20-hex collaboration rooms, ignoring socket/follow rooms", () => {
    const rooms = new Map<string, Set<string>>([
      ["0123456789abcdef0123", new Set(["s1", "s2"])], // 2 clients
      ["fedcba9876543210fedc", new Set(["s3"])], // 1 client
      ["s1", new Set(["s1"])], // per-socket room -> excluded
      ["follow@s1", new Set(["s9"])], // follow room -> excluded
      ["zzzzzzzzzzzzzzzzzzzz", new Set(["s4"])], // non-hex -> excluded
    ]);
    expect(computePresenceCounts(rooms)).toEqual({
      "0123456789abcdef0123": 2,
      fedcba9876543210fedc: 1,
    });
  });

  it("returns an empty object when nobody is connected", () => {
    expect(computePresenceCounts(new Map())).toEqual({});
  });
});
