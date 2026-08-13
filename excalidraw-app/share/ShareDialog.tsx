import { trackEvent } from "@excalidraw/excalidraw/analytics";
import { copyTextToSystemClipboard } from "@excalidraw/excalidraw/clipboard";
import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { FilledButton } from "@excalidraw/excalidraw/components/FilledButton";
import { TextField } from "@excalidraw/excalidraw/components/TextField";
import {
  checkIcon,
  copyIcon,
  LinkIcon,
  pencilIcon,
  playerPlayIcon,
  playerStopFilledIcon,
  share,
  shareIOS,
  shareWindows,
} from "@excalidraw/excalidraw/components/icons";
import { useUIAppState } from "@excalidraw/excalidraw/context/ui-appState";
import { useCopyStatus } from "@excalidraw/excalidraw/hooks/useCopiedIndicator";
import { useI18n } from "@excalidraw/excalidraw/i18n";
import { KEYS, getFrame } from "@excalidraw/common";
import { useEffect, useRef, useState } from "react";

import { atom, useAtom, useAtomValue } from "../app-jotai";
import { activeRoomLinkAtom } from "../collab/Collab";
import { getCollaborationLinkData } from "../data";
import {
  deriveKek,
  generateLobbyPassword,
  newKdfParams,
  wrapRoomKey,
} from "../lobby/lobbyCrypto";
import { encodeKeyMaterial, lobbyApi } from "../lobby/lobbyApi";
import { lobbyStorage } from "../lobby/lobbyStorage";

import "./ShareDialog.scss";
import { QRCode } from "./QRCode";

import type { CollabAPI } from "../collab/Collab";

type OnExportToBackend = () => void;
type ShareDialogType = "share" | "collaborationOnly";

export const shareDialogStateAtom = atom<
  { isOpen: false } | { isOpen: true; type: ShareDialogType }
>({ isOpen: false });

const getShareIcon = () => {
  const navigator = window.navigator as any;
  const isAppleBrowser = /Apple/.test(navigator.vendor);
  const isWindowsBrowser = navigator.appVersion.indexOf("Win") !== -1;

  if (isAppleBrowser) {
    return shareIOS;
  } else if (isWindowsBrowser) {
    return shareWindows;
  }

  return share;
};

export type ShareDialogProps = {
  collabAPI: CollabAPI | null;
  handleClose: () => void;
  onExportToBackend: OnExportToBackend;
  type: ShareDialogType;
};

const ActiveRoomDialog = ({
  collabAPI,
  activeRoomLink,
  handleClose,
}: {
  collabAPI: CollabAPI;
  activeRoomLink: string;
  handleClose: () => void;
}) => {
  const { t } = useI18n();
  const [, setJustCopied] = useState(false);
  const timerRef = useRef<number>(0);
  const ref = useRef<HTMLInputElement>(null);
  const isShareSupported = "share" in navigator;
  const { onCopy, copyStatus } = useCopyStatus();

  // Lobby integration: the room id/key come from the active share link.
  // Whoever holds the local manage token for this room is treated as the
  // creator (no accounts; the token lives only in the creator's browser).
  const linkData = getCollaborationLinkData(activeRoomLink);
  const roomId = linkData?.roomId ?? null;
  const roomKey = linkData?.roomKey ?? null;
  const manageToken = roomId ? lobbyStorage.getManageToken(roomId) : null;
  const isCreator = manageToken !== null;

  const [roomName, setRoomName] = useState("");
  const [roomNameLoaded, setRoomNameLoaded] = useState(false);
  const [savingName, setSavingName] = useState(false);
  const [lobbyError, setLobbyError] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);
  const [generatedPassword, setGeneratedPassword] = useState<string | null>(
    null,
  );

  useEffect(() => {
    if (!roomId) {
      return;
    }
    let cancelled = false;
    lobbyApi
      .getRoom(roomId)
      .then((detail) => {
        if (!cancelled) {
          setRoomName(detail.name);
          setRoomNameLoaded(true);
        }
      })
      .catch(() => {
        // non-fatal: the dialog still works without the room name
      });
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  const copyRoomLink = async () => {
    try {
      await copyTextToSystemClipboard(activeRoomLink);
    } catch (e) {
      collabAPI.setCollabError(t("errors.copyToSystemClipboardFailed"));
    }

    setJustCopied(true);

    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
    }

    timerRef.current = window.setTimeout(() => {
      setJustCopied(false);
    }, 3000);

    ref.current?.select();
  };

  const copyLobbyPassword = async () => {
    if (!roomId) {
      return;
    }
    const password = lobbyStorage.getPassword(roomId);
    if (!password) {
      return;
    }
    try {
      await copyTextToSystemClipboard(password);
    } catch (e) {
      collabAPI.setCollabError(t("errors.copyToSystemClipboardFailed"));
    }
    onCopy();
  };

  const saveRoomName = async () => {
    if (!roomId || !manageToken) {
      return;
    }
    const trimmed = roomName.trim();
    if (!trimmed) {
      return;
    }
    setSavingName(true);
    setLobbyError(null);
    try {
      await lobbyApi.updateRoom(roomId, { manageToken, name: trimmed });
      setRoomName(trimmed);
    } catch (error: any) {
      setLobbyError(error?.message ?? "Failed to rename the room");
    } finally {
      setSavingName(false);
    }
  };

  const changeLobbyPassword = async () => {
    if (!roomId || !manageToken || !roomKey) {
      return;
    }
    setChangingPassword(true);
    setLobbyError(null);
    setGeneratedPassword(null);
    try {
      // empty input => auto-generate a fresh human-friendly password
      const password = newPassword.trim() || generateLobbyPassword();
      const salt = new Uint8Array(16);
      window.crypto.getRandomValues(salt);
      const { kdfVersion, kdfIterations } = newKdfParams();
      const kek = await deriveKek(password, salt, kdfIterations);
      const { wrappedRoomKey, iv } = await wrapRoomKey(kek, roomKey);
      const keyMaterial = encodeKeyMaterial({
        wrappedRoomKey,
        passwordSalt: salt,
        passwordIv: iv,
      });
      await lobbyApi.updateRoom(roomId, {
        manageToken,
        hasPassword: true,
        ...keyMaterial,
        kdfVersion,
        kdfIterations,
      });
      lobbyStorage.setPassword(roomId, password);
      setNewPassword("");
      setGeneratedPassword(password);
    } catch (error: any) {
      setLobbyError(error?.message ?? "Failed to change the lobby password");
    } finally {
      setChangingPassword(false);
    }
  };

  const shareRoomLink = async () => {
    try {
      await navigator.share({
        title: t("roomDialog.shareTitle"),
        text: t("roomDialog.shareTitle"),
        url: activeRoomLink,
      });
    } catch (error: any) {
      // Just ignore.
    }
  };

  return (
    <>
      <h3 className="ShareDialog__active__header">
        {t("labels.liveCollaboration").replace(/\./g, "")}
      </h3>
      <div className="ShareDialog__active__room">
        <TextField
          label="Room name"
          value={roomName}
          readonly={!isCreator || !roomNameLoaded}
          placeholder="Untitled canvas"
          onChange={(value) => setRoomName(value)}
          onKeyDown={(event) => {
            if (event.key === KEYS.ENTER) {
              saveRoomName();
            }
          }}
        />
        {isCreator && (
          <FilledButton
            size="medium"
            variant="icon"
            label="Save name"
            icon={checkIcon}
            status={savingName ? "loading" : null}
            onClick={saveRoomName}
          />
        )}
      </div>
      <TextField
        defaultValue={collabAPI.getUsername()}
        placeholder="Your name"
        label="Your name"
        onChange={collabAPI.setUsername}
        onKeyDown={(event) => event.key === KEYS.ENTER && handleClose()}
      />
      <div className="ShareDialog__active__linkRow">
        <TextField
          ref={ref}
          label="Link"
          readonly
          fullWidth
          value={activeRoomLink}
        />
        {isShareSupported && (
          <FilledButton
            size="large"
            variant="icon"
            label="Share"
            icon={getShareIcon()}
            className="ShareDialog__active__share"
            onClick={shareRoomLink}
          />
        )}
        <FilledButton
          size="large"
          label={t("buttons.copyLink")}
          icon={copyIcon}
          status={copyStatus}
          onClick={() => {
            copyRoomLink();
            onCopy();
          }}
        />
      </div>
      <div className="ShareDialog__active__lobby">
        <p className="ShareDialog__active__lobby__note">
          <strong>Full share link:</strong> contains the room key — anyone with
          this link enters directly, no password needed. From the lobby, the
          first entry on a new device requires the lobby password.
        </p>

        {isCreator && (
          <>
            <div className="ShareDialog__active__lobby__passwordRow">
              <TextField
                label="Lobby password"
                readonly
                fullWidth
                value={lobbyStorage.getPassword(roomId!) ?? ""}
                placeholder="No password stored on this device"
              />
              <FilledButton
                size="large"
                variant="icon"
                label="Copy password"
                icon={copyIcon}
                onClick={copyLobbyPassword}
              />
            </div>
            <div className="ShareDialog__active__lobby__rotate">
              <TextField
                label="New password (empty = auto-generate)"
                placeholder="e.g. K7PM-4XQH-Z2"
                value={newPassword}
                onChange={(value) => setNewPassword(value)}
              />
              <FilledButton
                size="large"
                label="Change password"
                icon={pencilIcon}
                status={changingPassword ? "loading" : null}
                onClick={changeLobbyPassword}
              />
            </div>
            {generatedPassword && (
              <div className="ShareDialog__active__lobby__generated">
                New lobby password: <strong>{generatedPassword}</strong>
              </div>
            )}
            <p className="ShareDialog__active__lobby__note">
              Changing the lobby password does <strong>not</strong> revoke
              existing full share links — they already contain the room key.
            </p>
          </>
        )}
        {lobbyError && (
          <p className="ShareDialog__active__lobby__error">{lobbyError}</p>
        )}
      </div>
      <QRCode value={activeRoomLink} />
      <div className="ShareDialog__active__description">
        <p>
          <span
            role="img"
            aria-hidden="true"
            className="ShareDialog__active__description__emoji"
          >
            🔒{" "}
          </span>
          {t("roomDialog.desc_privacy")}
        </p>
        <p>{t("roomDialog.desc_exitSession")}</p>
      </div>

      <div className="ShareDialog__active__actions">
        <FilledButton
          size="large"
          variant="outlined"
          color="danger"
          label={t("roomDialog.button_stopSession")}
          icon={playerStopFilledIcon}
          onClick={() => {
            trackEvent("share", "room closed");
            collabAPI.stopCollaboration();
            if (!collabAPI.isCollaborating()) {
              handleClose();
            }
          }}
        />
      </div>
    </>
  );
};

const ShareDialogPicker = (props: ShareDialogProps) => {
  const { t } = useI18n();

  const { collabAPI } = props;

  const startCollabJSX = collabAPI ? (
    <>
      <div className="ShareDialog__picker__header">
        {t("labels.liveCollaboration").replace(/\./g, "")}
      </div>

      <div className="ShareDialog__picker__description">
        <div style={{ marginBottom: "1em" }}>{t("roomDialog.desc_intro")}</div>
        {t("roomDialog.desc_privacy")}
      </div>

      <div className="ShareDialog__picker__button">
        <FilledButton
          size="large"
          label={t("roomDialog.button_startSession")}
          icon={playerPlayIcon}
          onClick={() => {
            trackEvent("share", "room creation", `ui (${getFrame()})`);
            collabAPI.startCollaboration(null);
          }}
        />
      </div>

      {props.type === "share" && (
        <div className="ShareDialog__separator">
          <span>{t("shareDialog.or")}</span>
        </div>
      )}
    </>
  ) : null;

  return (
    <>
      {startCollabJSX}

      {props.type === "share" && (
        <>
          <div className="ShareDialog__picker__header">
            {t("exportDialog.link_title")}
          </div>
          <div className="ShareDialog__picker__description">
            {t("exportDialog.link_details")}
          </div>

          <div className="ShareDialog__picker__button">
            <FilledButton
              size="large"
              label={t("exportDialog.link_button")}
              icon={LinkIcon}
              onClick={async () => {
                await props.onExportToBackend();
                props.handleClose();
              }}
            />
          </div>
        </>
      )}
    </>
  );
};

const ShareDialogInner = (props: ShareDialogProps) => {
  const activeRoomLink = useAtomValue(activeRoomLinkAtom);

  return (
    <Dialog size="small" onCloseRequest={props.handleClose} title={false}>
      <div className="ShareDialog">
        {props.collabAPI && activeRoomLink ? (
          <ActiveRoomDialog
            collabAPI={props.collabAPI}
            activeRoomLink={activeRoomLink}
            handleClose={props.handleClose}
          />
        ) : (
          <ShareDialogPicker {...props} />
        )}
      </div>
    </Dialog>
  );
};

export const ShareDialog = (props: {
  collabAPI: CollabAPI | null;
  onExportToBackend: OnExportToBackend;
}) => {
  const [shareDialogState, setShareDialogState] = useAtom(shareDialogStateAtom);

  const { openDialog } = useUIAppState();

  useEffect(() => {
    if (openDialog) {
      setShareDialogState({ isOpen: false });
    }
  }, [openDialog, setShareDialogState]);

  if (!shareDialogState.isOpen) {
    return null;
  }

  return (
    <ShareDialogInner
      handleClose={() => setShareDialogState({ isOpen: false })}
      collabAPI={props.collabAPI}
      onExportToBackend={props.onExportToBackend}
      type={shareDialogState.type}
    />
  );
};
