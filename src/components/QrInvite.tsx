import { useEffect, useState } from "react";
import { CopyIcon, XIcon } from "./Icons";

export function QrInvite({ url, onClose }: { url: string; onClose: () => void }) {
  const [src, setSrc] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    import("qrcode")
      .then((mod) =>
        mod.default.toDataURL(url, {
          margin: 1,
          width: 320,
          color: { dark: "#0b0d12", light: "#ffffff" },
        }),
      )
      .then((data) => {
        if (alive) setSrc(data);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [url]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  }

  return (
    <div className="qr-pop" role="dialog" aria-label="Invite via QR">
      <button className="qr-close btn-icon" onClick={onClose} aria-label="Close">
        <XIcon size={16} />
      </button>
      <h3>Scan to join</h3>
      <p className="muted">
        Same network, no account. The key in the link keeps it end-to-end encrypted.
      </p>
      {src ? (
        <img
          className="qr-img"
          src={src}
          alt="QR code with the room invite link"
          width={180}
          height={180}
        />
      ) : (
        <div className="qr-img qr-placeholder" />
      )}
      <code className="qr-url" onClick={copy} title="Click to copy">
        {url}
      </code>
      <button className="btn btn-primary btn-sm" onClick={copy}>
        <CopyIcon size={14} /> {copied ? "Copied!" : "Copy invite link"}
      </button>
    </div>
  );
}
