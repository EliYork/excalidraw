// SQLite layer (node:sqlite, zero deps). WAL mode, single writer.
// Tables:
//   scenes(room_id PK, scene_version, iv, ciphertext, created_at, updated_at)
//   files(kind, owner_id, file_id, size, created_at, updated_at)  -- metadata only;
//         the ciphertext lives on the filesystem under DATA_DIR/files/<relPath>.
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

  stats() {
    const scenes = this.db.prepare("SELECT COUNT(*) AS n FROM scenes").get().n;
    const files = this.db.prepare("SELECT COUNT(*) AS n FROM files").get().n;
    return { scenes, files };
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
