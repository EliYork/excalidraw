/**
 * RoomCard — a non-editable, hand-drawn style card for the lobby. Shows only
 * public info: name, lock, online count, created/last-opened timestamps and
 * the local pin toggle. Never shows roomId / DB ids / keys.
 */
import { FilledButton } from "@excalidraw/excalidraw/components/FilledButton";
import {
  LockedIcon,
  PinIcon,
  usersIcon,
} from "@excalidraw/excalidraw/components/icons";
import clsx from "clsx";

import { formatRelativeTime } from "./Lobby";

import type { LobbyRoomSummary } from "./lobbyTypes";

export const RoomCard = ({
  room,
  onlineCount,
  isPinned,
  onOpen,
  onTogglePin,
}: {
  room: LobbyRoomSummary;
  onlineCount: number;
  isPinned: boolean;
  onOpen: () => void;
  onTogglePin: () => void;
}) => {
  return (
    <div
      className={clsx("room-card", { "room-card--pinned": isPinned })}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="room-card__top">
        <div className="room-card__name" title={room.name}>
          {room.name}
        </div>
        <div className="room-card__lock" title="Password protected">
          {LockedIcon}
        </div>
      </div>

      <div className="room-card__meta">
        <span
          className={clsx("room-card__online", {
            "room-card__online--zero": onlineCount === 0,
          })}
          title="People currently in this room"
        >
          {usersIcon}
          {onlineCount}
        </span>
      </div>

      <div className="room-card__footer">
        <div className="room-card__times">
          <div
            className="room-card__time"
            title={`Created ${new Date(room.createdAt).toLocaleString()}`}
          >
            Created {formatRelativeTime(room.createdAt)}
          </div>
          <div
            className="room-card__time"
            title={
              room.lastOpenedAt
                ? `Last opened ${new Date(room.lastOpenedAt).toLocaleString()}`
                : "Never opened"
            }
          >
            Opened {formatRelativeTime(room.lastOpenedAt)}
          </div>
        </div>
        <FilledButton
          size="medium"
          variant="icon"
          label={isPinned ? "Unpin" : "Pin to top"}
          icon={PinIcon}
          className={clsx("room-card__pin", {
            "room-card__pin--active": isPinned,
          })}
          onClick={(event) => {
            event.stopPropagation();
            onTogglePin();
          }}
        />
      </div>
    </div>
  );
};
