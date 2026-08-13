/**
 * Lobby sorting:
 *   1. pinned rooms first (in the order pinned locally),
 *   2. remaining rooms by lastOpenedAt DESC (nulls last),
 *   3. tie-break by createdAt DESC.
 * lastOpenedAt only changes on a successful join (server-side), so the sort
 * is stable and predictable.
 */
import type { LobbyRoomSummary } from "./lobbyTypes";

export const sortLobbyRooms = (
  rooms: readonly LobbyRoomSummary[],
  pinned: readonly string[],
): LobbyRoomSummary[] => {
  const pinnedRank = new Map(pinned.map((id, index) => [id, index]));
  return [...rooms].sort((a, b) => {
    const aPinned = pinnedRank.has(a.roomId);
    const bPinned = pinnedRank.has(b.roomId);
    if (aPinned && bPinned) {
      return pinnedRank.get(a.roomId)! - pinnedRank.get(b.roomId)!;
    }
    if (aPinned !== bPinned) {
      return aPinned ? -1 : 1;
    }
    const aOpened = a.lastOpenedAt ?? -1;
    const bOpened = b.lastOpenedAt ?? -1;
    if (aOpened !== bOpened) {
      return bOpened - aOpened;
    }
    return b.createdAt - a.createdAt;
  });
};
