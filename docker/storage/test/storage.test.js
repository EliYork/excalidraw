// Storage backend tests (node:test, zero deps). Run: node --test test/
import test from "node:test";
import assert from "node:assert/strict";
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
