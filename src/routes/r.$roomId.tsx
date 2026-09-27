import { useEffect, useState } from "react";
import {
  createFileRoute,
  Link,
  useNavigate,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { z } from "zod";
import { useRoom } from "../lib/p2p/use-room";
import type { ConsentRequest } from "../lib/p2p/room-client";
import { loadName, saveName, uuid } from "../lib/device";
import { addRecent } from "../lib/recents";
import { Conversation, type PendingFile } from "../components/Conversation";
import { PeerList } from "../components/PeerList";
import { QrInvite } from "../components/QrInvite";
import { Toasts } from "../components/Toasts";
import { ArrowLeft, CopyIcon, LockIcon, LockOpenIcon, Logo, QrIcon } from "../components/Icons";

export const roomSearchSchema = z.object({
  k: z.string().min(4).max(200).optional().catch(undefined),
  name: z.string().trim().max(32).optional().catch(undefined),
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
    };
  },
  pendingComponent: RoomPending,
  errorComponent: RoomError,
  component: RoomRoute,
});

function RoomRoute() {
  const { roomId } = Route.useParams();
  const search = Route.useSearch();
  const { supported } = Route.useLoaderData();
  const navigate = useNavigate({ from: Route.fullPath });
  const [profileName] = useState(() => loadName());
  const name = search.name ?? profileName;
  const { client, state } = useRoom(roomId, search.k, name);
  const [showQr, setShowQr] = useState(false);
  const [dragDepth, setDragDepth] = useState(0);
  const [nameDraft, setNameDraft] = useState(name);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState<PendingFile[]>([]);

  const inviteUrl = `${location.origin}/r/${roomId}${search.k ? `?k=${encodeURIComponent(search.k)}` : ""}`;

  const setSearch = (patch: Partial<RoomSearch>) => {
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true });
  };

  // files dropped anywhere on the page wait in the composer like Discord
  const attach = (files: File[]) =>
    setPending((prev) => [...prev, ...files.map((file) => ({ id: uuid(), file }))]);

  useEffect(() => {
    addRecent({ roomId, k: search.k, at: Date.now() });
  }, [roomId, search.k]);

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
        if (e.dataTransfer.files.length) attach(Array.from(e.dataTransfer.files));
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
          {client ? (
            <Conversation
              client={client}
              state={state}
              pending={pending}
              onAttach={attach}
              onDetach={(id) => setPending((prev) => prev.filter((p) => p.id !== id))}
              onClearPending={() => setPending([])}
            />
          ) : (
            <div className="panel empty">Connecting…</div>
          )}
        </main>
      </div>

      {dragDepth > 0 && (
        <div className="drop-overlay" aria-hidden="true">
          <div>
            <strong>Drop to attach</strong>
            <span>files send with your next message</span>
          </div>
        </div>
      )}

      {client && state.consents[0] && (
        <ConsentGate
          req={state.consents[0]}
          onAnswer={(allow) => client.respondConsent(state.consents[0]!.peerId, allow)}
        />
      )}

      <Toasts toasts={state.toasts} />
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Blocking consent gate (SEC-01): shown once per peer that cannot prove room
 * key possession (no crypto.subtle). Nothing flows to that peer as plaintext
 * until the user explicitly downgrades — refusing keeps their payloads hidden.
 */
function ConsentGate({
  req,
  onAnswer,
}: {
  req: ConsentRequest;
  onAnswer: (allow: boolean) => void;
}) {
  return (
    <div className="consent-overlay">
      <div
        className="consent-panel panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="consent-title"
      >
        <span className="consent-icon" aria-hidden="true">
          <LockOpenIcon size={22} />
        </span>
        <h2 id="consent-title">{req.name} couldn’t prove the room key</h2>
        <p>
          This device says it can’t do end-to-end encryption (no WebCrypto — typical for iOS over
          plain http). Sending to them unencrypted means anyone on the wire could read it.
        </p>
        <div className="consent-actions">
          <button className="btn" onClick={() => onAnswer(false)}>
            Keep hidden
          </button>
          <button
            className="btn btn-primary"
            onClick={() => onAnswer(true)}
            aria-label="Send without end-to-end encryption"
          >
            Send without end-to-end encryption
          </button>
        </div>
      </div>
    </div>
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
