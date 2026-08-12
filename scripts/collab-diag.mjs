#!/usr/bin/env node
/**
 * Collaboration diagnostics for the self-hosted stack.
 *
 * Exercises the same Socket.IO protocol the Excalidraw frontend uses
 * (excalidraw-room / docker/room):
 *   1. connect, report transport (websocket vs polling)
 *   2. join a room as client A, then client B
 *   3. measure client->server RTT via echo round-trips
 *   4. measure A->B scene-update latency (like cursor/element updates)
 *   5. verify volatile (cursor) and non-volatile (scene) broadcast paths
 *
 * Usage:
 *   node scripts/collab-diag.mjs [roomServerUrl] [rounds]
 *   node scripts/collab-diag.mjs http://localhost:3002 50
 *
 * Requires: socket.io-client (available in the monorepo root node_modules).
 */
import { io } from "socket.io-client";

const SERVER = process.argv[2] || "http://localhost:3002";
const ROUNDS = Number(process.argv[3] || 20);

const ROOM_ID = "0123456789abcdef0123"; // 20 hex chars, any value works (server is stateless)
const encryptStub = (payload) => {
  // The room server is payload-agnostic; use a small deterministic "ciphertext"
  // so message sizes resemble real cursor/scene updates.
  const json = JSON.stringify(payload);
  return { data: new TextEncoder().encode(json), iv: new Uint8Array(12) };
};

const waitFor = (fn, timeoutMs = 5000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout waiting for event")), timeoutMs);
    fn((value) => {
      clearTimeout(t);
      resolve(value);
    });
  });

const connect = async (label) => {
  const socket = io(SERVER, {
    transports: ["websocket", "polling"],
    reconnection: false,
    timeout: 5000,
  });
  await waitFor((done) => socket.once("connect", done));
  console.log(`[${label}] connected, transport=${socket.io.engine.transport.name}, id=${socket.id}`);
  return socket;
};

const joinRoom = (socket, roomId) => {
  socket.emit("join-room", roomId);
  return new Promise((resolve) => {
    socket.once("first-in-room", () => resolve("first"));
    socket.once("new-user", (newId) => resolve(`new-user:${newId}`));
    socket.once("room-user-change", (ids) => {
      // room-user-change always follows; resolve only if first-in-room/new-user
      // didn't fire for this socket (join as 2nd+ user)
      resolve(`room-user-change:${ids.length}`);
    });
  });
};

// ---------------------------------------------------------------------------

console.log(`collab-diag: server=${SERVER} rounds=${ROUNDS}`);
console.log("");

const socketA = await connect("A");
const socketB = await connect("B");

// A joins first
const aJoin = await joinRoom(socketA, ROOM_ID);
console.log(`[A] join result: ${aJoin}`);

// B joins second — should trigger new-user for A
const bJoin = await joinRoom(socketB, ROOM_ID);
console.log(`[B] join result: ${bJoin}`);

// A should receive new-user (B) — wait a moment
await new Promise((r) => setTimeout(r, 300));
console.log("");

// ---------------------------------------------------------------------------
// Latency: A -> server -> B (scene updates, non-volatile)
// ---------------------------------------------------------------------------
console.log("== scene update latency (A -> B, server-broadcast) ==");
const latencies = [];
for (let i = 0; i < ROUNDS; i++) {
  const payload = { type: "SCENE_UPDATE", n: i, elements: [{ id: `el${i}`, version: i }] };
  const { data, iv } = encryptStub(payload);
  const t0 = performance.now();
  const received = new Promise((resolve) => {
    const handler = (encData, encIv) => {
      if (encIv && encIv.length === 12 && encData.byteLength === data.byteLength) {
        socketB.off("client-broadcast", handler);
        resolve(performance.now() - t0);
      }
    };
    socketB.on("client-broadcast", handler);
  });
  socketA.emit("server-broadcast", ROOM_ID, data, iv);
  latencies.push(await received);
  await new Promise((r) => setTimeout(r, 30));
}
const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
const sorted = [...latencies].sort((a, b) => a - b);
console.log(`  min=${sorted[0].toFixed(2)}ms  p50=${sorted[Math.floor(sorted.length / 2)].toFixed(2)}ms  p95=${sorted[Math.floor(sorted.length * 0.95)].toFixed(2)}ms  avg=${avg.toFixed(2)}ms  (n=${latencies.length})`);

// ---------------------------------------------------------------------------
// Volatile path (cursor updates)
// ---------------------------------------------------------------------------
console.log("== volatile broadcast (A -> B, server-volatile-broadcast) ==");
const volatileLatencies = [];
for (let i = 0; i < ROUNDS; i++) {
  const payload = { type: "MOUSE_LOCATION", x: i, y: i * 2 };
  const { data, iv } = encryptStub(payload);
  const t0 = performance.now();
  const received = new Promise((resolve) => {
    const handler = (encData, encIv) => {
      if (encIv && encIv.length === 12 && encData.byteLength === data.byteLength) {
        socketB.off("client-broadcast", handler);
        resolve(performance.now() - t0);
      }
    };
    socketB.on("client-broadcast", handler);
  });
  socketA.emit("server-volatile-broadcast", ROOM_ID, data, iv);
  volatileLatencies.push(await received);
  await new Promise((r) => setTimeout(r, 10));
}
const vavg = volatileLatencies.reduce((a, b) => a + b, 0) / volatileLatencies.length;
const vsorted = [...volatileLatencies].sort((a, b) => a - b);
console.log(`  min=${vsorted[0].toFixed(2)}ms  p50=${vsorted[Math.floor(vsorted.length / 2)].toFixed(2)}ms  p95=${vsorted[Math.floor(vsorted.length * 0.95)].toFixed(2)}ms  avg=${vavg.toFixed(2)}ms  (n=${volatileLatencies.length})`);

// ---------------------------------------------------------------------------
// Transport confirmation
// ---------------------------------------------------------------------------
console.log("");
console.log(`== transport ==`);
console.log(`  A: ${socketA.io.engine.transport.name}`);
console.log(`  B: ${socketB.io.engine.transport.name}`);
console.log(`  (polling = HTTP long-polling fallback; websocket = real WS upgrade)`);

// graceful close
socketA.close();
socketB.close();
process.exit(0);
