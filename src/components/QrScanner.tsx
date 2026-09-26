import { useEffect, useRef, useState } from "react";
import { QrIcon } from "./Icons";

/**
 * Camera QR scanner with a manual paste fallback (no camera, permission
 * denied, or desktop). Decoding uses jsQR, loaded lazily; the video stream is
 * fully stopped when a code is found or the component unmounts.
 */
export function QrScanner({ onResult, hint }: { onResult: (code: string) => void; hint?: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  const [error, setError] = useState("");
  const [manual, setManual] = useState("");
  const [found, setFound] = useState(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let cancelled = false;

    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return;
        const { default: jsQR } = await import("jsqr");
        const tick = () => {
          if (cancelled || !video.videoWidth) {
            raf = requestAnimationFrame(tick);
            return;
          }
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(img.data, img.width, img.height);
          if (code?.data) {
            setFound(true);
            onResultRef.current(code.data);
            return;
          }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof DOMException && err.name === "NotAllowedError"
              ? "Camera access was denied."
              : "No camera available — paste the share code below instead.",
          );
        }
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div className="qr-scanner">
      <div className="qr-video-wrap">
        <video ref={videoRef} muted playsInline className="qr-video" />
        {found && <div className="qr-found">code captured ✓</div>}
      </div>
      {error && <p className="notice">{error}</p>}
      {hint && <p className="muted small">{hint}</p>}
      <form
        className="join-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (manual.trim()) onResultRef.current(manual.trim());
        }}
      >
        <input
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          placeholder="…or paste a share code (ms1z.…)"
          aria-label="Paste a share code"
        />
        <button type="submit" className="btn" disabled={!manual.trim()}>
          <QrIcon size={14} /> Use code
        </button>
      </form>
    </div>
  );
}
