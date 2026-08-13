// Zero-dependency HTTP server for the self-hosted Excalidraw storage backend.
//
// Endpoints (mirror the official Firebase storage semantics, ciphertext only):
//   GET  /health
//   GET  /api/v2/scenes/:roomId                 -> 200 {sceneVersion, iv(b64), ciphertext(b64), etag} | 404
//   PUT  /api/v2/scenes/:roomId                 -> body {sceneVersion, iv(b64), ciphertext(b64)}
//                                                + If-Match: <etag> (optional; absent = create-only)
//                                                200 {etag} | 409 | 413 | 400
//   GET  /api/v2/files/:kind/:ownerId/:fileId   -> 200 binary + Cache-Control: public, max-age=31536000 | 404
//   PUT  /api/v2/files/:kind/:ownerId/:fileId   -> body raw ciphertext bytes | 200 | 413 | 400
//
// Security notes:
//   - All ids validated against strict regexes; paths are server-assembled.
//   - Server never sees plaintext (scenes/files are client-encrypted).
//   - Logs never contain bodies.
import http from "node:http";
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  renameSync,
  mkdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { Store, ensureDataDir } from "./db.js";
import {
  fileRelPath,
  isRoomId,
  isFileId,
  isValidKind,
  isManageTokenHash,
  isKdfVersion,
  isKdfIterations,
  isRoomName,
} from "./validate.js";

const DATA_DIR = process.env.DATA_DIR || "./data";
const PORT = Number(process.env.PORT || 8080);

// Must match the self-hosted frontend default. Compose/runtime configuration
// can override both sides with MAX_FILE_UPLOAD_BYTES / MAX_BODY_BYTES.
const DEFAULT_MAX_BODY_BYTES = 20 * 1024 * 1024;
const CACHE_MAX_AGE = "public, max-age=31536000"; // 1 year, mirrors FILE_CACHE_MAX_AGE_SEC

const sendJson = (res, status, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
};

const sendError = (res, status, message) => sendJson(res, status, { error: message });

const readBody = (req, maxBodyBytes) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes && !rejected) {
        rejected = true;
        req.pause();
        reject(Object.assign(new Error("payload too large"), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

const b64 = (buf) => Buffer.from(buf).toString("base64");
const unb64 = (str) => {
  if (typeof str !== "string") {
    return null;
  }
  // Strict roundtrip check: reject strings that only partially decode
  // (e.g. "!!!not-base64" or a missing "=" padding), not just garbage input.
  let buf;
  try {
    buf = Buffer.from(str, "base64");
  } catch {
    return null;
  }
  if (buf.length === 0 || buf.toString("base64") !== str) {
    return null;
  }
  return buf;
};

export function createApp({ dataDir = DATA_DIR, maxBodyBytes = DEFAULT_MAX_BODY_BYTES, log = true } = {}) {
  const dir = ensureDataDir(dataDir);
  const store = new Store(path.join(dir, "storage.sqlite"));
  const filePathFor = (relPath) => path.join(dir, "files", ...relPath.split("/"));

  const server = http.createServer(async (req, res) => {
    const start = Date.now();
    const method = req.method;
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    // CORS: content is client-encrypted and there are no credentials, so a
    // permissive policy is acceptable and required for cross-origin dev setups
    // (the default same-origin deployment never triggers CORS).
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, PUT, PATCH, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, If-Match");

    if (method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    try {
      // liveness probe, reachable both directly and through the nginx /api/v2/ prefix
      if (pathname === "/health" || pathname === "/api/v2/health") {
        if (method !== "GET") {
          return sendError(res, 405, "method not allowed");
        }
        return sendJson(res, 200, {
          status: "ok",
          db: store.integrityOk() ? "ok" : "corrupt",
          stats: store.stats(),
        });
      }

      const sceneMatch = pathname.match(/^\/api\/v2\/scenes\/([^/]+)$/);
      if (sceneMatch) {
        return await handleScenes(req, res, store, sceneMatch[1], method, maxBodyBytes);
      }

      const fileMatch = pathname.match(/^\/api\/v2\/files\/([^/]+)\/([^/]+)\/([^/]+)$/);
      if (fileMatch) {
        return await handleFiles(req, res, store, fileMatch[1], fileMatch[2], fileMatch[3], method, maxBodyBytes, filePathFor);
      }

      // Lobby Registry
      if (pathname === "/api/v2/rooms") {
        return await handleLobbyCollection(req, res, store, method, maxBodyBytes);
      }
      const roomOpenMatch = pathname.match(/^\/api\/v2\/rooms\/([^/]+)\/open$/);
      if (roomOpenMatch) {
        return await handleLobbyRoomOpen(req, res, store, roomOpenMatch[1], method);
      }
      const roomMatch = pathname.match(/^\/api\/v2\/rooms\/([^/]+)$/);
      if (roomMatch) {
        return await handleLobbyRoom(req, res, store, roomMatch[1], method, maxBodyBytes);
      }

      return sendError(res, 404, "not found");
    } catch (err) {
      const status = err && err.status ? err.status : 500;
      if (!res.headersSent) {
        sendError(res, status, status === 413 ? "payload too large" : "internal error");
      }
      req.destroy();
      return undefined;
    } finally {
      if (log) {
        const ms = Date.now() - start;
        console.log(`${method} ${pathname} ${res.statusCode} ${ms}ms`);
      }
    }
  });

  return { server, store };
}
async function handleScenes(req, res, store, roomId, method, maxBodyBytes) {
  if (!isRoomId(roomId)) {
    return sendError(res, 400, "invalid roomId");
  }
  if (method === "GET") {
    const scene = store.getScene(roomId);
    if (!scene) {
      return sendError(res, 404, "scene not found");
    }
    return sendJson(res, 200, {
      sceneVersion: scene.scene_version,
      iv: b64(scene.iv),
      ciphertext: b64(scene.ciphertext),
      etag: `${scene.scene_version}-${scene.updated_at}`,
    });
  }
  if (method === "PUT") {
    const raw = await readBody(req, maxBodyBytes);
    let payload;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      return sendError(res, 400, "invalid JSON body");
    }
    const sceneVersion = payload.sceneVersion;
    const iv = unb64(payload.iv);
    const ciphertext = unb64(payload.ciphertext);
    if (
      !Number.isInteger(sceneVersion) ||
      sceneVersion < 0 ||
      !iv ||
      iv.length !== 12 ||
      !ciphertext ||
      ciphertext.length === 0
    ) {
      return sendError(res, 400, "invalid scene payload (sceneVersion, iv, ciphertext required)");
    }
    const ifMatch = req.headers["if-match"];
    const expectedEtag = ifMatch === undefined || ifMatch === "*" ? null : ifMatch;
    const result = store.putScene(roomId, sceneVersion, iv, ciphertext, expectedEtag);
    if (!result.ok) {
      return sendError(res, 409, "scene version conflict");
    }
    return sendJson(res, 200, { etag: result.etag });
  }
  return sendError(res, 405, "method not allowed");
}

async function handleFiles(req, res, store, kind, ownerId, fileId, method, maxBodyBytes, filePathFor) {
  if (!isValidKind(kind) || !isFileId(fileId)) {
    return sendError(res, 400, "invalid file path");
  }
  const relPath = fileRelPath(kind, ownerId, fileId);
  if (!relPath) {
    return sendError(res, 400, "invalid owner id");
  }
  const absPath = filePathFor(relPath);

  if (method === "GET") {
    if (!existsSync(absPath)) {
      return sendError(res, 404, "file not found");
    }
    const size = statSync(absPath).size;
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": size,
      "Cache-Control": CACHE_MAX_AGE,
    });
    await pipeline(createReadStream(absPath), res).catch(() => {});
    return undefined;
  }
  if (method === "PUT") {
    // Atomic write: tmp file in same directory, then rename.
    const dir = path.dirname(absPath);
    mkdirSync(dir, { recursive: true });
    const tmpPath = `${absPath}.tmp-${process.pid}-${Date.now()}`;
    const out = createWriteStream(tmpPath);

    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes && !tooLarge) {
        tooLarge = true;
        // stop writing; pipeline() below will reject, we then answer 413
        out.destroy();
      }
    });

    try {
      await pipeline(req, out);
    } catch (err) {
      try {
        unlinkSync(tmpPath);
      } catch {}
      if (tooLarge) {
        const sent = sendError(res, 413, "payload too large");
        req.destroy();
        return sent;
      }
      return sendError(res, 500, "write failed");
    }

    renameSync(tmpPath, absPath);
    store.upsertFileMeta(kind, ownerId, fileId, size);

    return sendJson(res, 200, { ok: true, size });
  }
  return sendError(res, 405, "method not allowed");
}

// -----------------------------------------------------------------------------
// Lobby Registry
// -----------------------------------------------------------------------------
//
// The lobby is a permanent room directory. Rooms are created by clients that
// already own a roomKey; the server only stores key material wrapped with a
// key derived from the lobby password (PBKDF2-SHA256 + AES-GCM), plus a
// SHA-256 hash of the manage token. Password verification is implicit: the
// client unwraps the roomKey locally and the operation either succeeds (correct
// password) or fails (wrong password). The server can never recover a roomKey.
//
//   POST /api/v2/rooms            create lobby room (client-generated roomId)
//   GET  /api/v2/rooms            list (public metadata only)
//   GET  /api/v2/rooms/:roomId    room details incl. wrapped key material
//   POST /api/v2/rooms/:roomId/open  report a successful join (updates lastOpenedAt)
//   PATCH /api/v2/rooms/:roomId   owner-only update (manageToken verified)

const serializeLobbyRoom = (room) => ({
  roomId: room.roomId,
  name: room.name,
  createdAt: room.createdAt,
  lastOpenedAt: room.lastOpenedAt,
  hasPassword: !!room.hasPassword,
  wrappedRoomKey: b64(room.wrappedRoomKey),
  passwordSalt: b64(room.passwordSalt),
  passwordIv: b64(room.passwordIv),
  kdfVersion: room.kdfVersion,
  kdfIterations: room.kdfIterations,
});

async function handleLobbyCollection(req, res, store, method, maxBodyBytes) {
  if (method === "GET") {
    const rooms = store.listLobbyRooms().map((room) => ({
      roomId: room.roomId,
      name: room.name,
      createdAt: room.createdAt,
      lastOpenedAt: room.lastOpenedAt,
      hasPassword: !!room.hasPassword,
    }));
    return sendJson(res, 200, { rooms });
  }

  if (method === "POST") {
    const raw = await readBody(req, maxBodyBytes);
    let payload;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      return sendError(res, 400, "invalid JSON body");
    }

    const roomId = payload.roomId;
    const wrappedRoomKey = unb64(payload.wrappedRoomKey);
    const passwordSalt = unb64(payload.passwordSalt);
    const passwordIv = unb64(payload.passwordIv);
    const kdfVersion = payload.kdfVersion;
    const kdfIterations = payload.kdfIterations;
    const manageTokenHash = payload.manageTokenHash;

    if (!isRoomId(roomId)) {
      return sendError(res, 400, "invalid roomId");
    }
    if (!isRoomName(payload.name)) {
      return sendError(res, 400, "invalid name");
    }
    if (!wrappedRoomKey || wrappedRoomKey.length === 0 || wrappedRoomKey.length > 1024) {
      return sendError(res, 400, "invalid wrappedRoomKey");
    }
    if (!passwordSalt || passwordSalt.length < 8 || passwordSalt.length > 128) {
      return sendError(res, 400, "invalid passwordSalt");
    }
    if (!passwordIv || passwordIv.length !== 12) {
      return sendError(res, 400, "invalid passwordIv");
    }
    if (!isKdfVersion(kdfVersion)) {
      return sendError(res, 400, "unsupported kdfVersion");
    }
    if (!isKdfIterations(kdfIterations)) {
      return sendError(res, 400, "invalid kdfIterations");
    }
    if (!isManageTokenHash(manageTokenHash)) {
      return sendError(res, 400, "invalid manageTokenHash");
    }

    const result = store.createLobbyRoom({
      roomId,
      name: payload.name.trim(),
      wrappedRoomKey,
      passwordSalt,
      passwordIv,
      kdfVersion,
      kdfIterations,
      manageTokenHash,
      hasPassword: payload.hasPassword !== false,
    });
    if (!result.ok) {
      return sendError(res, 409, "room already registered");
    }
    return sendJson(res, 200, { roomId });
  }

  return sendError(res, 405, "method not allowed");
}

async function handleLobbyRoom(req, res, store, roomId, method, maxBodyBytes) {
  // `presence` and other non-room paths under /api/v2/rooms/ are served by
  // the room service; this backend only knows real 20-hex room ids.
  if (!isRoomId(roomId)) {
    return sendError(res, 404, "not found");
  }

  if (method === "GET") {
    const room = store.getLobbyRoom(roomId);
    if (!room) {
      return sendError(res, 404, "room not found");
    }
    return sendJson(res, 200, serializeLobbyRoom(room));
  }

  if (method === "PATCH") {
    const raw = await readBody(req, maxBodyBytes);
    let payload;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      return sendError(res, 400, "invalid JSON body");
    }

    // Owner verification: the SHA-256 hash of the presented manage token must
    // match the stored hash. The token itself is never stored.
    const manageToken = payload.manageToken;
    if (typeof manageToken !== "string" || !/^[a-f0-9]{16,128}$/.test(manageToken)) {
      return sendError(res, 400, "invalid manageToken");
    }
    const room = store.getLobbyRoom(roomId);
    if (!room) {
      return sendError(res, 404, "room not found");
    }
    const presentedHash = createHash("sha256").update(manageToken, "utf8").digest("hex");
    if (presentedHash !== room.manageTokenHash) {
      return sendError(res, 403, "invalid manage token");
    }

    const fields = {};
    if (payload.name !== undefined) {
      if (!isRoomName(payload.name)) {
        return sendError(res, 400, "invalid name");
      }
      fields.name = payload.name.trim();
    }

    // Password rotation: the client re-wraps the roomKey with a KEK derived
    // from the new password, so all key-material fields must come together.
    const hasKeyMaterial =
      payload.wrappedRoomKey !== undefined ||
      payload.passwordSalt !== undefined ||
      payload.passwordIv !== undefined ||
      payload.kdfVersion !== undefined ||
      payload.kdfIterations !== undefined;
    if (hasKeyMaterial) {
      const wrappedRoomKey = unb64(payload.wrappedRoomKey);
      const passwordSalt = unb64(payload.passwordSalt);
      const passwordIv = unb64(payload.passwordIv);
      const kdfVersion = payload.kdfVersion;
      const kdfIterations = payload.kdfIterations;
      if (!wrappedRoomKey || wrappedRoomKey.length === 0 || wrappedRoomKey.length > 1024) {
        return sendError(res, 400, "invalid wrappedRoomKey");
      }
      if (!passwordSalt || passwordSalt.length < 8 || passwordSalt.length > 128) {
        return sendError(res, 400, "invalid passwordSalt");
      }
      if (!passwordIv || passwordIv.length !== 12) {
        return sendError(res, 400, "invalid passwordIv");
      }
      if (!isKdfVersion(kdfVersion)) {
        return sendError(res, 400, "unsupported kdfVersion");
      }
      if (!isKdfIterations(kdfIterations)) {
        return sendError(res, 400, "invalid kdfIterations");
      }
      fields.wrappedRoomKey = wrappedRoomKey;
      fields.passwordSalt = passwordSalt;
      fields.passwordIv = passwordIv;
      fields.kdfVersion = kdfVersion;
      fields.kdfIterations = kdfIterations;
      fields.hasPassword = payload.hasPassword !== false;
    } else if (payload.hasPassword !== undefined) {
      fields.hasPassword = payload.hasPassword !== false;
    }

    if (Object.keys(fields).length === 0) {
      return sendError(res, 400, "nothing to update");
    }
    store.updateLobbyRoom(roomId, fields);
    return sendJson(res, 200, { ok: true });
  }

  return sendError(res, 405, "method not allowed");
}

async function handleLobbyRoomOpen(req, res, store, roomId, method) {
  if (!isRoomId(roomId)) {
    return sendError(res, 404, "not found");
  }
  if (method !== "POST") {
    return sendError(res, 405, "method not allowed");
  }
  // Successful-join report. lastOpenedAt is a pure sort signal (the server
  // cannot verify a password it never stored), so no credentials are needed.
  if (!store.touchLobbyRoom(roomId)) {
    return sendError(res, 404, "room not found");
  }
  return sendJson(res, 200, { ok: true });
}

// CLI entry: `node src/server.js`
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  const maxBodyBytes = Number(process.env.MAX_BODY_BYTES || DEFAULT_MAX_BODY_BYTES);
  const { server } = createApp({ dataDir: DATA_DIR, maxBodyBytes });
  server.listen(PORT, () => {
    console.log(`excalidraw storage listening on :${PORT} (data dir: ${DATA_DIR})`);
  });
}
