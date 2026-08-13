/**
 * HTTP storage backend (self-hosted).
 *
 * Talks to the self-hosted storage service (see docker/storage in this repo):
 *   GET/PUT /api/v2/scenes/{roomId}
 *   GET/PUT /api/v2/files/{kind}/{ownerId}/{fileId}
 * with ETag/If-Match optimistic concurrency for scenes.
 */
import type { StorageBackend, StoredScene, StoredSceneWithEtag } from "./types";

const b64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
};

const bytesToB64 = (bytes: Uint8Array): string => {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
};

/**
 * Parse a firebase-style storage prefix into { kind, ownerId }.
 *   "files/rooms/{roomId}"        -> { kind: "rooms", ownerId: roomId }
 *   "/files/shareLinks/{id}"      -> { kind: "shareLinks", ownerId: id }
 * Returns null for malformed prefixes.
 */
export const parsePrefix = (
  prefix: string,
): { kind: "rooms" | "shareLinks"; ownerId: string } | null => {
  const parts = prefix.replace(/^\/+/, "").split("/");
  if (parts.length !== 3 || parts[0] !== "files") {
    return null;
  }
  const [, kind, ownerId] = parts;
  if (kind !== "rooms" && kind !== "shareLinks") {
    return null;
  }
  if (!ownerId) {
    return null;
  }
  return { kind, ownerId };
};

export class HttpStorageBackend implements StorageBackend {
  constructor(private readonly baseUrl: string) {}

  private url(path: string): string {
    return `${this.baseUrl}/api/v2${path}`;
  }

  async getScene(roomId: string): Promise<StoredSceneWithEtag | null> {
    const res = await fetch(this.url(`/scenes/${roomId}`));
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      throw new Error(`storage: getScene failed (${res.status})`);
    }
    const data = await res.json();
    return {
      sceneVersion: data.sceneVersion,
      iv: b64ToBytes(data.iv),
      ciphertext: b64ToBytes(data.ciphertext),
      etag: data.etag,
    };
  }

  async putScene(
    roomId: string,
    scene: StoredScene,
    expectedEtag: string | null,
  ): Promise<{ ok: true; etag: string } | { ok: false; conflict: true }> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (expectedEtag !== null) {
      headers["If-Match"] = expectedEtag;
    }
    const res = await fetch(this.url(`/scenes/${roomId}`), {
      method: "PUT",
      headers,
      body: JSON.stringify({
        sceneVersion: scene.sceneVersion,
        iv: bytesToB64(scene.iv),
        ciphertext: bytesToB64(scene.ciphertext),
      }),
    });
    if (res.status === 409) {
      return { ok: false, conflict: true };
    }
    if (!res.ok) {
      throw new Error(`storage: putScene failed (${res.status})`);
    }
    const data = await res.json();
    return { ok: true, etag: data.etag };
  }

  async saveFiles(
    prefix: string,
    files: { id: string; buffer: Uint8Array }[],
  ): Promise<{ savedFiles: string[]; erroredFiles: string[] }> {
    const parsed = parsePrefix(prefix);
    if (!parsed) {
      throw new Error(`storage: invalid file prefix "${prefix}"`);
    }
    const { kind, ownerId } = parsed;
    const savedFiles: string[] = [];
    const erroredFiles: string[] = [];

    await Promise.all(
      files.map(async ({ id, buffer }) => {
        try {
          // defensive check: the official pipeline (FileManager.encodeFilesForUpload
          // -> compressData) always produces a concatBuffers payload starting with
          // version chunk 00 00 00 01. A bare iv+ciphertext blob here means the
          // remote client will fail to decode it — log loudly instead of silently
          // persisting broken data.
          const isCompressData =
            buffer.byteLength >= 4 &&
            buffer[0] === 0 &&
            buffer[1] === 0 &&
            buffer[2] === 0 &&
            buffer[3] === 1;
          if (!isCompressData) {
            console.error(
              `[storage] WARNING: file ${id} is NOT compressData format ` +
                `(${buffer.byteLength}B, first bytes ${Array.from(
                  buffer.slice(0, 4),
                ).join(",")}) — remote clients will fail to decode it`,
            );
          }
          const res = await fetch(this.url(`/files/${kind}/${ownerId}/${id}`), {
            method: "PUT",
            // slice() copies into a fresh ArrayBuffer (typed-array generics)
            body: buffer.slice().buffer,
          });
          if (res.ok) {
            savedFiles.push(id);
          } else {
            erroredFiles.push(id);
          }
        } catch (error) {
          console.error(error);
          erroredFiles.push(id);
        }
      }),
    );

    return { savedFiles, erroredFiles };
  }

  async loadFiles(
    prefix: string,
    fileIds: readonly string[],
  ): Promise<{ loadedFiles: { id: string; buffer: Uint8Array }[]; erroredFiles: string[] }> {
    const parsed = parsePrefix(prefix);
    if (!parsed) {
      throw new Error(`storage: invalid file prefix "${prefix}"`);
    }
    const { kind, ownerId } = parsed;
    const loadedFiles: { id: string; buffer: Uint8Array }[] = [];
    const erroredFiles: string[] = [];

    await Promise.all(
      [...new Set(fileIds)].map(async (id) => {
        try {
          const url = this.url(`/files/${kind}/${ownerId}/${id}`);
          const res = await fetch(url);
          if (res.ok) {
            const buffer = new Uint8Array(await res.arrayBuffer());
            loadedFiles.push({ id, buffer });
            console.debug(
              `[storage] GET ${url} -> 200, ${buffer.byteLength} bytes`,
            );
          } else {
            console.warn(
              `[storage] GET ${url} -> ${res.status} (${res.statusText})`,
            );
            erroredFiles.push(id);
          }
        } catch (error) {
          console.error(`[storage] GET failed for ${id}`, error);
          erroredFiles.push(id);
        }
      }),
    );

    return { loadedFiles, erroredFiles };
  }
}
