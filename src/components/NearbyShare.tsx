import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { QrScanner } from "./QrScanner";
import { CopyIcon, QrIcon } from "./Icons";
import { loadName, uuid } from "../lib/device";
import { RoomClient, type RoomState } from "../lib/p2p/room-client";
import { DirectTransport } from "../lib/p2p/direct";
import { Conversation, type PendingFile } from "./Conversation";
import { PeerList } from "./PeerList";
import { Toasts } from "./Toasts";

/**
 * Nearby share on the home page: a QR handshake (or paste) plays the role of
 * the signaling server, feeding a normal RoomClient through a DirectTransport.
 * Once connected, the same conversation UI handles chat and file transfers —
 * the only difference from a room is how you join.
 */

const IDLE: RoomState = {
  roomId: "",
  selfId: "",
  selfName: "",
  encrypted: false,
  signalStatus: "connecting",
  addresses: [],
  peers: [],
  chats: [],
  transfers: [],
  toasts: [],
  consents: [],
  keyRequests: [],
  selfKey: null,
  hostId: null,
  keyShare: "host",
  kicked: false,
  sentTotal: 0,
  recvTotal: 0,
};

const noopSubscribe = () => () => {};

export function NearbyShare({ onClose }: { onClose: () => void }) {
  const [session, setSession] = useState<{ client: RoomClient; transport: DirectTransport } | null>(
    null,
  );
  const [mode, setMode] = useState<"pick" | "scan">("pick");
  const [code, setCode] = useState("");
  const [qrSrc, setQrSrc] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<PendingFile[]>([]);

  // files dropped anywhere on the flow wait in the composer like Discord
  const attach = (files: File[]) =>
    setPending((prev) => [...prev, ...files.map((file) => ({ id: uuid(), file }))]);

  const idle = useMemo<RoomState>(() => ({ ...IDLE, selfName: loadName() }), []);
  const subscribe = useCallback(
    (cb: () => void) => (session ? session.client.subscribe(cb) : noopSubscribe()),
    [session],
  );
  const getSnapshot = useCallback(() => session?.client.getSnapshot() ?? idle, [session, idle]);
  const state = useSyncExternalStore(subscribe, getSnapshot);

  const selfName = idle.selfName;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  useEffect(() => () => sessionRef.current?.client.dispose(), []);

  // QR image for the current share code
  useEffect(() => {
    if (!code) {
      setQrSrc("");
      return;
    }
    let alive = true;
    void import("qrcode")
      .then((mod) =>
        mod.default.toDataURL(code, {
          errorCorrectionLevel: "L",
          margin: 1,
          width: 280,
          color: { dark: "#0b0d12", light: "#ffffff" },
        }),
      )
      .then((src) => {
        if (alive) setQrSrc(src);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [code]);

  function close() {
    sessionRef.current?.client.dispose();
    onClose();
  }

  function startShare() {
    setError("");
    setBusy(true);
    const transport = new DirectTransport({ role: "initiator", name: selfName });
    const client = new RoomClient({
      roomId: "direct",
      name: selfName,
      transport,
      gatherSdp: true,
      iceServers: [],
      initiator: true,
    });
    setSession({ client, transport });
    // listen for the offer before the client starts negotiating
    void transport
      .offerCode()
      .then((c) => setCode(c))
      .catch(() => setError("Could not start the share."))
      .finally(() => setBusy(false));
    void client.start();
  }

  async function onOfferScanned(raw: string) {
    setError("");
    setBusy(true);
    try {
      const transport = new DirectTransport({ role: "responder", name: selfName });
      const client = new RoomClient({
        roomId: "direct",
        name: selfName,
        transport,
        gatherSdp: true,
        iceServers: [],
        initiator: false,
      });
      setSession({ client, transport });
      void client.start();
      setCode(await transport.acceptOffer(raw));
    } catch (err) {
      sessionRef.current?.client.dispose();
      setSession(null);
      setError(err instanceof Error ? err.message : "That code didn't work.");
    } finally {
      setBusy(false);
    }
  }

  async function onAnswerScanned(raw: string) {
    if (!session) return;
    setError("");
    setBusy(true);
    try {
      await session.transport.acceptAnswer(raw);
      setCode("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "That code didn't work.");
    } finally {
      setBusy(false);
    }
  }

  const peer = state.peers[0];
  const connected = peer?.status === "open";
  const isInitiator = session?.transport.role === "initiator";

  return (
    <div className="nearby-flow">
      {!session ? (
        <>
          {mode === "pick" ? (
            <div className="nearby-actions">
              <button className="btn btn-primary btn-lg" onClick={startShare} disabled={busy}>
                <QrIcon size={17} /> Send to a nearby device
              </button>
              <button
                className="btn btn-lg"
                onClick={() => {
                  setError("");
                  setMode("scan");
                }}
                disabled={busy}
              >
                <QrIcon size={17} /> Scan a share code
              </button>
              <button className="btn btn-ghost" onClick={close}>
                Cancel
              </button>
            </div>
          ) : null}
          {mode === "scan" ? (
            <div className="nearby-step">
              <h3>Scan the other device's code</h3>
              <QrScanner onResult={onOfferScanned} hint="Point the camera at their QR code." />
              {error && <p className="notice">{error}</p>}
              <button className="btn btn-ghost" onClick={close}>
                Cancel
              </button>
            </div>
          ) : null}
        </>
      ) : null}

      {session && !connected ? (
        <div className="nearby-handoff-row">
          {code ? (
            <div className="nearby-step">
              <h3>
                {isInitiator ? "1 · Show this to the other device" : "Show this reply code back"}
              </h3>
              <div className="nearby-handoff">
                {qrSrc ? (
                  <img
                    className="qr-img"
                    src={qrSrc}
                    alt="Share code QR"
                    width={240}
                    height={240}
                  />
                ) : (
                  <div className="qr-img qr-placeholder" />
                )}
                <code className="nearby-code">{code}</code>
                <CopyCode code={code} />
              </div>
            </div>
          ) : null}
          {isInitiator ? (
            <div className="nearby-step">
              <h3>{code ? "2 · Scan (or paste) their reply" : "Preparing your code…"}</h3>
              {code ? (
                <QrScanner
                  onResult={onAnswerScanned}
                  hint="Their reply code appears after they scan yours."
                />
              ) : null}
            </div>
          ) : (
            <p className="muted small">waiting for them to scan…</p>
          )}
          {error && <p className="notice">{error}</p>}
          <button className="btn btn-ghost" onClick={close}>
            Cancel
          </button>
        </div>
      ) : null}

      {session && connected ? (
        <div
          className="room-body nearby-room"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (e.dataTransfer.files.length) attach(Array.from(e.dataTransfer.files));
          }}
        >
          <PeerList state={state} />
          <main className="room-main">
            <div className="nearby-connected">
              <span className="dot dot-ok" aria-hidden="true" />
              <span>
                Connected to <strong>{peer.name}</strong>
              </span>
              <span className="muted small">direct · host-only · no server</span>
              <button className="btn btn-sm" onClick={close}>
                End
              </button>
            </div>
            <Conversation
              client={session.client}
              state={state}
              pending={pending}
              onAttach={attach}
              onDetach={(id) => setPending((prev) => prev.filter((p) => p.id !== id))}
              onClearPending={() => setPending([])}
            />
          </main>
        </div>
      ) : null}

      {session ? <Toasts toasts={state.toasts} /> : null}
    </div>
  );
}

function CopyCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // insecure-context fallback: the code is fully visible above
    }
  }
  return (
    <button className="btn btn-sm" onClick={copy}>
      <CopyIcon size={14} /> {copied ? "Copied!" : "Copy code"}
    </button>
  );
}
