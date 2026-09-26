import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { QrScanner } from "./QrScanner";
import { ArrowDown, ArrowUp, CopyIcon, DownloadIcon, FileIcon, QrIcon, XIcon } from "./Icons";
import { formatBytes, formatSpeed } from "../lib/format";
import { loadName } from "../lib/device";
import { NearbySession, type NearbyState } from "../lib/nearby/session";

/**
 * The nearby-share flow, embedded in the home page: a QR handshake (or
 * paste-code) bootstraps a host-only WebRTC connection, then files transfer
 * device-to-device with the room wire protocol. No server, works offline.
 */
export function NearbyShare({ onClose }: { onClose: () => void }) {
  const [session, setSession] = useState<NearbySession | null>(null);
  const [mode, setMode] = useState<"pick" | "scan">("pick");
  const [offerCode, setOfferCode] = useState("");
  const [answerCode, setAnswerCode] = useState("");
  const [qrSrc, setQrSrc] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const idle = useMemo<NearbyState>(
    () => ({ phase: "idle", selfName: loadName(), peerName: "", transfers: [] }),
    [],
  );
  const subscribe = useCallback(
    (cb: () => void) => (session ? session.subscribe(cb) : () => {}),
    [session],
  );
  const getSnapshot = useCallback(() => session?.getSnapshot() ?? idle, [session, idle]);
  const state = useSyncExternalStore(subscribe, getSnapshot);

  const selfName = idle.selfName;
  const showCode = offerCode || answerCode;

  // dispose the live session when the flow is collapsed or the page unmounts
  const sessionRef = useRef<NearbySession | null>(null);
  sessionRef.current = session;
  useEffect(() => () => sessionRef.current?.dispose(), []);

  // QR images are generated lazily whenever a share code appears
  useEffect(() => {
    if (!showCode) {
      setQrSrc("");
      return;
    }
    let alive = true;
    void import("qrcode")
      .then((mod) =>
        mod.default.toDataURL(showCode, {
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
  }, [showCode]);

  async function startShare() {
    setError("");
    setBusy(true);
    const s = new NearbySession(selfName);
    try {
      const code = await s.createOffer();
      setSession(s);
      setOfferCode(code);
    } catch (err) {
      s.dispose();
      setError(err instanceof Error ? err.message : "Could not start the share.");
    } finally {
      setBusy(false);
    }
  }

  async function onOfferScanned(code: string) {
    setError("");
    setBusy(true);
    const s = new NearbySession(selfName);
    try {
      const answer = await s.acceptOffer(code);
      setSession(s);
      setAnswerCode(answer);
    } catch (err) {
      s.dispose();
      setError(err instanceof Error ? err.message : "That code didn't work.");
    } finally {
      setBusy(false);
    }
  }

  async function onAnswerScanned(code: string) {
    if (!session) return;
    setError("");
    setBusy(true);
    try {
      await session.acceptAnswer(code);
      setAnswerCode("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "That code didn't work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="nearby-flow">
      {state.phase === "idle" && mode === "pick" ? (
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
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      ) : null}

      {state.phase === "idle" && mode === "scan" ? (
        <div className="nearby-step">
          <h3>Scan the other device's code</h3>
          <QrScanner onResult={onOfferScanned} hint="Point the camera at their QR code." />
          {error && <p className="notice">{error}</p>}
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      ) : null}

      {state.phase === "offer-ready" ? (
        <div className="nearby-cols">
          <div className="nearby-step">
            <h3>1 · Show this to the other device</h3>
            <QrImage src={qrSrc} code={offerCode} />
          </div>
          <div className="nearby-step">
            <h3>2 · Scan (or paste) their reply</h3>
            <QrScanner
              onResult={onAnswerScanned}
              hint="Their reply code appears after they scan yours."
            />
            {error && <p className="notice">{error}</p>}
            <button className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {state.phase === "answer-ready" ? (
        <div className="nearby-step">
          <h3>Show this reply code back</h3>
          <QrImage src={qrSrc} code={answerCode} />
          <p className="muted small">waiting for them to scan…</p>
        </div>
      ) : null}

      {state.phase === "connecting" ? <p className="muted">Connecting directly…</p> : null}

      {state.phase === "open" ? (
        <div className="nearby-open-flow">
          <div className="nearby-connected">
            <span className="dot dot-ok" aria-hidden="true" />
            <span>
              Connected to <strong>{state.peerName}</strong>
            </span>
            <button className="btn btn-sm" onClick={onClose}>
              End
            </button>
          </div>
          <label className="field">
            <span>Pick files to send — they transfer straight to {state.peerName}</span>
            <input
              type="file"
              multiple
              aria-label="Choose files to send"
              onChange={(e) => {
                if (e.target.files?.length && session) session.sendFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
          {state.transfers.length > 0 ? (
            <ul className="nb-list">
              {state.transfers.map((t) => (
                <li key={t.id} className={`nb-transfer ${t.status === "done" ? "nb-done" : ""}`}>
                  <span className="nb-dir">{t.dir === "in" ? <ArrowDown /> : <ArrowUp />}</span>
                  <span className="nb-info">
                    <span className="nb-name">
                      <FileIcon size={13} /> {t.name}
                    </span>
                    <span className="nb-bar" aria-hidden="true">
                      <i
                        style={{
                          width: `${t.size ? Math.min(100, (t.bytes / t.size) * 100) : 0}%`,
                        }}
                      />
                    </span>
                    <span className="muted small">
                      {t.status === "done"
                        ? `${formatBytes(t.size)} · done`
                        : `${formatBytes(t.bytes)} / ${formatBytes(t.size)}${
                            t.speed > 0 ? ` · ${formatSpeed(t.speed)}` : ""
                          }`}
                    </span>
                  </span>
                  {t.status === "done" && t.dir === "in" && t.blobUrl ? (
                    <a
                      className="btn-icon"
                      href={t.blobUrl}
                      download={t.name}
                      aria-label={`Save ${t.name}`}
                    >
                      <DownloadIcon size={15} />
                    </a>
                  ) : null}
                  {t.status === "active" || t.status === "queued" ? (
                    <button
                      className="btn-icon"
                      aria-label={`Cancel ${t.name}`}
                      onClick={() => session?.cancelTransfer(t.id)}
                    >
                      <XIcon size={14} />
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">
              Transfers run directly between the two devices — nothing passes through any server.
            </p>
          )}
        </div>
      ) : null}

      {state.phase === "closed" ? (
        <div className="nearby-step">
          <p className="notice">The other device disconnected.</p>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      ) : null}
    </div>
  );
}

function QrImage({ src, code }: { src: string; code: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // insecure-context fallback: the code is fully visible below
    }
  }
  return (
    <div className="nearby-handoff">
      {src ? (
        <img className="qr-img" src={src} alt="Share code QR" width={240} height={240} />
      ) : (
        <div className="qr-img qr-placeholder" />
      )}
      <code className="nearby-code">{code}</code>
      <button className="btn btn-sm" onClick={copy}>
        <CopyIcon size={14} /> {copied ? "Copied!" : "Copy code"}
      </button>
    </div>
  );
}
