import { useEffect, useRef } from "react";
import type { RoomState } from "../lib/p2p/room-client";
import { PeerList } from "./PeerList";
import { XIcon } from "./Icons";

/** the peer roster as a bottom sheet. The sidebar PeerList is hidden on
 * narrow viewports (≤900px), and the peers chip in the conversation header
 * opens this so a phone can still see who is in the room. */
export function RosterSheet({ state, onClose }: { state: RoomState; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="roster-backdrop" onClick={onClose}>
      <div
        className="roster-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="People in this room"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          ref={closeRef}
          className="roster-close btn-icon"
          onClick={onClose}
          aria-label="Close"
        >
          <XIcon size={16} />
        </button>
        <PeerList state={state} />
      </div>
    </div>
  );
}
