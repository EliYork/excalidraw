// @vitest-environment jsdom
/**
 * Image collaboration regression test (no browser needed).
 *
 * Simulates client A uploading an image exactly like the official frontend
 * does (FileManager.encodeFilesForUpload: deflate + AES-GCM via compressData),
 * persists it through the REAL self-hosted storage server (HTTP), then
 * simulates client B downloading and recovering the image exactly like
 * loadFilesFromFirebase does (decompressData + decryptData), asserting the
 * recovered BinaryFileData matches the original.
 *
 * This exercises the full integration layer (adapter -> HTTP -> disk -> HTTP
 * -> adapter) including real crypto, not just "bytes in == bytes out".
 */
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { compressData, decompressData } from "@excalidraw/excalidraw/data/encode";
import { generateEncryptionKey } from "@excalidraw/excalidraw/data/encryption";
import type { FileId } from "@excalidraw/element/types";

import { FileManager } from "../data/FileManager";
import { HttpStorageBackend } from "../data/storage/httpBackend";
import { createApp } from "../../docker/storage/src/server.js";

// inline mirrors of the official types (avoid pulling browser-dependent modules)
type BinaryFileMetadata = {
  id?: string;
  mimeType?: string;
  created?: number;
  lastRetrieved?: number;
};
type BinaryFileData = {
  mimeType: string;
  id: string;
  dataURL: string;
  created: number;
  lastRetrieved: number;
};

// 1x1 red PNG
const ORIGINAL_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const roomId = "abcdef0123456789abcd"; // 20 hex
const fileId = "a".repeat(40); // 40 hex (SHA-1 style)

let dataDir: string;
let baseUrl: string;
let closeServer: () => Promise<void>;

// loadFilesFromFirebase is wired to the module-level storageBackend singleton,
// which reads the runtime config at import time. We re-import it after
// pointing the runtime config at the test server (exactly what config.js does
// in a real deployment).
let loadFilesFromFirebase: typeof import("../data/firebase")["loadFilesFromFirebase"];

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "excal-image-collab-"));
  const { server, store } = createApp({ dataDir, log: false });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("expected TCP address");
  }
  baseUrl = `http://127.0.0.1:${addr.port}`;
  closeServer = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        store.close();
        resolve();
      });
    });

  // simulate config.js: runtime config wins over build-time env
  (window as any).__EXCALIDRAW_RUNTIME_CONFIG__ = { storageBaseUrl: baseUrl };
  vi.resetModules();
  ({ loadFilesFromFirebase } = await import("../data/firebase"));
});

afterAll(async () => {
  await closeServer();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("image collaboration: A upload -> storage -> B recovery", () => {
  it("A uploads, file persists on disk, B downloads and decrypts to the original BinaryFileData", async () => {
    const roomKey = await generateEncryptionKey();
    expect(roomKey).toBeTruthy();

    // ---- client A: encode exactly like FileManager.encodeFilesForUpload ----
    const rawBuffer = new TextEncoder().encode(ORIGINAL_DATA_URL);
    const encodedFile = await compressData<BinaryFileMetadata>(rawBuffer, {
      encryptionKey: roomKey,
      metadata: {
        id: fileId,
        mimeType: "image/png",
        created: 12345,
        lastRetrieved: 12345,
      },
    });

    const backendA = new HttpStorageBackend(baseUrl);
    const { savedFiles, erroredFiles } = await backendA.saveFiles(
      `files/rooms/${roomId}`,
      [{ id: fileId, buffer: encodedFile }],
    );
    expect(erroredFiles).toEqual([]);
    expect(savedFiles).toEqual([fileId]);

    // ---- storage actually persisted the ciphertext file ----
    const diskPath = path.join(dataDir, "files", "rooms", roomId, fileId);
    expect(existsSync(diskPath)).toBe(true);
    expect(statSync(diskPath).size).toBeGreaterThan(0);
    // the stored bytes must be the compressData payload (concatBuffers format:
    // version chunk 4 bytes = CONCAT_BUFFERS_VERSION(1) BE), NOT a bare
    // iv+ciphertext blob and NOT JSON/base64 wrapping
    const onDisk = new Uint8Array(require("node:fs").readFileSync(diskPath));
    expect(onDisk[0]).toBe(0);
    expect(onDisk[1]).toBe(0);
    expect(onDisk[2]).toBe(0);
    expect(onDisk[3]).toBe(1);
    const storedText = new TextDecoder().decode(onDisk.slice(0, 64));
    expect(storedText.startsWith("{")).toBe(false); // not JSON
    expect(storedText.startsWith("data:")).toBe(false); // not raw data URL

    // ---- client B: download + decrypt + decompress (like loadFilesFromFirebase) ----
    const backendB = new HttpStorageBackend(baseUrl);
    const { loadedFiles, erroredFiles: errs } = await backendB.loadFiles(
      `files/rooms/${roomId}`,
      [fileId],
    );
    expect(errs).toEqual([]);
    expect(loadedFiles).toHaveLength(1);
    expect(loadedFiles[0].id).toBe(fileId);

    const { data, metadata } = await decompressData<BinaryFileMetadata>(
      loadedFiles[0].buffer,
      { decryptionKey: roomKey },
    );
    const dataURL = new TextDecoder().decode(data);

    // ---- recovered BinaryFileData matches the original ----
    expect(dataURL).toBe(ORIGINAL_DATA_URL);
    expect(metadata.mimeType).toBe("image/png");
    expect(metadata.id).toBe(fileId);

    const binaryFileData: BinaryFileData = {
      mimeType: metadata.mimeType!,
      id: fileId,
      dataURL,
      created: metadata.created!,
      lastRetrieved: metadata.lastRetrieved!,
    };
    expect(binaryFileData.dataURL).toBe(ORIGINAL_DATA_URL);
    expect(binaryFileData.mimeType).toBe("image/png");
    expect(binaryFileData.id).toBe(fileId);
  });

  it("decryption with a WRONG key fails (proves encryption is really applied)", async () => {
    const keyA = await generateEncryptionKey();
    const keyB = await generateEncryptionKey();
    expect(keyA).not.toBe(keyB);

    const encoded = await compressData(new TextEncoder().encode(ORIGINAL_DATA_URL), {
      encryptionKey: keyA,
      metadata: { id: fileId, mimeType: "image/png", created: 1, lastRetrieved: 1 },
    });
    const backend = new HttpStorageBackend(baseUrl);
    await backend.saveFiles(`files/rooms/${roomId}`, [
      { id: "b".repeat(40), buffer: encoded },
    ]);
    const { loadedFiles } = await backend.loadFiles(`files/rooms/${roomId}`, [
      "b".repeat(40),
    ]);
    await expect(
      decompressData(loadedFiles[0].buffer, { decryptionKey: keyB }),
    ).rejects.toThrow();
  });

  it("client B state machine: FileManager.getFiles through the real collab callbacks recovers the image", async () => {
    // A uploads (real encode pipeline)
    const roomKey = await generateEncryptionKey();
    const fileIdB = "c".repeat(40);
    const encoded = await compressData(new TextEncoder().encode(ORIGINAL_DATA_URL), {
      encryptionKey: roomKey,
      metadata: { id: fileIdB, mimeType: "image/png", created: 99, lastRetrieved: 99 },
    });
    const backend = new HttpStorageBackend(baseUrl);
    const { erroredFiles: uploadErrors } = await backend.saveFiles(
      `files/rooms/${roomId}`,
      [{ id: fileIdB as FileId, buffer: encoded }],
    );
    expect(uploadErrors).toEqual([]);

    // B side: the exact callback Collab.tsx wires into FileManager
    const fileManager = new FileManager({
      onFileStatusChange: () => {},
      getFiles: async (fileIds: FileId[]) =>
        loadFilesFromFirebase(`files/rooms/${roomId}`, roomKey, fileIds),
      saveFiles: async () => ({ savedFiles: new Map(), erroredFiles: new Map() }),
    });

    const { loadedFiles, erroredFiles } = await fileManager.getFiles([
      fileIdB as FileId,
    ]);

    expect(erroredFiles.size).toBe(0);
    expect(loadedFiles).toHaveLength(1);
    expect(loadedFiles[0].id).toBe(fileIdB);
    expect(loadedFiles[0].mimeType).toBe("image/png");
    expect(loadedFiles[0].dataURL).toBe(ORIGINAL_DATA_URL);
    // after a successful fetch the file is tracked (won't be re-fetched)
    expect(fileManager.isFileTracked(fileIdB as FileId)).toBe(true);
  });
});
