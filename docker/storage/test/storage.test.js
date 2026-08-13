// Storage backend tests (node:test, zero deps). Run: node --test test/
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server.js";

const ROOM = "0123456789abcdef0123"; // 20 hex
const ROOM2 = "fedcba9876543210fedc"; // 20 hex
const FILE = "a".repeat(40); // 40 hex
const FILE2 = "b".repeat(40);

const startServer = async (opts = {}) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "excal-storage-"));
  const { server, store } = createApp({ dataDir, log: false, ...opts });
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    dataDir,
    store,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          store.close();
          rmSync(dataDir, { recursive: true, force: true });
          resolve();
        });
      }),
  };
};

const sceneBody = (sceneVersion, iv = "a".repeat(12), ciphertext = "YWJjZA==") => ({
  sceneVersion,
  iv: Buffer.from(iv, "utf8").toString("base64"), // 12 bytes
  ciphertext,
});

test("health endpoint reports ok", async () => {
  const s = await startServer();
  try {
    const res = await fetch(`${s.base}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "ok");
    assert.equal(body.db, "ok");
  } finally {
    await s.close();
  }
});

test("scene create + read roundtrip", async () => {
  const s = await startServer();
  try {
    const put = await fetch(`${s.base}/api/v2/scenes/${ROOM}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sceneBody(3)),
    });
    assert.equal(put.status, 200);
    const { etag } = await put.json();
    assert.ok(etag);

    const get = await fetch(`${s.base}/api/v2/scenes/${ROOM}`);
    assert.equal(get.status, 200);
    const body = await get.json();
    assert.equal(body.sceneVersion, 3);
    assert.equal(body.etag, etag);
    assert.ok(body.iv && body.ciphertext);
  } finally {
    await s.close();
  }
});

test("scene CAS: create-only rejects existing, If-Match enforces version", async () => {
  const s = await startServer();
  try {
    // create
    const put1 = await fetch(`${s.base}/api/v2/scenes/${ROOM}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sceneBody(1)),
    });
    assert.equal(put1.status, 200);
    const { etag } = await put1.json();

    // create-only (no If-Match) on existing doc -> 409
    const put2 = await fetch(`${s.base}/api/v2/scenes/${ROOM}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sceneBody(2)),
    });
    assert.equal(put2.status, 409);

    // stale If-Match -> 409
    const put3 = await fetch(`${s.base}/api/v2/scenes/${ROOM}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "If-Match": "0-0" },
      body: JSON.stringify(sceneBody(2)),
    });
    assert.equal(put3.status, 409);

    // correct If-Match -> 200
    const put4 = await fetch(`${s.base}/api/v2/scenes/${ROOM}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "If-Match": etag },
      body: JSON.stringify(sceneBody(2)),
    });
    assert.equal(put4.status, 200);
    const body4 = await put4.json();
    assert.notEqual(body4.etag, etag);
  } finally {
    await s.close();
  }
});

test("scene: invalid roomId rejected (path traversal attempts)", async () => {
  const s = await startServer();
  try {
    for (const bad of ["..%2F..", "../../etc", "AAAA", "a".repeat(19), "z".repeat(20), "a".repeat(21)]) {
      const get = await fetch(`${s.base}/api/v2/scenes/${bad}`);
      // path traversal attempts are normalized by the URL parser into other
      // paths (e.g. /etc -> 404); the invariant is: never 200, never a write
      assert.ok([400, 404].includes(get.status), `expected 4xx for ${bad}, got ${get.status}`);
    }
    // valid id but missing -> 404; traversal attempts may be normalized by the
    // URL parser into other paths, so any non-2xx is acceptable
    const get = await fetch(`${s.base}/api/v2/scenes/${ROOM2}`);
    assert.equal(get.status, 404);
  } finally {
    await s.close();
  }
});

test("file PUT/GET roundtrip with long cache header", async () => {
  const s = await startServer();
  try {
    const payload = Buffer.from("encrypted-bytes-1234");
    const put = await fetch(`${s.base}/api/v2/files/rooms/${ROOM}/${FILE}`, {
      method: "PUT",
      body: payload,
    });
    assert.equal(put.status, 200);

    const get = await fetch(`${s.base}/api/v2/files/rooms/${ROOM}/${FILE}`);
    assert.equal(get.status, 200);
    assert.equal(get.headers.get("cache-control"), "public, max-age=31536000");
    assert.equal(get.headers.get("content-type"), "application/octet-stream");
    const bytes = Buffer.from(await get.arrayBuffer());
    assert.deepEqual(bytes, payload);
  } finally {
    await s.close();
  }
});

test("file: invalid ids rejected; missing file 404; shareLinks kind works", async () => {
  const s = await startServer();
  try {
    const bad = await fetch(`${s.base}/api/v2/files/rooms/${ROOM}/${"g".repeat(40)}`);
    assert.equal(bad.status, 400);

    const missing = await fetch(`${s.base}/api/v2/files/rooms/${ROOM}/${FILE}`);
    assert.equal(missing.status, 404);

    const shareId = "share123";
    const put = await fetch(`${s.base}/api/v2/files/shareLinks/${shareId}/${FILE}`, {
      method: "PUT",
      body: Buffer.from("x"),
    });
    assert.equal(put.status, 200);
    const get = await fetch(`${s.base}/api/v2/files/shareLinks/${shareId}/${FILE}`);
    assert.equal(get.status, 200);

    // traversal via owner id
    const evil = await fetch(`${s.base}/api/v2/files/rooms/${"..%2F..%2Fetc"}/${FILE}`);
    assert.ok([400, 404].includes(evil.status));
  } finally {
    await s.close();
  }
});

test("oversized body rejected with 413", async () => {
  const s = await startServer({ maxBodyBytes: 1024 });
  try {
    const big = Buffer.alloc(4096, 1);
    const put = await fetch(`${s.base}/api/v2/files/rooms/${ROOM}/${FILE}`, {
      method: "PUT",
      body: big,
    });
    assert.equal(put.status, 413);

    const scenePut = await fetch(`${s.base}/api/v2/scenes/${ROOM}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sceneVersion: 1, iv: "a".repeat(16), ciphertext: "x".repeat(8192) }),
    });
    assert.equal(scenePut.status, 413);

    // file not written
    const get = await fetch(`${s.base}/api/v2/files/rooms/${ROOM}/${FILE}`);
    assert.equal(get.status, 404);
  } finally {
    await s.close();
  }
});

test("data persists across restart (same data dir)", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "excal-storage-persist-"));
  let server1;
  let store1;
  try {
    ({ server: server1, store: store1 } = createApp({ dataDir, log: false }));
    await new Promise((resolve) => server1.listen(0, resolve));
    const base = `http://127.0.0.1:${server1.address().port}`;
    const put = await fetch(`${base}/api/v2/scenes/${ROOM}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sceneBody(5)),
    });
    assert.equal(put.status, 200);
    const fput = await fetch(`${base}/api/v2/files/rooms/${ROOM}/${FILE}`, {
      method: "PUT",
      body: Buffer.from("persisted"),
    });
    assert.equal(fput.status, 200);
    await new Promise((resolve) => server1.close(resolve));
    store1.close();

    const { server: server2, store: store2 } = createApp({ dataDir, log: false });
    try {
      await new Promise((resolve) => server2.listen(0, resolve));
      const base2 = `http://127.0.0.1:${server2.address().port}`;
      const get = await fetch(`${base2}/api/v2/scenes/${ROOM}`);
      assert.equal(get.status, 200);
      const body = await get.json();
      assert.equal(body.sceneVersion, 5);
      const fget = await fetch(`${base2}/api/v2/files/rooms/${ROOM}/${FILE}`);
      assert.equal(fget.status, 200);
      assert.equal(await fget.text(), "persisted");
    } finally {
      await new Promise((resolve) => server2.close(resolve));
      store2.close();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Lobby Registry
// ---------------------------------------------------------------------------

const b64 = (buf) => Buffer.from(buf).toString("base64");

// Test owner credentials: the client-side manage token is "a"*64 and the
// registry stores only its SHA-256 digest — exactly what the real flow does.
const MANAGE_TOKEN = "a".repeat(64);
const MANAGE_TOKEN_HASH = createHash("sha256").update(MANAGE_TOKEN, "utf8").digest("hex");

const roomBody = (overrides = {}) => ({
  roomId: ROOM,
  name: "未命名画布",
  wrappedRoomKey: b64(Buffer.from("wrapped-room-key-ciphertext")),
  passwordSalt: b64(Buffer.from("0123456789abcdef")), // 16 bytes
  passwordIv: b64(Buffer.from("123456789012")), // 12 bytes
  kdfVersion: 1,
  kdfIterations: 210000,
  manageTokenHash: MANAGE_TOKEN_HASH,
  ...overrides,
});

test("lobby: create, list and get roundtrip", async () => {
  const s = await startServer();
  try {
    const create = await fetch(`${s.base}/api/v2/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(roomBody()),
    });
    assert.equal(create.status, 200);
    assert.deepEqual(await create.json(), { roomId: ROOM });

    const list = await fetch(`${s.base}/api/v2/rooms`);
    assert.equal(list.status, 200);
    const { rooms } = await list.json();
    assert.equal(rooms.length, 1);
    assert.deepEqual(rooms[0], {
      roomId: ROOM,
      name: "未命名画布",
      createdAt: rooms[0].createdAt,
      lastOpenedAt: null,
      hasPassword: true,
    });
    // list must never leak key material
    assert.ok(!("wrappedRoomKey" in rooms[0]));
    assert.ok(!("manageTokenHash" in rooms[0]));

    const get = await fetch(`${s.base}/api/v2/rooms/${ROOM}`);
    assert.equal(get.status, 200);
    const room = await get.json();
    assert.equal(room.wrappedRoomKey, roomBody().wrappedRoomKey);
    assert.equal(room.passwordSalt, roomBody().passwordSalt);
    assert.equal(room.passwordIv, roomBody().passwordIv);
    assert.equal(room.kdfVersion, 1);
    assert.equal(room.kdfIterations, 210000);
    // manage token hash is owner-only; never exposed over the API
    assert.ok(!("manageTokenHash" in room));
  } finally {
    await s.close();
  }
});

test("lobby: duplicate create -> 409; unknown room -> 404", async () => {
  const s = await startServer();
  try {
    const create = await fetch(`${s.base}/api/v2/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(roomBody()),
    });
    assert.equal(create.status, 200);

    const dup = await fetch(`${s.base}/api/v2/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(roomBody()),
    });
    assert.equal(dup.status, 409);

    const missing = await fetch(`${s.base}/api/v2/rooms/${ROOM2}`);
    assert.equal(missing.status, 404);
    const openMissing = await fetch(`${s.base}/api/v2/rooms/${ROOM2}/open`, {
      method: "POST",
    });
    assert.equal(openMissing.status, 404);
  } finally {
    await s.close();
  }
});

test("lobby: open reports successful join and updates lastOpenedAt", async () => {
  const s = await startServer();
  try {
    await fetch(`${s.base}/api/v2/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(roomBody()),
    });

    const before = await (await fetch(`${s.base}/api/v2/rooms/${ROOM}`)).json();
    assert.equal(before.lastOpenedAt, null);

    await new Promise((r) => setTimeout(r, 5));
    const open = await fetch(`${s.base}/api/v2/rooms/${ROOM}/open`, {
      method: "POST",
    });
    assert.equal(open.status, 200);

    const after = await (await fetch(`${s.base}/api/v2/rooms/${ROOM}`)).json();
    assert.ok(after.lastOpenedAt > before.createdAt);
  } finally {
    await s.close();
  }
});

test("lobby: manage token gates rename and password rotation", async () => {
  const s = await startServer();
  try {
    await fetch(`${s.base}/api/v2/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(roomBody()),
    });

    // wrong token -> 403
    const badToken = await fetch(`${s.base}/api/v2/rooms/${ROOM}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manageToken: "b".repeat(64), name: "Hijacked" }),
    });
    assert.equal(badToken.status, 403);
    const unchanged = await (await fetch(`${s.base}/api/v2/rooms/${ROOM}`)).json();
    assert.equal(unchanged.name, "未命名画布");

    // correct token -> rename
    const rename = await fetch(`${s.base}/api/v2/rooms/${ROOM}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manageToken: MANAGE_TOKEN, name: "设计评审" }),
    });
    assert.equal(rename.status, 200);
    const renamed = await (await fetch(`${s.base}/api/v2/rooms/${ROOM}`)).json();
    assert.equal(renamed.name, "设计评审");

    // correct token -> rotate password (new wrap material)
    const rotate = await fetch(`${s.base}/api/v2/rooms/${ROOM}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        manageToken: MANAGE_TOKEN,
        hasPassword: true,
        wrappedRoomKey: b64(Buffer.from("new-wrapped-room-key")),
        passwordSalt: b64(Buffer.from("fedcba9876543210")),
        passwordIv: b64(Buffer.from("abcdefabcdef")),
        kdfVersion: 1,
        kdfIterations: 310000,
      }),
    });
    assert.equal(rotate.status, 200);
    const rotated = await (await fetch(`${s.base}/api/v2/rooms/${ROOM}`)).json();
    assert.equal(rotated.wrappedRoomKey, b64(Buffer.from("new-wrapped-room-key")));
    assert.equal(rotated.kdfIterations, 310000);
    assert.notEqual(rotated.name, undefined); // name untouched
    assert.equal(rotated.name, "设计评审");
  } finally {
    await s.close();
  }
});

test("lobby: rejects invalid payloads", async () => {
  const s = await startServer();
  try {
    const bads = [
      roomBody({ roomId: "not-hex!" }),
      roomBody({ name: "" }),
      roomBody({ name: "   " }),
      roomBody({ wrappedRoomKey: "!!!not-base64" }),
      roomBody({ passwordSalt: b64(Buffer.from("short")) }),
      roomBody({ passwordIv: b64(Buffer.from("short-iv")) }),
      roomBody({ kdfVersion: 99 }),
      roomBody({ kdfIterations: 1 }),
      roomBody({ manageTokenHash: "xyz" }),
      roomBody({ manageTokenHash: "a".repeat(63) }),
    ];
    for (const body of bads) {
      const res = await fetch(`${s.base}/api/v2/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    }
    const list = await (await fetch(`${s.base}/api/v2/rooms`)).json();
    assert.equal(list.rooms.length, 0);

    // PATCH on a valid room with malformed body
    await fetch(`${s.base}/api/v2/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(roomBody()),
    });
    const badPatch = await fetch(`${s.base}/api/v2/rooms/${ROOM}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manageToken: MANAGE_TOKEN, name: "" }),
    });
    assert.equal(badPatch.status, 400);
  } finally {
    await s.close();
  }
});

test("lobby: registry schema never stores plaintext password or roomKey", async () => {
  const s = await startServer();
  try {
    await fetch(`${s.base}/api/v2/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(roomBody()),
    });

    const row = s.store.db.prepare("SELECT * FROM lobby_rooms WHERE room_id = ?").get(ROOM);
    assert.ok(row, "row exists");
    const columns = Object.keys(row);

    // No plaintext password column: only KDF material (salt/iv) and a flag.
    assert.ok(!columns.includes("password"), `no plaintext password column; got ${columns.join(", ")}`);
    assert.ok(
      !columns.some((col) => /plain|text|raw/i.test(col)),
      `no column suggests plaintext storage; got ${columns.join(", ")}`,
    );
    // No plaintext roomKey column: only the wrapped ciphertext.
    assert.ok(!columns.includes("room_key"), "no room_key column");
    assert.ok(columns.includes("wrapped_room_key"), "wrapped_room_key present");
    assert.ok(!columns.includes("manage_token"), "no manage token column");

    // the wrapped key cell stores exactly the ciphertext the client sent
    assert.equal(Buffer.from(row.wrapped_room_key).toString("base64"), roomBody().wrappedRoomKey);
    assert.equal(row.manage_token_hash, MANAGE_TOKEN_HASH);
  } finally {
    await s.close();
  }
});

test("lobby: presence-like unknown paths 404, non-room ids never 200", async () => {
  const s = await startServer();
  try {
    const presence = await fetch(`${s.base}/api/v2/rooms/presence`);
    assert.equal(presence.status, 404);
    const bad = await fetch(`${s.base}/api/v2/rooms/${"z".repeat(20)}`);
    assert.equal(bad.status, 404);
    const list = await fetch(`${s.base}/api/v2/rooms`);
    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), { rooms: [] });
  } finally {
    await s.close();
  }
});
