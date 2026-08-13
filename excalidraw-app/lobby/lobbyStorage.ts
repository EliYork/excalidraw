/**
 * Lobby local state (browser-only, never uploaded):
 *   - roomKey cache: after a successful join, this device enters directly
 *     without the lobby password. The password itself is NOT used for entry.
 *   - manage tokens: creator-only, used for rename / password rotation.
 *   - creator passwords: shown in the share dialog ("查看/复制大厅密码"); the
 *     entry flow never reads them.
 *   - pinned room ids: ordered, local-only sort boost.
 */
const ROOM_KEYS_KEY = "excalidraw-lobby-roomkeys";
const MANAGE_TOKENS_KEY = "excalidraw-lobby-managetokens";
const PASSWORDS_KEY = "excalidraw-lobby-passwords";
const PINNED_KEY = "excalidraw-lobby-pinned";

type RecordMap = Record<string, string>;

const readMap = (key: string): RecordMap => {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    console.error(`lobby: failed to read ${key}`, error);
    return {};
  }
};

const writeMap = (key: string, map: RecordMap) => {
  try {
    localStorage.setItem(key, JSON.stringify(map));
  } catch (error) {
    console.error(`lobby: failed to write ${key}`, error);
  }
};

export const lobbyStorage = {
  // roomKey cache ----------------------------------------------------------
  getRoomKey(roomId: string): string | null {
    return readMap(ROOM_KEYS_KEY)[roomId] ?? null;
  },
  setRoomKey(roomId: string, roomKey: string) {
    const map = readMap(ROOM_KEYS_KEY);
    map[roomId] = roomKey;
    writeMap(ROOM_KEYS_KEY, map);
  },

  // manage tokens (creator-only) ------------------------------------------
  getManageToken(roomId: string): string | null {
    return readMap(MANAGE_TOKENS_KEY)[roomId] ?? null;
  },
  setManageToken(roomId: string, token: string) {
    const map = readMap(MANAGE_TOKENS_KEY);
    map[roomId] = token;
    writeMap(MANAGE_TOKENS_KEY, map);
  },

  // creator passwords (display only; never used to enter the room) ---------
  getPassword(roomId: string): string | null {
    return readMap(PASSWORDS_KEY)[roomId] ?? null;
  },
  setPassword(roomId: string, password: string) {
    const map = readMap(PASSWORDS_KEY);
    map[roomId] = password;
    writeMap(PASSWORDS_KEY, map);
  },

  // pinned room ids (ordered, local-only) ---------------------------------
  getPinned(): string[] {
    try {
      const raw = localStorage.getItem(PINNED_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed)
        ? parsed.filter((id) => typeof id === "string")
        : [];
    } catch (error) {
      console.error("lobby: failed to read pinned", error);
      return [];
    }
  },
  setPinned(roomIds: string[]) {
    try {
      localStorage.setItem(PINNED_KEY, JSON.stringify(roomIds));
    } catch (error) {
      console.error("lobby: failed to write pinned", error);
    }
  },
  /** Toggle pin; returns the new pinned state. */
  togglePinned(roomId: string): boolean {
    const pinned = this.getPinned();
    const isPinned = pinned.includes(roomId);
    const next = isPinned
      ? pinned.filter((id) => id !== roomId)
      : [...pinned, roomId];
    this.setPinned(next);
    return !isPinned;
  },
};
