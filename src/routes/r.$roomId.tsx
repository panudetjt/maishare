import { useEffect, useState } from "react";
import {
  createFileRoute,
  Link,
  useNavigate,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { z } from "zod";
import { useRoom } from "../lib/p2p/use-room";
import { loadName, saveName } from "../lib/device";
import { addRecent } from "../lib/recents";
import { ChatPanel } from "../components/ChatPanel";
import { FilesPanel } from "../components/FilesPanel";
import { ClipboardPanel } from "../components/ClipboardPanel";
import { PeerList } from "../components/PeerList";
import { QrInvite } from "../components/QrInvite";
import { Toasts } from "../components/Toasts";
import {
  ArrowLeft,
  ChatIcon,
  ClipboardIcon,
  CopyIcon,
  FileIcon,
  LockIcon,
  Logo,
  QrIcon,
} from "../components/Icons";

export const roomSearchSchema = z.object({
  k: z.string().min(4).max(200).optional().catch(undefined),
  tab: z.enum(["chat", "files", "clipboard"]).optional().catch("chat"),
  name: z.string().trim().max(32).optional().catch(undefined),
  q: z.string().max(64).optional().catch(""),
  sort: z.enum(["recent", "name", "size"]).optional().catch("recent"),
});

export type RoomSearch = z.output<typeof roomSearchSchema>;

export const Route = createFileRoute("/r/$roomId")({
  validateSearch: (input) => roomSearchSchema.parse(input),
  loader: ({ params }) => {
    if (!/^[\w-]{2,64}$/.test(params.roomId)) {
      throw new Error(`"${params.roomId}" is not a valid room code.`);
    }
    return {
      supported: typeof RTCPeerConnection !== "undefined" && typeof WebSocket !== "undefined",
      isSecure: window.isSecureContext,
    };
  },
  pendingComponent: RoomPending,
  errorComponent: RoomError,
  component: RoomRoute,
});

function RoomRoute() {
  const { roomId } = Route.useParams();
  const search = Route.useSearch();
  const { supported, isSecure } = Route.useLoaderData();
  const navigate = useNavigate({ from: Route.fullPath });
  const [profileName] = useState(() => loadName());
  const name = search.name ?? profileName;
  const tab = search.tab ?? "chat";
  const { client, state } = useRoom(roomId, search.k, name);
  const [showQr, setShowQr] = useState(false);
  const [dragDepth, setDragDepth] = useState(0);
  const [nameDraft, setNameDraft] = useState(name);
  const [copied, setCopied] = useState(false);

  const inviteUrl = `${location.origin}/r/${roomId}${search.k ? `?k=${encodeURIComponent(search.k)}` : ""}`;

  const setSearch = (patch: Partial<RoomSearch>) => {
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true });
  };

  useEffect(() => {
    addRecent({ roomId, k: search.k, at: Date.now() });
  }, [roomId, search.k]);

  // Room-wide paste: files/images are sent as transfers, text as a clipboard
  // item (except when pasting into the chat composer itself).
  useEffect(() => {
    if (!client) return;
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      )
        return;
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length) {
        e.preventDefault();
        client.sendFiles(files, tab === "clipboard" ? "clip" : "file");
        return;
      }
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (text.trim() && tab !== "chat") {
        e.preventDefault();
        client.sendClipboardText(text);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [client, tab]);

  function commitName(v: string) {
    const n = v.trim().slice(0, 32);
    if (!n || n === name) {
      setNameDraft(name);
      return;
    }
    saveName(n);
    setSearch({ name: n });
  }

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  }

  if (!supported) {
    return (
      <div className="page narrow center-v">
        <div className="panel notfound">
          <h2>WebRTC unavailable</h2>
          <p className="muted">This browser can’t do peer-to-peer transfers.</p>
          <Link to="/" className="btn btn-primary">
            Back home
          </Link>
        </div>
      </div>
    );
  }

  const signalDot =
    state.signalStatus === "online"
      ? "dot dot-ok"
      : state.signalStatus === "connecting"
        ? "dot dot-warn"
        : "dot dot-err";

  return (
    <div
      className="page room"
      onDragEnter={(e) => {
        e.preventDefault();
        setDragDepth((d) => d + 1);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => setDragDepth((d) => Math.max(0, d - 1))}
      onDrop={(e) => {
        e.preventDefault();
        setDragDepth(0);
        if (e.dataTransfer.files.length && client)
          client.sendFiles(e.dataTransfer.files, tab === "clipboard" ? "clip" : "file");
      }}
    >
      <header className="room-header">
        <Link to="/" className="btn-icon back" aria-label="Back to home">
          <ArrowLeft size={18} />
        </Link>
        <div className="brand brand-sm">
          <Logo size={20} />
          <span className="brand-name">maishare</span>
        </div>
        <span className="room-code" title={`room ${roomId}`}>
          {roomId}
          {search.k ? <LockIcon size={12} /> : null}
        </span>
        <div className="header-actions">
          <button className="btn btn-sm" onClick={copyInvite}>
            <CopyIcon size={14} /> {copied ? "Copied!" : "Invite"}
          </button>
          <button
            className="btn btn-sm"
            onClick={() => setShowQr((v) => !v)}
            aria-expanded={showQr}
          >
            <QrIcon size={14} /> QR
          </button>
        </div>
        <span className="signal" title={`signaling: ${state.signalStatus}`}>
          <span className={signalDot} /> {state.signalStatus}
        </span>
        <label className="name-field">
          <span className="muted small">name</span>
          <input
            value={nameDraft}
            maxLength={32}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={(e) => commitName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            aria-label="Your display name"
          />
        </label>
      </header>

      {showQr && <QrInvite url={inviteUrl} onClose={() => setShowQr(false)} />}

      <div className="room-body">
        <PeerList state={state} />
        <main className="room-main">
          <nav className="tabs" aria-label="Room sections">
            <TabLink roomId={roomId} active={tab === "chat"} tab="chat">
              <ChatIcon size={15} /> Chat
            </TabLink>
            <TabLink roomId={roomId} active={tab === "files"} tab="files">
              <FileIcon size={15} /> Files
            </TabLink>
            <TabLink roomId={roomId} active={tab === "clipboard"} tab="clipboard">
              <ClipboardIcon size={15} /> Clipboard
            </TabLink>
          </nav>

          {client ? (
            <>
              {tab === "chat" && <ChatPanel client={client} state={state} />}
              {tab === "files" && (
                <FilesPanel
                  client={client}
                  state={state}
                  q={search.q ?? ""}
                  sort={search.sort ?? "recent"}
                  onQ={(q) => setSearch({ q })}
                  onSort={(sort) => setSearch({ sort })}
                />
              )}
              {tab === "clipboard" && (
                <ClipboardPanel client={client} state={state} isSecure={isSecure} />
              )}
            </>
          ) : (
            <div className="panel empty">Connecting…</div>
          )}
        </main>
      </div>

      {dragDepth > 0 && (
        <div className="drop-overlay" aria-hidden="true">
          <div>
            <strong>Drop to send</strong>
            <span>
              {tab === "clipboard"
                ? "lands in the clipboard feed"
                : "straight to every connected peer"}
            </span>
          </div>
        </div>
      )}

      <Toasts toasts={state.toasts} />
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function TabLink({
  roomId,
  tab,
  active,
  children,
}: {
  roomId: string;
  tab: "chat" | "files" | "clipboard";
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      to="/r/$roomId"
      params={{ roomId }}
      search={(prev) => ({ ...prev, tab })}
      replace
      className={`tab ${active ? "tab-active" : ""}`}
    >
      {children}
    </Link>
  );
}

function RoomPending() {
  return (
    <div className="page room">
      <div className="skeleton skeleton-bar" />
      <div className="room-body">
        <div className="skeleton skeleton-side" />
        <div className="skeleton skeleton-main" />
      </div>
    </div>
  );
}

function RoomError({ error }: ErrorComponentProps) {
  return (
    <div className="page narrow center-v">
      <div className="panel notfound">
        <h2>Can’t open this room</h2>
        <p className="muted">{errorMessage(error)}</p>
        <Link to="/" className="btn btn-primary">
          Back home
        </Link>
      </div>
    </div>
  );
}
