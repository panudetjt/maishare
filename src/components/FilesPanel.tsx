import { useMemo, useRef } from "react";
import type { RoomClient, RoomState, TransferView } from "../lib/p2p/room-client";
import type { RoomSearch } from "../routes/r.$roomId";
import { formatBytes, formatSpeed } from "../lib/format";
import {
  ArrowDown,
  ArrowUp,
  Bolt,
  DownloadIcon,
  FileIcon,
  ImageIcon,
  TrashIcon,
  XIcon,
} from "./Icons";

type SortKey = NonNullable<RoomSearch["sort"]>;

export function FilesPanel({
  client,
  state,
  q,
  sort,
  onQ,
  onSort,
}: {
  client: RoomClient;
  state: RoomState;
  q: string;
  sort: SortKey;
  onQ: (q: string) => void;
  onSort: (s: SortKey) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const openPeers = state.peers.filter((p) => p.status === "open").length;
  const finished = state.transfers.filter(
    (t) => t.status === "done" || t.status === "error" || t.status === "cancelled",
  );

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = state.transfers.filter((t) =>
      needle ? t.name.toLowerCase().includes(needle) : t.kind === "file",
    );
    switch (sort) {
      case "name":
        return [...list].sort((a, b) => a.name.localeCompare(b.name));
      case "size":
        return [...list].sort((a, b) => b.size - a.size);
      default:
        return list;
    }
  }, [state.transfers, q, sort]);

  return (
    <div className="files panel">
      <div className="stats-row">
        <span className="stat" title="sent this session">
          <ArrowUp /> {formatBytes(state.sentTotal)}
        </span>
        <span className="stat" title="received this session">
          <ArrowDown /> {formatBytes(state.recvTotal)}
        </span>
        <span className="stat" title="connected peers">
          <Bolt size={13} /> {openPeers} peer{openPeers === 1 ? "" : "s"}
        </span>
      </div>

      <div
        className="dropzone"
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && inputRef.current?.click()}
      >
        <Bolt size={22} />
        <strong>Drop files, paste, or click to choose</strong>
        <span className="muted">
          Chunked over an ordered data channel — straight to {openPeers || "every"} connected peer
          {openPeers === 1 ? "" : "s"}
        </span>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) client.sendFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      <div className="files-toolbar">
        <input
          className="filter-input"
          value={q}
          onChange={(e) => onQ(e.target.value)}
          placeholder="Filter by name…"
          aria-label="Filter transfers"
        />
        <select
          value={sort}
          onChange={(e) => onSort(e.target.value as SortKey)}
          aria-label="Sort transfers"
        >
          <option value="recent">Recent</option>
          <option value="name">Name</option>
          <option value="size">Size</option>
        </select>
        {finished.length > 0 && (
          <button className="btn btn-ghost btn-sm" onClick={() => client.clearFinishedTransfers()}>
            <TrashIcon size={14} /> Clear finished
          </button>
        )}
      </div>

      <ul className="transfer-list">
        {visible.map((t) => (
          <TransferRow key={t.id} t={t} onCancel={() => client.cancelTransfer(t.id)} />
        ))}
      </ul>
      {!visible.length && (
        <div className="empty">
          <FileIcon size={26} />
          <p>No file transfers yet. Anything you drop or paste lands here with live progress.</p>
        </div>
      )}
    </div>
  );
}

function TransferRow({ t, onCancel }: { t: TransferView; onCancel: () => void }) {
  const pct = t.size > 0 ? Math.min(100, Math.round((t.bytes / t.size) * 100)) : 0;
  const isImage = t.mime.startsWith("image/") && t.status === "done" && t.blobUrl;
  const active = t.status === "active" || t.status === "queued";
  return (
    <li className={`transfer transfer-${t.status}`}>
      <div className="transfer-icon">
        {isImage ? (
          <img src={t.blobUrl} alt="" />
        ) : t.mime.startsWith("image/") ? (
          <ImageIcon size={20} />
        ) : (
          <FileIcon size={20} />
        )}
      </div>
      <div className="transfer-main">
        <div className="transfer-title">
          <span className="transfer-name" title={t.name}>
            {t.name}
          </span>
          <span className="transfer-peer">
            {t.dir === "out" ? "→" : "←"} {t.peerName}
          </span>
        </div>
        {active ? (
          <>
            <div className="progress">
              <div className="progress-bar" style={{ width: `${pct}%` }} />
            </div>
            <div className="transfer-meta">
              {formatBytes(t.bytes)} / {formatBytes(t.size)} · {pct}%
              {t.speed ? ` · ${formatSpeed(t.speed)}` : ""}
            </div>
          </>
        ) : (
          <div className="transfer-meta">
            {formatBytes(t.size)} · {statusText(t)}
            {t.status === "done" && t.speed ? ` · ${formatSpeed(t.speed)} avg` : ""}
          </div>
        )}
      </div>
      <div className="transfer-actions">
        {t.status === "done" && t.dir === "in" && t.blobUrl && (
          <a className="btn btn-sm" href={t.blobUrl} download={t.name}>
            <DownloadIcon size={14} /> Save
          </a>
        )}
        {active && (
          <button
            className="btn-icon"
            onClick={onCancel}
            aria-label={`Cancel ${t.name}`}
            title="Cancel"
          >
            <XIcon size={15} />
          </button>
        )}
      </div>
    </li>
  );
}

function statusText(t: TransferView): string {
  switch (t.status) {
    case "done":
      return t.dir === "in" ? "received" : "sent";
    case "error":
      return "failed — peer disconnected";
    case "cancelled":
      return "cancelled";
    case "queued":
      return "queued";
    default:
      return "";
  }
}
