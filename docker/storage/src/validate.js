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
