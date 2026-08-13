/**
 * Collaboration persistence layer.
 *
 * SELF-HOSTED BUILD: the original Firebase implementation (Firestore
 * transactions + Firebase Storage) is replaced by the HTTP storage backend
 * (see ./storage). All exported function signatures are preserved so callers
 * (Collab.tsx, App.tsx, data/index.ts) are untouched. Encryption, scene
 * reconciliation, and the version cache below are the official logic.
 *
 * Wire semantics are identical to the official one:
 *   - scenes:  { sceneVersion, iv, ciphertext } (AES-128-GCM, roomKey)
 *   - files:   deflate -> AES-128-GCM byte streams, paths files/{kind}/{ownerId}/{fileId}
 * The server only ever sees ciphertext.
 */
import { reconcileElements } from "@excalidraw/excalidraw";
import { MIME_TYPES, toBrandedType } from "@excalidraw/common";
import { decompressData } from "@excalidraw/excalidraw/data/encode";
import {
  encryptData,
  decryptData,
} from "@excalidraw/excalidraw/data/encryption";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { getSceneVersion } from "@excalidraw/element";

import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type {
  ExcalidrawElement,
  FileId,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFileMetadata,
  DataURL,
} from "@excalidraw/excalidraw/types";

import { storageBackend } from "./storage";

import { encodeFilesForUpload } from "./FileManager";

import { getSyncableElements } from ".";

import type { SyncableExcalidrawElement } from ".";
import type Portal from "../collab/Portal";
import type { Socket } from "socket.io-client";

// -----------------------------------------------------------------------------
// The Firebase SDK is not used in self-hosted builds. This export exists only
// to keep the "Export to Excalidraw+" migration feature from crashing at
// import time; the feature itself is hidden when VITE_APP_PLUS_APP is unset.
// -----------------------------------------------------------------------------
export const loadFirebaseStorage = async (): Promise<never> => {
  throw new Error(
    "Firebase storage is not available in self-hosted builds. " +
      "Excalidraw+ migration is not supported.",
  );
};

type FirebaseStoredScene = {
  sceneVersion: number;
  iv: Uint8Array;
  ciphertext: Uint8Array;
};

const encryptElements = async (
  key: string,
  elements: readonly ExcalidrawElement[],
): Promise<{ ciphertext: ArrayBuffer; iv: Uint8Array }> => {
  const json = JSON.stringify(elements);
  const encoded = new TextEncoder().encode(json);
  const { encryptedBuffer, iv } = await encryptData(key, encoded);

  return { ciphertext: encryptedBuffer, iv };
};

const decryptElements = async (
  data: FirebaseStoredScene,
  roomKey: string,
): Promise<readonly ExcalidrawElement[]> => {
  const ciphertext = data.ciphertext as Uint8Array<ArrayBuffer>;
  const iv = data.iv as Uint8Array<ArrayBuffer>;

  const decrypted = await decryptData(iv, ciphertext, roomKey);
  const decodedData = new TextDecoder("utf-8").decode(
    new Uint8Array(decrypted),
  );
  return JSON.parse(decodedData);
};

class FirebaseSceneVersionCache {
  private static cache = new WeakMap<Socket, number>();
  static get = (socket: Socket) => {
    return FirebaseSceneVersionCache.cache.get(socket);
  };
  static set = (
    socket: Socket,
    elements: readonly SyncableExcalidrawElement[],
  ) => {
    FirebaseSceneVersionCache.cache.set(socket, getSceneVersion(elements));
  };
}

export const isSavedToFirebase = (
  portal: Portal,
  elements: readonly ExcalidrawElement[],
): boolean => {
  if (portal.socket && portal.roomId && portal.roomKey) {
    const sceneVersion = getSceneVersion(elements);

    return FirebaseSceneVersionCache.get(portal.socket) === sceneVersion;
  }
  // if no room exists, consider the room saved so that we don't unnecessarily
  // prevent unload (there's nothing we could do at that point anyway)
  return true;
};

export const saveFilesToFirebase = async ({
  prefix,
  files,
}: {
  prefix: string;
  files: { id: FileId; buffer: Uint8Array }[];
}) => {
  const { savedFiles, erroredFiles } = await storageBackend.saveFiles(
    prefix,
    files,
  );

  return {
    savedFiles: savedFiles as FileId[],
    erroredFiles: erroredFiles as FileId[],
  };
};

/**
 * Collaboration FileManager adapter. Keeping the encode + transport boundary
 * here makes the runtime path independently testable without mounting Collab.
 */
export const saveCollabFiles = async ({
  prefix,
  encryptionKey,
  maxBytes,
  addedFiles,
}: {
  prefix: string;
  encryptionKey: string;
  maxBytes: number;
  addedFiles: Map<FileId, BinaryFileData>;
}) => {
  const { savedFiles, erroredFiles } = await saveFilesToFirebase({
    prefix,
    files: await encodeFilesForUpload({
      files: addedFiles,
      encryptionKey,
      maxBytes,
    }),
  });

  const toFileMap = (fileIds: FileId[]) =>
    fileIds.reduce((acc, id) => {
      const fileData = addedFiles.get(id);
      if (fileData) {
        acc.set(id, fileData);
      }
      return acc;
    }, new Map<FileId, BinaryFileData>());

  return {
    savedFiles: toFileMap(savedFiles),
    erroredFiles: toFileMap(erroredFiles),
  };
};

const createFirebaseSceneDocument = async (
  elements: readonly SyncableExcalidrawElement[],
  roomKey: string,
) => {
  const sceneVersion = getSceneVersion(elements);
  const { ciphertext, iv } = await encryptElements(roomKey, elements);
  return {
    sceneVersion,
    ciphertext: new Uint8Array(ciphertext),
    iv,
  } as FirebaseStoredScene;
};

// The official implementation used a Firestore transaction for read-modify-
// write. The HTTP backend cannot run server-side transactions over ciphertext,
// so we implement optimistic concurrency client-side: get -> reconcile ->
// put(If-Match), retrying on conflict (409).
const MAX_SAVE_ATTEMPTS = 3;

export const saveToFirebase = async (
  portal: Portal,
  elements: readonly SyncableExcalidrawElement[],
  appState: AppState,
) => {
  const { roomId, roomKey, socket } = portal;
  if (
    // bail if no room exists as there's nothing we can do at this point
    !roomId ||
    !roomKey ||
    !socket ||
    isSavedToFirebase(portal, elements)
  ) {
    return null;
  }

  let storedScene: FirebaseStoredScene | null = null;

  for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS; attempt++) {
    const existing = await storageBackend.getScene(roomId);

    let elementsToStore: readonly SyncableExcalidrawElement[] = elements;
    let expectedEtag: string | null = null;

    if (existing) {
      expectedEtag = existing.etag;
      const prevStoredElements = getSyncableElements(
        restoreElements(await decryptElements(existing, roomKey), null),
      );
      elementsToStore = getSyncableElements(
        reconcileElements(
          elements,
          prevStoredElements as OrderedExcalidrawElement[] as RemoteExcalidrawElement[],
          appState,
        ),
      );
    }

    const doc = await createFirebaseSceneDocument(elementsToStore, roomKey);
    const result = await storageBackend.putScene(roomId, doc, expectedEtag);

    if (!result.ok) {
      // concurrent write won; re-read and retry with fresh data
      continue;
    }

    storedScene = doc;
    break;
  }

  if (!storedScene) {
    throw new Error("collabSaveFailed: could not commit scene after retries");
  }

  const storedElements = getSyncableElements(
    restoreElements(await decryptElements(storedScene, roomKey), null),
  );

  FirebaseSceneVersionCache.set(socket, storedElements);

  return toBrandedType<RemoteExcalidrawElement[]>(storedElements);
};

export const loadFromFirebase = async (
  roomId: string,
  roomKey: string,
  socket: Socket | null,
): Promise<readonly SyncableExcalidrawElement[] | null> => {
  const existing = await storageBackend.getScene(roomId);
  if (!existing) {
    return null;
  }
  const elements = getSyncableElements(
    restoreElements(await decryptElements(existing, roomKey), null, {
      deleteInvisibleElements: true,
    }),
  );

  if (socket) {
    FirebaseSceneVersionCache.set(socket, elements);
  }

  return elements;
};

export const loadFilesFromFirebase = async (
  prefix: string,
  decryptionKey: string,
  filesIds: readonly FileId[],
) => {
  const { loadedFiles, erroredFiles: erroredFileIds } =
    await storageBackend.loadFiles(prefix, filesIds);

  const loaded: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  for (const fileId of erroredFileIds) {
    erroredFiles.set(fileId as FileId, true);
  }

  await Promise.all(
    loadedFiles.map(async ({ id, buffer }) => {
      try {
        const { data, metadata } = await decompressData<BinaryFileMetadata>(
          buffer,
          {
            decryptionKey,
          },
        );

        const dataURL = new TextDecoder().decode(data) as DataURL;

        loaded.push({
          mimeType: metadata.mimeType || MIME_TYPES.binary,
          id: id as FileId,
          dataURL,
          created: metadata?.created || Date.now(),
          lastRetrieved: metadata?.created || Date.now(),
        });
      } catch (error: any) {
        erroredFiles.set(id as FileId, true);
        console.error(error);
      }
    }),
  );

  return { loadedFiles: loaded, erroredFiles };
};
