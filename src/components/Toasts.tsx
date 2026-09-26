import type { RoomState } from "../lib/p2p/room-client";

export function Toasts({ toasts }: { toasts: RoomState["toasts"] }) {
  if (!toasts.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          {t.kind === "error" ? "!" : t.kind === "success" ? "✓" : "ℹ"}
          <span>{t.msg}</span>
        </div>
      ))}
    </div>
  );
}
