// ID validation helpers. The server must NEVER trust client-supplied
// identifiers: they are interpolated into filesystem paths and DB keys.
//
// roomId: 10 random bytes hex = 20 chars [a-f0-9]
// fileId: SHA-1 hex = 40 chars [a-f0-9]
// shareLinkId: server-generated id (alphanumeric, from the share-link backend)
// kind: one of "rooms" | "shareLinks"

const HEX_RE = /^[a-f0-9]+$/;

export const isRoomId = (id) => typeof id === "string" && HEX_RE.test(id) && id.length === 20;

export const isFileId = (id) => typeof id === "string" && HEX_RE.test(id) && id.length === 40;

// share link ids come from the (self-hosted) share-link backend; be permissive
// but still safe: alphanumeric only, bounded length.
export const isShareLinkId = (id) =>
  typeof id === "string" && /^[a-zA-Z0-9]{1,64}$/.test(id);

export const isValidKind = (kind) => kind === "rooms" || kind === "shareLinks";

/** SHA-256 hex digest of the manage token (64 hex chars). */
export const isManageTokenHash = (hash) =>
  typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash);

/** KDF version supported by this server (1 = PBKDF2-SHA256). */
export const isKdfVersion = (version) => version === 1;

/** PBKDF2 iteration count: >= 100k, <= 2M (sane browser budget). */
export const isKdfIterations = (iterations) =>
  Number.isInteger(iterations) && iterations >= 100000 && iterations <= 2000000;

/** Room display name: trimmed, non-empty, bounded length. */
export const isRoomName = (name) =>
  typeof name === "string" &&
  name.trim().length > 0 &&
  name.trim().length <= 200;

/**
 * Parse a firebase-style storage prefix into { kind, ownerId }.
 * Accepts optional leading slash.
 *   "files/rooms/<roomId>"       -> { kind: "rooms", ownerId: <roomId> }
 *   "/files/shareLinks/<id>"     -> { kind: "shareLinks", ownerId: <id> }
 * Returns null when the prefix is malformed.
 */
export const parsePrefix = (prefix) => {
  if (typeof prefix !== "string") {
    return null;
  }
  const parts = prefix.replace(/^\/+/, "").split("/");
  if (parts.length !== 3 || parts[0] !== "files") {
    return null;
  }
  const [, kind, ownerId] = parts;
  if (!isValidKind(kind)) {
    return null;
  }
  if (kind === "rooms" && !isRoomId(ownerId)) {
    return null;
  }
  if (kind === "shareLinks" && !isShareLinkId(ownerId)) {
    return null;
  }
  return { kind, ownerId };
};

/** Build a safe relative path for a file, or null when invalid. */
export const fileRelPath = (kind, ownerId, fileId) => {
  if (!isValidKind(kind) || !isFileId(fileId)) {
    return null;
  }
  if (kind === "rooms" && !isRoomId(ownerId)) {
    return null;
  }
  if (kind === "shareLinks" && !isShareLinkId(ownerId)) {
    return null;
  }
  return `${kind}/${ownerId}/${fileId}`;
};
