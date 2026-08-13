// Lobby presence: derive active-connection counts per collaboration room
// from the Socket.IO adapter rooms map. Pure function so it can be unit
// tested without a live server.
//
// The rooms map contains one entry per socket-room pair: per-socket rooms
// (named after the socket id) and follow@<socketId> rooms must be excluded —
// collaboration room ids are 10 random bytes hex = 20 chars [a-f0-9].

const COLLAB_ROOM_RE = /^[a-f0-9]{20}$/;

export const computePresenceCounts = (
  rooms: Map<string, Set<string>>,
): Record<string, number> => {
  const counts: Record<string, number> = {};
  // Map.forEach keeps this compatible with the room service's current
  // tsconfig/target (no downlevelIteration needed for for...of).
  rooms.forEach((sockets, roomName) => {
    if (COLLAB_ROOM_RE.test(roomName)) {
      counts[roomName] = sockets.size;
    }
  });
  return counts;
};
