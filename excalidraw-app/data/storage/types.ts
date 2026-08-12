/**
 * Storage backend abstraction for the collaboration layer.
 *
 * The official implementation talks to Firebase (Firestore + Storage). For
 * self-hosting we swap in an HTTP backend with the same wire semantics
 * (ciphertext-only: the server never sees plaintext). Keep this interface
 * small so the official business logic (encryption, reconcile, caching) in
 * `firebase.ts` stays untouched.
 */

export type StoredScene = {
  sceneVersion: number;
  iv: Uint8Array;
  ciphertext: Uint8Array;
};

export type StoredSceneWithEtag = StoredScene & { etag: string };

export type PutSceneResult = { ok: true; etag: string } | { ok: false; conflict: true };

export type SaveFilesResult = {
  savedFiles: string[];
  erroredFiles: string[];
};

export type LoadFilesResult = {
  loadedFiles: { id: string; buffer: Uint8Array }[];
  erroredFiles: string[];
};

export interface StorageBackend {
  /** Returns null when no scene exists for the room. */
  getScene(roomId: string): Promise<StoredSceneWithEtag | null>;
  /**
   * Optimistic concurrency: pass `expectedEtag` (from a previous getScene) or
   * null for create-only semantics. A conflict must not write anything.
   */
  putScene(
    roomId: string,
    scene: StoredScene,
    expectedEtag: string | null,
  ): Promise<PutSceneResult>;
  /** Upload ciphertext files. `prefix` is firebase-style ("files/rooms/{roomId}"). */
  saveFiles(prefix: string, files: { id: string; buffer: Uint8Array }[]): Promise<SaveFilesResult>;
  loadFiles(prefix: string, fileIds: readonly string[]): Promise<LoadFilesResult>;
}
