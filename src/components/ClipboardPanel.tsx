import { useEffect, useRef, useState } from "react";
import type { RoomClient, RoomState } from "../lib/p2p/room-client";
import { formatClock } from "../lib/format";
import { CheckIcon, ClipboardIcon, CopyIcon, TrashIcon } from "./Icons";

const AUTOCOPY_KEY = "maishare.autocopy";

function loadAutocopy(): boolean {
  try {
    return localStorage.getItem(AUTOCOPY_KEY) === "1";
  } catch {
    return false;
  }
}

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
};

export function ClipboardPanel({
  client,
  state,
  isSecure,
}: {
  client: RoomClient;
  state: RoomState;
  isSecure: boolean;
}) {
  const [autocopy, setAutocopy] = useState(loadAutocopy);
  const lastSeen = useRef<string | null>(null);

  // Auto-copy incoming text when enabled and the tab is focused
  useEffect(() => {
    const last = state.clips[state.clips.length - 1];
    if (!last || last.id === lastSeen.current) return;
    lastSeen.current = last.id;
    if (autocopy && last.kind === "text" && last.peerId !== state.selfId && document.hasFocus()) {
      navigator.clipboard
        ?.writeText(last.text)
        .then(() => client.toast(`Copied from ${last.peerName}`, "success"))
        .catch(() => {});
    }
  }, [state.clips, autocopy, state.selfId, client]);

  function toggleAutocopy() {
    const v = !autocopy;
    setAutocopy(v);
    try {
      localStorage.setItem(AUTOCOPY_KEY, v ? "1" : "0");
    } catch {}
  }

  async function sendMyClipboard() {
    if (!navigator.clipboard?.read) {
      client.toast("Clipboard reading is not available in this browser", "error");
      return;
    }
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const imgType = item.types.find((t) => t.startsWith("image/"));
        if (imgType) {
          const blob = await item.getType(imgType);
          const ext = EXT[imgType] || "bin";
          client.sendFiles([new File([blob], `clipboard.${ext}`, { type: imgType })], "clip");
          client.toast("Clipboard image sent", "success");
          return;
        }
      }
      const text = await navigator.clipboard.readText();
      if (text.trim()) {
        client.sendClipboardText(text);
        client.toast("Clipboard text sent", "success");
      } else {
        client.toast("Clipboard is empty", "info");
      }
    } catch {
      client.toast("Clipboard permission denied — you can still paste below", "error");
    }
  }

  async function copyClip(kind: "text" | "image", payload: string | Blob, mime?: string) {
    try {
      if (kind === "text") {
        await navigator.clipboard.writeText(payload as string);
      } else if (navigator.clipboard?.write && ClipboardItem) {
        await navigator.clipboard.write([
          new ClipboardItem({ [mime || "image/png"]: payload as Blob }),
        ]);
      } else {
        client.toast("Copying images needs a modern browser on a secure origin", "error");
        return;
      }
      client.toast("Copied to your clipboard", "success");
    } catch {
      client.toast("Copy failed — clipboard blocked on this origin", "error");
    }
  }

  return (
    <div className="clip panel">
      <div className="panel-head">
        <button className="btn btn-primary btn-sm" onClick={sendMyClipboard}>
          <ClipboardIcon size={14} /> Send my clipboard
        </button>
        <label className="toggle">
          <input type="checkbox" checked={autocopy} onChange={toggleAutocopy} />
          <span>Auto-copy incoming text</span>
        </label>
        {state.clips.length > 0 && (
          <button className="btn btn-ghost btn-sm" onClick={() => client.clearClips()}>
            <TrashIcon size={14} /> Clear
          </button>
        )}
      </div>
      {!isSecure && (
        <p className="notice">
          This origin is not secure — browsers only expose clipboard <em>reading</em> on HTTPS or
          localhost. Pasting (⌘/Ctrl+V) works everywhere.
        </p>
      )}
      <ul className="clip-list">
        {[...state.clips].reverse().map((c) => (
          <li key={c.id} className={`clip-item clip-${c.kind}`}>
            <div className="clip-head">
              <span className="clip-peer">
                {c.peerId === state.selfId ? "you" : c.peerName} · {formatClock(c.at)}
              </span>
              <button
                className="btn btn-sm"
                onClick={() =>
                  copyClip(
                    c.kind,
                    c.kind === "text" ? c.text : c.blob,
                    c.kind === "image" ? c.mime : undefined,
                  )
                }
              >
                {c.kind === "text" ? <CopyIcon size={13} /> : <CheckIcon size={13} />} Copy
              </button>
            </div>
            {c.kind === "text" ? (
              <pre className="clip-text">{c.text}</pre>
            ) : (
              <a
                href={c.blobUrl}
                download={`clipboard.${EXT[c.mime] || "png"}`}
                className="clip-image"
              >
                <img src={c.blobUrl} alt="shared clipboard image" />
              </a>
            )}
          </li>
        ))}
      </ul>
      {!state.clips.length && (
        <div className="empty">
          <ClipboardIcon size={26} />
          <p>
            Beam your clipboard across devices. Hit “Send my clipboard”, or just paste (⌘/Ctrl+V) on
            this tab — text and images both work.
          </p>
        </div>
      )}
    </div>
  );
}
