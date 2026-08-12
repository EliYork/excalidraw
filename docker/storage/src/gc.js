// Optional garbage collector for orphaned room files.
//
// A room file is orphaned when its owning room has no scene document and the
// file has not been touched for GC_MIN_AGE_MS (default 24h). This mirrors the
// official behavior (files are never deleted automatically) while giving
// deployers a way to reclaim disk space. Share-link files are never collected
// (we cannot know whether a link still references them).
//
// Run periodically: node src/gc.js
import path from "node:path";
import { existsSync, unlinkSync, rmSync } from "node:fs";
import { Store, ensureDataDir } from "./db.js";

const DATA_DIR = process.env.DATA_DIR || "./data";
const MIN_AGE_MS = Number(process.env.GC_MIN_AGE_MS || 24 * 60 * 60 * 1000);

const dataDir = ensureDataDir(DATA_DIR);
const store = new Store(path.join(dataDir, "storage.sqlite"));

const orphans = store.listOrphans(MIN_AGE_MS);
let removed = 0;
let failed = 0;

for (const { kind, owner_id, file_id } of orphans) {
  const absPath = path.join(dataDir, "files", kind, owner_id, file_id);
  try {
    if (existsSync(absPath)) {
      unlinkSync(absPath);
    }
    store.deleteFileMeta(kind, owner_id, file_id);
    removed += 1;
  } catch (err) {
    console.error(`gc: failed to remove ${absPath}: ${err.message}`);
    failed += 1;
  }
}

// clean up empty owner dirs (best effort)
for (const { kind, owner_id } of orphans) {
  try {
    rmSync(path.join(dataDir, "files", kind, owner_id), { recursive: false });
  } catch {}
}

console.log(`gc: removed ${removed} orphaned file(s), ${failed} failed`);
store.close();
