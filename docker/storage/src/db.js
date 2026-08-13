// SQLite layer (node:sqlite, zero deps). WAL mode, single writer.
// Tables:
//   scenes(room_id PK, scene_version, iv, ciphertext, created_at, updated_at)
//   files(kind, owner_id, file_id, size, created_at, updated_at)  -- metadata only;
//         the ciphertext lives on the filesystem under DATA_DIR/files/<relPath>.
//   lobby_rooms(room_id PK, ...)  -- Lobby Registry. Public room metadata plus
//         the wrapped roomKey material. The server NEVER sees the roomKey in
//         plaintext: it only stores the roomKey wrapped with a key derived
//         (PBKDF2-SHA256) from the lobby password. Passwords themselves are
//         never stored; the plaintext roomKey is never stored.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS scenes (
  room_id      TEXT PRIMARY KEY,
  scene_version INTEGER NOT NULL,
  iv           BLOB NOT NULL,
  ciphertext   BLOB NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  kind       TEXT NOT NULL,
  owner_id   TEXT NOT NULL,
  file_id    TEXT NOT NULL,
  size       INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (kind, owner_id, file_id)
);

-- Lobby Registry (self-hosted permanent rooms).
-- Rooms live forever: no TTL, no auto-archive, no deletion endpoint in v1.
-- last_opened_at is a pure sort signal, updated only when a client reports a
-- successful join (POST /api/v2/rooms/:roomId/open).
CREATE TABLE IF NOT EXISTS lobby_rooms (
  room_id           TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  last_opened_at    INTEGER,
  has_password      INTEGER NOT NULL DEFAULT 1,
  wrapped_room_key  BLOB NOT NULL,
  password_salt     BLOB NOT NULL,
  password_iv       BLOB NOT NULL,
  kdf_version       INTEGER NOT NULL,
  kdf_iterations    INTEGER NOT NULL,
  manage_token_hash TEXT NOT NULL,
  updated_at        INTEGER NOT NULL
);
`;

export class Store {
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  getScene(roomId) {
    return this.db
      .prepare("SELECT scene_version, iv, ciphertext, created_at, updated_at FROM scenes WHERE room_id = ?")
      .get(roomId) ?? null;
  }

  /**
   * Atomic compare-and-set for scenes.
   * @param {string} roomId
   * @param {number} sceneVersion
   * @param {Uint8Array} iv
   * @param {Uint8Array} ciphertext
   * @param {string|null} expectedEtag  If non-null, the write succeeds only when the
   *   current row's etag matches (optimistic concurrency). If null, the write
   *   succeeds only when no row exists (create).
   * @returns {{ok: true, etag: string} | {ok: false, status: 409, current: object|null}}
   */
  putScene(roomId, sceneVersion, iv, ciphertext, expectedEtag) {
    const now = Date.now();
    const current = this.getScene(roomId);
    const currentEtag = current ? etagOf(current) : null;

    if (expectedEtag === null) {
      // create-only semantics
      if (current) {
        return { ok: false, status: 409, current };
      }
    } else if (currentEtag !== expectedEtag) {
      return { ok: false, status: 409, current };
    }

    this.db
      .prepare(
        `INSERT INTO scenes (room_id, scene_version, iv, ciphertext, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(room_id) DO UPDATE SET
           scene_version = excluded.scene_version,
           iv = excluded.iv,
           ciphertext = excluded.ciphertext,
           updated_at = excluded.updated_at`,
      )
      .run(roomId, sceneVersion, iv, ciphertext, now, now);

    const stored = this.getScene(roomId);
    return { ok: true, etag: etagOf(stored) };
  }

  upsertFileMeta(kind, ownerId, fileId, size) {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO files (kind, owner_id, file_id, size, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(kind, owner_id, file_id) DO UPDATE SET
           size = excluded.size, updated_at = excluded.updated_at`,
      )
      .run(kind, ownerId, fileId, size, now, now);
  }

  getFileMeta(kind, ownerId, fileId) {
    return (
      this.db
        .prepare(
          "SELECT kind, owner_id, file_id, size, created_at, updated_at FROM files WHERE kind = ? AND owner_id = ? AND file_id = ?",
        )
        .get(kind, ownerId, fileId) ?? null
    );
  }

  deleteFileMeta(kind, ownerId, fileId) {
    this.db
      .prepare("DELETE FROM files WHERE kind = ? AND owner_id = ? AND file_id = ?")
      .run(kind, ownerId, fileId);
  }

  /** Orphaned files: rows whose owner has no scene / share-link entry, older than minAgeMs. */
  listOrphans(minAgeMs) {
    const cutoff = Date.now() - minAgeMs;
    return this.db
      .prepare(
        `SELECT f.kind, f.owner_id, f.file_id FROM files f
         WHERE f.updated_at < ?
           AND NOT EXISTS (
             SELECT 1 FROM scenes s WHERE f.kind = 'rooms' AND s.room_id = f.owner_id
           )`,
      )
      .all(cutoff);
  }

  // ---------------------------------------------------------------------------
  // Lobby Registry
  // ---------------------------------------------------------------------------

  /**
   * @param {{roomId: string, name: string, wrappedRoomKey: Uint8Array,
   *          passwordSalt: Uint8Array, passwordIv: Uint8Array,
   *          kdfVersion: number, kdfIterations: number,
   *          manageTokenHash: string, hasPassword: boolean}} room
   */
  createLobbyRoom(room) {
    const now = Date.now();
    try {
      this.db
        .prepare(
          `INSERT INTO lobby_rooms
             (room_id, name, created_at, last_opened_at, has_password,
              wrapped_room_key, password_salt, password_iv,
              kdf_version, kdf_iterations, manage_token_hash, updated_at)
           VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          room.roomId,
          room.name,
          now,
          room.hasPassword ? 1 : 0,
          room.wrappedRoomKey,
          room.passwordSalt,
          room.passwordIv,
          room.kdfVersion,
          room.kdfIterations,
          room.manageTokenHash,
          now,
        );
      return { ok: true };
    } catch (err) {
      // UNIQUE constraint violation => room already registered
      if (err && err.code === "ERR_SQLITE_ERROR" && /UNIQUE/.test(String(err.message))) {
        return { ok: false, exists: true };
      }
      throw err;
    }
  }

  /** Public list fields only — never the wrapped key material. */
  listLobbyRooms(limit = 500) {
    return this.db
      .prepare(
        `SELECT room_id AS roomId, name, created_at AS createdAt,
                last_opened_at AS lastOpenedAt, has_password AS hasPassword
         FROM lobby_rooms
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(limit);
  }

  getLobbyRoom(roomId) {
    return (
      this.db
        .prepare(
          `SELECT room_id AS roomId, name, created_at AS createdAt,
                  last_opened_at AS lastOpenedAt, has_password AS hasPassword,
                  wrapped_room_key AS wrappedRoomKey,
                  password_salt AS passwordSalt,
                  password_iv AS passwordIv,
                  kdf_version AS kdfVersion,
                  kdf_iterations AS kdfIterations,
                  manage_token_hash AS manageTokenHash
           FROM lobby_rooms WHERE room_id = ?`,
        )
        .get(roomId) ?? null
    );
  }

  /** Record a successful join. Returns false when the room doesn't exist. */
  touchLobbyRoom(roomId, openedAt = Date.now()) {
    const result = this.db
      .prepare("UPDATE lobby_rooms SET last_opened_at = ?, updated_at = ? WHERE room_id = ?")
      .run(openedAt, openedAt, roomId);
    return result.changes > 0;
  }

  /**
   * Owner-only update (rename / password rotation). Only the fields present in
   * `fields` are updated. Key material fields must be updated together when the
   * lobby password changes (new KEK => new wrap).
   * @param {{name?: string, hasPassword?: boolean, wrappedRoomKey?: Uint8Array,
   *          passwordSalt?: Uint8Array, passwordIv?: Uint8Array,
   *          kdfVersion?: number, kdfIterations?: number}} fields
   */
  updateLobbyRoom(roomId, fields) {
    const sets = [];
    const values = [];
    const push = (col, value) => {
      sets.push(`${col} = ?`);
      values.push(value);
    };
    if (fields.name !== undefined) push("name", fields.name);
    if (fields.hasPassword !== undefined) push("has_password", fields.hasPassword ? 1 : 0);
    if (fields.wrappedRoomKey !== undefined) push("wrapped_room_key", fields.wrappedRoomKey);
    if (fields.passwordSalt !== undefined) push("password_salt", fields.passwordSalt);
    if (fields.passwordIv !== undefined) push("password_iv", fields.passwordIv);
    if (fields.kdfVersion !== undefined) push("kdf_version", fields.kdfVersion);
    if (fields.kdfIterations !== undefined) push("kdf_iterations", fields.kdfIterations);
    if (sets.length === 0) {
      return { updated: false, changes: 0 };
    }
    sets.push("updated_at = ?");
    values.push(Date.now());
    values.push(roomId);
    const result = this.db
      .prepare(`UPDATE lobby_rooms SET ${sets.join(", ")} WHERE room_id = ?`)
      .run(...values);
    return { updated: result.changes > 0, changes: result.changes };
  }

  stats() {
    const scenes = this.db.prepare("SELECT COUNT(*) AS n FROM scenes").get().n;
    const files = this.db.prepare("SELECT COUNT(*) AS n FROM files").get().n;
    const lobbyRooms = this.db.prepare("SELECT COUNT(*) AS n FROM lobby_rooms").get().n;
    return { scenes, files, lobbyRooms };
  }

  integrityOk() {
    try {
      const row = this.db.prepare("PRAGMA integrity_check").get();
      return row && row.integrity_check === "ok";
    } catch {
      return false;
    }
  }
}

export const etagOf = (row) => `${row.scene_version}-${row.updated_at}`;

export const ensureDataDir = (dataDir) => {
  mkdirSync(path.join(dataDir, "files"), { recursive: true });
  return dataDir;
};
