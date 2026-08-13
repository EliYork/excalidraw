/**
 * Lobby — the root view of the self-hosted app. Shows every permanent NAS
 * room as a hand-drawn style card; "New canvas" always creates a persistent
 * shared room that is registered in the Lobby Registry.
 *
 * The lobby is a NON-EDITABLE overlay (not an Excalidraw scene). Entering a
 * room just sets the #room=roomId,roomKey hash, which drives the existing
 * hashchange -> startCollaboration flow — the collaboration machinery
 * (Socket.IO, scene load, FileManager) is untouched.
 */
import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { FilledButton } from "@excalidraw/excalidraw/components/FilledButton";
import { TextField } from "@excalidraw/excalidraw/components/TextField";
import {
  PlusIcon,
  playerPlayIcon,
} from "@excalidraw/excalidraw/components/icons";
import { KEYS } from "@excalidraw/common";
import { useEffect, useMemo, useReducer, useState } from "react";

import { generateCollaborationLinkData } from "../data";

import {
  deriveKek,
  generateLobbyPassword,
  generateManageToken,
  newKdfParams,
  sha256Hex,
  unwrapRoomKey,
  wrapRoomKey,
} from "./lobbyCrypto";
import {
  b64ToBytes,
  encodeKeyMaterial,
  lobbyApi,
  LobbyApiError,
} from "./lobbyApi";
import { lobbyStorage } from "./lobbyStorage";
import { sortLobbyRooms } from "./lobbySort";
import { RoomCard } from "./RoomCard";

import "./Lobby.scss";

import type { LobbyRoomSummary } from "./lobbyTypes";

const PRESENCE_POLL_MS = 5000;
const LIST_REFRESH_MS = 15000;

const toErrorMessage = (error: unknown): string => {
  if (error instanceof LobbyApiError) {
    return error.message;
  }
  console.error(error);
  return "An unexpected error occurred";
};

/** Relative "time ago" label for card timestamps. */
export const formatRelativeTime = (timestamp: number | null): string => {
  if (timestamp === null) {
    return "Never opened";
  }
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) {
    return "Just now";
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${days} d ago`;
  }
  const months = Math.floor(days / 30);
  if (months < 12) {
    return `${months} mo ago`;
  }
  return `${Math.floor(months / 12)} y ago`;
};

const LobbyPasswordDialog = ({
  room,
  error,
  onClose,
  onSubmit,
}: {
  room: LobbyRoomSummary;
  error: string | null;
  onClose: () => void;
  onSubmit: (password: string) => void;
}) => {
  const [password, setPassword] = useState("");
  return (
    <Dialog size="small" onCloseRequest={onClose} title={false}>
      <div className="lobby-dialog">
        <h3 className="lobby-dialog__title">Enter room</h3>
        <div className="lobby-dialog__room">{room.name}</div>
        <p className="lobby-dialog__hint">
          This room is password protected. Enter the lobby password to unlock it
          on this device. After that, this device enters directly — no password
          needed again.
        </p>
        <TextField
          label="Lobby password"
          placeholder="e.g. K7PM-4XQH-Z2"
          value={password}
          onChange={(value) => setPassword(value)}
          onKeyDown={(event) => {
            if (event.key === KEYS.ENTER) {
              onSubmit(password);
            }
          }}
        />
        {error && <div className="lobby-dialog__error">{error}</div>}
        <div className="lobby-dialog__actions">
          <FilledButton
            size="large"
            variant="outlined"
            label="Cancel"
            onClick={onClose}
          />
          <FilledButton
            size="large"
            label="Unlock & enter"
            icon={playerPlayIcon}
            onClick={() => onSubmit(password)}
          />
        </div>
      </div>
    </Dialog>
  );
};

export const Lobby = ({ visible }: { visible: boolean }) => {
  const [rooms, setRooms] = useState<LobbyRoomSummary[]>([]);
  const [presence, setPresence] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [passwordRoom, setPasswordRoom] = useState<LobbyRoomSummary | null>(
    null,
  );
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [pinnedVersion, bumpPinnedVersion] = useReducer(
    (x: number) => x + 1,
    0,
  );

  // refresh the room list while the lobby is visible
  useEffect(() => {
    if (!visible) {
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const list = await lobbyApi.listRooms();
        if (!cancelled) {
          setRooms(list);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(toErrorMessage(loadError));
        }
      }
    };
    load();
    const timer = window.setInterval(load, LIST_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [visible]);

  // live presence: poll the room service every ~5s
  useEffect(() => {
    if (!visible) {
      return;
    }
    let cancelled = false;
    const poll = async () => {
      const counts = await lobbyApi.fetchPresence();
      if (!cancelled) {
        setPresence(counts);
      }
    };
    poll();
    const timer = window.setInterval(poll, PRESENCE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [visible]);

  const pinned = useMemo(
    () => lobbyStorage.getPinned(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pinnedVersion, visible],
  );

  const sortedRooms = useMemo(
    () => sortLobbyRooms(rooms, pinned),
    [rooms, pinned],
  );

  const enterRoom = (roomId: string, roomKey: string) => {
    // lastOpenedAt is a pure sort signal; a failure to report must not block
    // entry into the room.
    lobbyApi.reportOpen(roomId).catch((reportError) => {
      console.error("lobby: failed to report open", reportError);
    });
    window.location.hash = `room=${roomId},${roomKey}`;
  };

  const handleRoomClick = (room: LobbyRoomSummary) => {
    const cachedKey = lobbyStorage.getRoomKey(room.roomId);
    if (cachedKey) {
      enterRoom(room.roomId, cachedKey);
      return;
    }
    setPasswordError(null);
    setPasswordRoom(room);
  };

  const handlePasswordSubmit = async (password: string) => {
    if (!passwordRoom) {
      return;
    }
    setPasswordError(null);
    try {
      const detail = await lobbyApi.getRoom(passwordRoom.roomId);
      const kek = await deriveKek(
        password,
        b64ToBytes(detail.passwordSalt),
        detail.kdfIterations,
      );
      const roomKey = await unwrapRoomKey(
        kek,
        b64ToBytes(detail.wrappedRoomKey),
        b64ToBytes(detail.passwordIv),
      );
      if (!roomKey) {
        setPasswordError("Wrong password. Please try again.");
        return;
      }
      lobbyStorage.setRoomKey(passwordRoom.roomId, roomKey);
      const room = passwordRoom;
      setPasswordRoom(null);
      enterRoom(room.roomId, roomKey);
    } catch (submitError) {
      setPasswordError(toErrorMessage(submitError));
    }
  };

  const handleCreate = async () => {
    setCreating(true);
    setError(null);
    try {
      const { roomId, roomKey } = await generateCollaborationLinkData();
      const password = generateLobbyPassword();
      const manageToken = generateManageToken();
      const salt = new Uint8Array(16);
      window.crypto.getRandomValues(salt);
      const { kdfVersion, kdfIterations } = newKdfParams();
      const kek = await deriveKek(password, salt, kdfIterations);
      const { wrappedRoomKey, iv } = await wrapRoomKey(kek, roomKey);
      const manageTokenHash = await sha256Hex(manageToken);
      const keyMaterial = encodeKeyMaterial({
        wrappedRoomKey,
        passwordSalt: salt,
        passwordIv: iv,
      });

      // register in the Lobby Registry first — if the NAS storage is
      // unavailable we must NOT pretend the room is persisted
      await lobbyApi.createRoom({
        roomId,
        name: "Untitled canvas",
        hasPassword: true,
        ...keyMaterial,
        kdfVersion,
        kdfIterations,
        manageTokenHash,
      });

      lobbyStorage.setRoomKey(roomId, roomKey);
      lobbyStorage.setManageToken(roomId, manageToken);
      lobbyStorage.setPassword(roomId, password);

      enterRoom(roomId, roomKey);
    } catch (createError) {
      setError(toErrorMessage(createError));
    } finally {
      setCreating(false);
    }
  };

  const handleTogglePin = (roomId: string) => {
    lobbyStorage.togglePinned(roomId);
    bumpPinnedVersion();
  };

  if (!visible) {
    return null;
  }

  return (
    <div className="lobby">
      <div className="lobby__header">
        <div>
          <h1 className="lobby__title">Lobby</h1>
          <p className="lobby__subtitle">
            Persistent shared rooms on your NAS. Rooms are permanent and require
            the lobby password when entering from a new device.
          </p>
        </div>
        <FilledButton
          size="large"
          label={creating ? "Creating…" : "New canvas"}
          icon={PlusIcon}
          onClick={handleCreate}
          disabled={creating}
        />
      </div>

      {error && (
        <div className="lobby__banner lobby__banner--error" role="alert">
          {error}
        </div>
      )}
      {creating && <div className="lobby__banner">Creating room…</div>}

      {sortedRooms.length === 0 && !creating && !error ? (
        <div className="lobby__empty">
          <div className="lobby__empty__icon">✏️</div>
          <p>No rooms yet.</p>
          <p>
            Create your first canvas — it is saved to the NAS and listed here
            forever.
          </p>
        </div>
      ) : (
        <div className="lobby__grid">
          {sortedRooms.map((room) => (
            <RoomCard
              key={room.roomId}
              room={room}
              onlineCount={presence[room.roomId] ?? 0}
              isPinned={pinned.includes(room.roomId)}
              onOpen={() => handleRoomClick(room)}
              onTogglePin={() => handleTogglePin(room.roomId)}
            />
          ))}
        </div>
      )}

      {passwordRoom && (
        <LobbyPasswordDialog
          room={passwordRoom}
          error={passwordError}
          onClose={() => setPasswordRoom(null)}
          onSubmit={handlePasswordSubmit}
        />
      )}
    </div>
  );
};
