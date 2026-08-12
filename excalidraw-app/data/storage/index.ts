/**
 * Storage backend selection.
 *
 * The default for self-hosted builds is the HTTP backend, rooted at
 * STORAGE_BASE_URL (runtime config override -> build-time env -> "" = same
 * origin `/api/v2`). The official Firebase implementation is not bundled
 * anymore; the interface in `types.ts` is the extension point if a different
 * backend is ever needed.
 */
import { STORAGE_BASE_URL } from "../runtimeConfig";
import { HttpStorageBackend } from "./httpBackend";
import type { StorageBackend } from "./types";

export const storageBackend: StorageBackend = new HttpStorageBackend(STORAGE_BASE_URL);
