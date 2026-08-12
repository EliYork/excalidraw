#!/usr/bin/env node
/**
 * End-to-end storage protocol test (self-hosted stack).
 *
 * Exercises the exact wire format the frontend uses, with the same crypto
 * parameters as the official client (AES-128-GCM, 12-byte IV, base64url key):
 *   1. scene save -> load roundtrip (encrypted elements JSON)
 *   2. file save -> load roundtrip (encrypted bytes)
 *   3. optimistic concurrency: two clients edit from the same base; the loser
 *      gets 409 and must re-read, reconcile, and retry (mirrors saveToFirebase)
 *
 * Usage: node scripts/storage-e2e.mjs [storageBaseUrl]
 */
import { webcrypto } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";

const BASE = process.argv[2] || "http://localhost:8080";
// random ids per run so re-runs never collide with leftover data
const randHex = (bytes) => Buffer.from(webcrypto.getRandomValues(new Uint8Array(bytes))).toString("hex");
const ROOM_ID = randHex(10); // 20 hex chars
const ROOM_ID2 = randHex(10);
const FILE_ID = randHex(20); // 40 hex chars

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const b64 = (buf) => Buffer.from(buf).toString("base64");
const unb64 = (str) => Buffer.from(str, "base64");

// --- client-side crypto mirroring packages/excalidraw/data/encryption.ts ---
const generateRoomKey = async () => {
  const key = await webcrypto.subtle.generateKey(
    { name: "AES-GCM", length: 128 },
    true,
    ["encrypt", "decrypt"],
  );
  const jwk = await webcrypto.subtle.exportKey("jwk", key);
  return jwk.k; // base64url, 22 chars
};

const importKey = (keyB64url) =>
  webcrypto.subtle.importKey(
    "jwk",
    {
      alg: "A128GCM",
      ext: true,
      k: keyB64url,
      key_ops: ["encrypt", "decrypt"],
      kty: "oct",
    },
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );

const encrypt = async (key, plaintext) => {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await webcrypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await importKey(key),
    plaintext,
  );
  return { iv, ciphertext: new Uint8Array(ciphertext) };
};

const decrypt = async (key, iv, ciphertext) => {
  const plain = await webcrypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    await importKey(key),
    ciphertext,
  );
  return new Uint8Array(plain);
};

// --- helpers ---------------------------------------------------------------
let passed = 0;
let failed = 0;
const check = (name, cond, extra = "") => {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} ${extra}`);
  }
};

const api = (p) => `${BASE}/api/v2${p}`;

// ---------------------------------------------------------------------------
console.log(`storage-e2e: base=${BASE}`);
console.log("");

// 1. scene roundtrip
console.log("== scene roundtrip (encrypted elements) ==");
{
  const key = await generateRoomKey();
  const elements = [
    { id: "el1", type: "rectangle", x: 0, y: 0, version: 1 },
    { id: "el2", type: "text", x: 10, y: 20, version: 2 },
  ];
  const sceneVersion = 42;
  const plaintext = new TextEncoder().encode(JSON.stringify(elements));
  const { iv, ciphertext } = await encrypt(key, plaintext);

  // PUT (create-only, no If-Match)
  let res = await fetch(api(`/scenes/${ROOM_ID}`), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sceneVersion,
      iv: b64(iv),
      ciphertext: b64(ciphertext),
    }),
  });
  check("create scene -> 200", res.status === 200, `got ${res.status}`);
  const { etag } = await res.json();
  check("etag returned", typeof etag === "string" && etag.length > 0);

  // GET + decrypt
  res = await fetch(api(`/scenes/${ROOM_ID}`));
  check("load scene -> 200", res.status === 200, `got ${res.status}`);
  const stored = await res.json();
  check("sceneVersion preserved", stored.sceneVersion === sceneVersion);
  check("etag matches", stored.etag === etag);
  const decrypted = await decrypt(key, unb64(stored.iv), unb64(stored.ciphertext));
  const loaded = JSON.parse(new TextDecoder().decode(decrypted));
  check(
    "elements roundtrip intact",
    loaded.length === 2 && loaded[0].id === "el1" && loaded[1].id === "el2",
  );
}

// 2. file roundtrip (deflate + encrypt, as the official compressData does)
console.log("== file roundtrip (deflate + AES-GCM) ==");
{
  const key = await generateRoomKey();
  const dataURL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
  const metadata = JSON.stringify({ id: FILE_ID, mimeType: "image/png", created: 123 });
  const payload = Buffer.concat([
    Buffer.from(metadata),
    Buffer.from(dataURL),
  ]);
  const compressed = deflateSync(payload);
  const { iv, ciphertext } = await encrypt(key, compressed);

  let res = await fetch(api(`/files/rooms/${ROOM_ID}/${FILE_ID}`), {
    method: "PUT",
    body: ciphertext,
  });
  check("upload file -> 200", res.status === 200, `got ${res.status}`);

  res = await fetch(api(`/files/rooms/${ROOM_ID}/${FILE_ID}`));
  check("download file -> 200", res.status === 200, `got ${res.status}`);
  check(
    "cache-control 1 year",
    res.headers.get("cache-control") === "public, max-age=31536000",
    `got ${res.headers.get("cache-control")}`,
  );
  const bytes = new Uint8Array(await res.arrayBuffer());
  const decrypted = await decrypt(key, iv, bytes);
  const inflated = inflateSync(decrypted);
  const text = inflated.toString("utf8");
  check(
    "file bytes roundtrip intact",
    text === `${metadata}${dataURL}`,
    "content mismatch",
  );
}

// 3. optimistic concurrency (two clients, one base)
console.log("== concurrent scene save (CAS) ==");
{
  const key = await generateRoomKey();

  // client A saves base version
  const baseElements = [{ id: "base", version: 1 }];
  const enc = await encrypt(
    key,
    new TextEncoder().encode(JSON.stringify(baseElements)),
  );
  let res = await fetch(api(`/scenes/${ROOM_ID2}`), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sceneVersion: 1,
      iv: b64(enc.iv),
      ciphertext: b64(enc.ciphertext),
    }),
  });
  check("A creates base -> 200", res.status === 200, `got ${res.status}`);
  const { etag: etagBase } = await res.json();

  // both clients read the same base
  res = await fetch(api(`/scenes/${ROOM_ID2}`));
  const baseDoc = await res.json();

  // A saves first (with etag)
  const aElements = [{ id: "base", version: 1 }, { id: "fromA", version: 2 }];
  const encA = await encrypt(key, new TextEncoder().encode(JSON.stringify(aElements)));
  res = await fetch(api(`/scenes/${ROOM_ID2}`), {
    method: "PUT",
    headers: { "Content-Type": "application/json", "If-Match": baseDoc.etag },
    body: JSON.stringify({
      sceneVersion: 2,
      iv: b64(encA.iv),
      ciphertext: b64(encA.ciphertext),
    }),
  });
  check("A saves with etag -> 200", res.status === 200, `got ${res.status}`);

  // B tries with the STALE etag -> must get 409
  const bElements = [{ id: "base", version: 1 }, { id: "fromB", version: 2 }];
  const encB = await encrypt(key, new TextEncoder().encode(JSON.stringify(bElements)));
  res = await fetch(api(`/scenes/${ROOM_ID2}`), {
    method: "PUT",
    headers: { "Content-Type": "application/json", "If-Match": baseDoc.etag },
    body: JSON.stringify({
      sceneVersion: 2,
      iv: b64(encB.iv),
      ciphertext: b64(encB.ciphertext),
    }),
  });
  check("B stale etag -> 409", res.status === 409, `got ${res.status}`);

  // B re-reads (fresh etag), reconciles (keeps both edits), retries -> 200
  res = await fetch(api(`/scenes/${ROOM_ID2}`));
  const fresh = await res.json();
  const freshElements = JSON.parse(
    new TextDecoder().decode(await decrypt(key, unb64(fresh.iv), unb64(fresh.ciphertext))),
  );
  const merged = [...freshElements, { id: "fromB", version: 2 }];
  const encMerged = await encrypt(key, new TextEncoder().encode(JSON.stringify(merged)));
  res = await fetch(api(`/scenes/${ROOM_ID2}`), {
    method: "PUT",
    headers: { "Content-Type": "application/json", "If-Match": fresh.etag },
    body: JSON.stringify({
      sceneVersion: 3,
      iv: b64(encMerged.iv),
      ciphertext: b64(encMerged.ciphertext),
    }),
  });
  check("B retry with fresh etag -> 200", res.status === 200, `got ${res.status}`);

  // final state contains both edits
  res = await fetch(api(`/scenes/${ROOM_ID2}`));
  const finalDoc = await res.json();
  const finalElements = JSON.parse(
    new TextDecoder().decode(await decrypt(key, unb64(finalDoc.iv), unb64(finalDoc.ciphertext))),
  );
  const ids = finalElements.map((e) => e.id).sort();
  check("merged scene has both edits", JSON.stringify(ids) === JSON.stringify(["base", "fromA", "fromB"]), `got ${ids}`);
}

console.log("");
console.log(`storage-e2e: ${passed} passed, ${failed} failed`);
// natural exit (exitCode) so undici keep-alive sockets close cleanly on Windows
process.exitCode = failed ? 1 : 0;
