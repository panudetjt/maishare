import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { SlideData } from "photoswipe";
import PhotoSwipeLightbox from "photoswipe/lightbox";
import "photoswipe/style.css";
import type { RoomClient, RoomState, TransferView } from "../lib/p2p/room-client";
import { buildTimeline, dayLabel, type TimelineMessage } from "../lib/timeline";
import { withDetectedExtension, type SniffInfo } from "../lib/magika";
import { codeLanguage, highlightCode, isCodeText } from "../lib/highlight";
import { formatBytes, formatClock, formatSpeed } from "../lib/format";
import {
  ArrowDown,
  ArrowUp,
  ArchiveIcon,
  AudioIcon,
  ChatIcon,
  CodeIcon,
  CopyIcon,
  DownloadIcon,
  FileIcon,
  ImageIcon,
  LockIcon,
  LockOpenIcon,
  Paperclip,
  RefreshIcon,
  SaveAllIcon,
  SendIcon,
  TrashIcon,
  VideoIcon,
  XIcon,
} from "./Icons";

/**
 * The single conversation surface: chat messages and file transfers rendered
 * as one chronological timeline with a Discord-style composer — attachments
 * wait in the composer and only go out when the message is sent. Both rooms
 * and nearby sessions render this exact component.
 *
 * Scroll behavior follows the chat-app playbook: stick to the bottom while the
 * user is there, never yank them back when they scroll up (a jump pill counts
 * what they missed), and keep the bottom pinned when content grows (images
 * loading, long texts expanding) via a ResizeObserver.
 */

/** longer than this (chars or lines) gets a collapsed bubble with "show more" */
const LONG_TEXT_CHARS = 600;
const LONG_TEXT_LINES = 14;
const COMPOSER_MAX_HEIGHT = 132;
/** composer cap in UTF-16 chars — texts past the chat-frame cap (8000) send
 * as an asText .txt instead; this stays under that path's 1 MiB byte ceiling
 * even for 3-byte-per-char Thai */
const COMPOSER_MAX_CHARS = 200_000;

/** a file queued in the composer, sent together with the next message */
export interface PendingFile {
  id: string;
  file: File;
}

// PhotoSwipe is driven programmatically (no DOM gallery): every open gets the
// full list of images from the tapped image's message group, so swiping walks
// exactly the attachments that were sent together.
let pswpLightbox: PhotoSwipeLightbox | null = null;
/** slides of the currently open gallery — the Save button reads from here by
 * index because currSlide can be mid-transition right after an arrow press */
let pswpDataSource: SlideData[] = [];

function triggerDownload(url: string, name: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** bundle files into one stored (uncompressed) zip — browsers throttle
 * multi-file downloads, a single archive sidesteps that (fflate loads lazily) */
async function zipBlobs(items: { name: string; blob: Blob }[], zipName: string) {
  const { zipSync } = await import("fflate");
  const entries: Record<string, Uint8Array> = {};
  const used = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    let name = items[i].name || `file-${i + 1}`;
    if (!/\.[a-z0-9]{2,5}$/i.test(name)) name += ".bin";
    let unique = name;
    let n = 2;
    while (used.has(unique)) {
      const dot = name.lastIndexOf(".");
      unique = dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
      n++;
    }
    used.add(unique);
    entries[unique] = new Uint8Array(await items[i].blob.arrayBuffer());
  }
  const zipped = zipSync(entries, { level: 0 });
  const url = URL.createObjectURL(new Blob([zipped], { type: "application/zip" }));
  triggerDownload(url, zipName);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** bundle every image of the open gallery into one zip archive */
async function downloadGalleryAsZip() {
  const items = pswpDataSource.filter((d) => d.src);
  if (!items.length) return;
  if (items.length === 1) {
    triggerDownload(items[0].src!, (items[0].alt as string) || "image");
    return;
  }
  const blobs = await Promise.all(
    items.map(async (d, i) => ({
      name: (d.alt as string) || `image-${i + 1}.png`,
      blob: await (await fetch(d.src!)).blob(),
    })),
  );
  await zipBlobs(blobs, "maishare-gallery.zip");
}

function getLightbox(): PhotoSwipeLightbox {
  if (!pswpLightbox) {
    pswpLightbox = new PhotoSwipeLightbox({
      pswpModule: () => import("photoswipe"),
      showHideAnimationType: "fade",
      bgOpacity: 0.94,
      wheelToZoom: true,
    });
    // thumbnails have no room for save affordances — the viewer carries them
    pswpLightbox.on("uiRegister", () => {
      const ui = pswpLightbox?.pswp?.ui;
      if (!ui) return;
      ui.registerElement({
        name: "save",
        order: 10,
        isButton: true,
        title: "Save image",
        html: '<svg class="pswp__icn" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g transform="translate(3.5 3.7) scale(0.65)"><path d="M10 3v9.5m0 0 3.8-3.8M10 12.5 6.2 8.7M4.5 16.5h11"/></g></svg>',
        onClick: () => {
          const idx = pswpLightbox?.pswp?.currIndex ?? -1;
          const item = pswpDataSource[idx];
          if (!item?.src) return;
          triggerDownload(item.src, (item.alt as string) || "image");
        },
      });
      if (pswpDataSource.length > 1) {
        ui.registerElement({
          name: "save-all",
          order: 9,
          isButton: true,
          title: "Save all — zip every image in this gallery",
          html: '<svg class="pswp__icn" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g transform="translate(3.5 4.3) scale(0.65)"><path d="M10 2v8m0 0 3.5-3.5M10 10 6.5 6.5"/><path d="M4.5 12h11"/><path d="M4.5 15.5h11"/></g></svg>',
          onClick: () => void downloadGalleryAsZip(),
        });
      }
    });
    pswpLightbox.init();
  }
  return pswpLightbox;
}

/** blob URLs are unique per transfer, so they work as element selectors */
function renderedSizeOf(blobUrl: string): SlideData {
  const img = document.querySelector<HTMLImageElement>(`img[src="${blobUrl}"]`);
  return {
    src: blobUrl,
    ...(img?.naturalWidth ? { width: img.naturalWidth, height: img.naturalHeight } : {}),
  };
}

/** icon by detected content group (Magika), falling back to the mime prefix
 * while the sniff hasn't landed yet */
function FileTypeIcon({ t, size = 20 }: { t: TransferView; size?: number }) {
  const g = t.detected?.group;
  if (g === "image" || (!g && t.mime.startsWith("image/"))) return <ImageIcon size={size} />;
  if (g === "video" || (!g && t.mime.startsWith("video/"))) return <VideoIcon size={size} />;
  if (g === "audio" || (!g && t.mime.startsWith("audio/"))) return <AudioIcon size={size} />;
  if (g === "archive") return <ArchiveIcon size={size} />;
  if (g === "code") return <CodeIcon size={size} />;
  return <FileIcon size={size} />;
}

export function Conversation({
  client,
  state,
  pending,
  onAttach,
  onDetach,
  onClearPending,
}: {
  client: RoomClient;
  state: RoomState;
  pending: PendingFile[];
  onAttach: (files: File[]) => void;
  onDetach: (id: string) => void;
  onClearPending: () => void;
}) {
  const messages = useMemo(() => buildTimeline(state), [state]);
  const [draft, setDraft] = useState("");
  const [newBelow, setNewBelow] = useState(0);
  const [scrolledUp, setScrolledUp] = useState(false);

  const logRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const stick = useRef(true);
  const lenRef = useRef(0);

  const openPeers = state.peers.filter((p) => p.status === "open").length;
  const canSend = draft.trim().length > 0 || pending.length > 0;

  const scrollToBottom = useCallback((smooth = false) => {
    const el = logRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  // follow the tail on new messages; count what the user missed while scrolled up
  useEffect(() => {
    const prev = lenRef.current;
    if (prev === messages.length) return;
    lenRef.current = messages.length;
    if (messages.length < prev) {
      stick.current = true;
      setNewBelow(0);
      setScrolledUp(false);
      scrollToBottom();
      return;
    }
    if (stick.current) scrollToBottom();
    else setNewBelow((n) => n + (messages.length - prev));
  }, [messages.length, scrollToBottom]);

  // keep the bottom pinned when existing content grows (image loads, "show
  // more", window resizes) — the classic chat-scroll edge case
  useEffect(() => {
    const el = logRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (stick.current) scrollToBottom();
    });
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [scrollToBottom]);

  // open PhotoSwipe over every image inside the tapped file's message —
  // attachments sent together swipe as one gallery
  const openGallery = useCallback(
    (t: TransferView) => {
      const msg = messages.find((m) => m.files.some((f) => f.id === t.id));
      const gallery = (msg?.files ?? []).filter((f) => f.mime.startsWith("image/") && f.blobUrl);
      const dataSource: SlideData[] = gallery.map((f) => ({
        alt: f.name,
        ...renderedSizeOf(f.blobUrl!),
      }));
      const index = Math.max(
        0,
        gallery.findIndex((f) => f.id === t.id),
      );
      pswpDataSource = dataSource;
      getLightbox().loadAndOpen(index, dataSource);
    },
    [messages],
  );

  const copyMessage = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        client.toast("Copied to your clipboard", "success");
        return;
      } catch {
        // insecure origins (plain http LAN addresses) block the async API —
        // fall back to the legacy selection copy, which still works there
      }
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      ta.remove();
      client.toast(
        ok ? "Copied to your clipboard" : "Copy failed on this origin",
        ok ? "success" : "error",
      );
    },
    [client],
  );

  // resending goes out as a fresh message to whoever is connected right now —
  // that covers both late joiners and transfers cancelled by mistake
  const resendMessage = useCallback(
    (m: TimelineMessage) => {
      // long texts arrived as asText .txt parts — fold their decoded text
      // back into the message body so sendMessage re-routes it (as a fresh
      // asText transfer once it again exceeds the chat-frame cap)
      const longTexts = m.files.filter((f) => f.asText && f.text != null).map((f) => f.text!);
      const text = [m.text ?? "", ...longTexts].filter(Boolean).join("\n\n");
      const files = m.files
        .filter((f) => f.blob && !f.asText)
        .map((f) => new File([f.blob!], f.name, { type: f.mime }));
      if (!text && !files.length) return;
      client.sendMessage(text, files);
      client.toast(
        files.length
          ? `Resending ${files.length} ${files.length === 1 ? "file" : "files"}`
          : "Resending message",
        "success",
      );
    },
    [client],
  );

  const saveAllAttachments = useCallback(
    async (m: TimelineMessage) => {
      const items = m.files
        .filter((f) => f.blob)
        .map((f) => ({ name: withDetectedExtension(f.name, f.detected), blob: f.blob! }));
      if (!items.length) return;
      await zipBlobs(items, "maishare-attachments.zip");
      client.toast(
        `Saved ${items.length} ${items.length === 1 ? "file" : "files"} as a zip`,
        "success",
      );
    },
    [client],
  );

  function onScroll() {
    const el = logRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stick.current = near;
    setScrolledUp(!near);
    if (near) setNewBelow(0);
  }

  function autosize() {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }

  // one Enter = one message: text and attached files go out as one group and
  // render inside a single bubble on every peer
  function submit() {
    const t = draft.trim();
    if (!t && !pending.length) return;
    client.sendMessage(
      t,
      pending.map((p) => p.file),
    );
    setDraft("");
    onClearPending();
    stick.current = true;
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) {
        ta.style.height = "auto";
        ta.focus();
      }
    });
  }

  function onComposerKey(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends, Shift+Enter is a newline — but never mid-IME-composition
    // (Thai input would otherwise send half-formed syllables)
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  function onComposerPaste(e: ReactClipboardEvent<HTMLTextAreaElement>) {
    // files/images pasted into the composer attach like Discord; plain text
    // keeps the browser default of landing in the draft
    const files = Array.from(e.clipboardData.files ?? []);
    if (files.length) {
      e.preventDefault();
      onAttach(files);
    }
  }

  function clearConversation() {
    client.clearChat();
    client.clearFinishedTransfers();
  }

  return (
    <div className="conv panel">
      <div className="panel-head conv-head">
        <span className={`badge ${state.encrypted ? "badge-ok" : ""}`}>
          <LockIcon size={12} /> {state.encrypted ? "end-to-end encrypted" : "dtls encrypted"}
        </span>
        <span className="stat" title="sent this session">
          <ArrowUp /> {formatBytes(state.sentTotal)}
        </span>
        <span className="stat" title="received this session">
          <ArrowDown /> {formatBytes(state.recvTotal)}
        </span>
        <span className="stat stat-peers" title="connected peers">
          {openPeers} peer{openPeers === 1 ? "" : "s"}
        </span>
        <span className="conv-head-spacer" />
        {messages.length > 0 && (
          <button className="btn btn-ghost btn-sm" onClick={clearConversation}>
            <TrashIcon size={14} /> Clear
          </button>
        )}
      </div>

      <div className="conv-log-wrap">
        <div
          className="conv-log"
          ref={logRef}
          onScroll={onScroll}
          role="log"
          aria-label="Conversation"
        >
          <div className="conv-inner">
            {messages.map((m) => (
              <Fragment key={m.id}>
                {m.firstOfDay && (
                  <div className="day-divider" role="separator">
                    <span>{dayLabel(m.at)}</span>
                  </div>
                )}
                <MessageBubble
                  message={m}
                  onOpenImage={openGallery}
                  onCancel={(id) => client.cancelTransfer(id)}
                  onCopy={copyMessage}
                  onResend={resendMessage}
                  onSaveAll={saveAllAttachments}
                />
              </Fragment>
            ))}
            {!messages.length && (
              <div className="empty">
                <ChatIcon size={28} />
                <p>
                  Messages and files land in this one timeline.
                  <br />
                  Drop files anywhere or hit the paperclip — they attach below and send when you
                  press Enter.
                </p>
              </div>
            )}
          </div>
        </div>
        {scrolledUp && (
          <button
            type="button"
            className="jump-pill"
            onClick={() => {
              stick.current = true;
              setNewBelow(0);
              scrollToBottom(true);
            }}
          >
            <ArrowDown size={14} />
            {newBelow > 0
              ? `${newBelow} new ${newBelow === 1 ? "message" : "messages"}`
              : "jump to latest"}
          </button>
        )}
      </div>

      <form
        className="conv-composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {pending.length > 0 && (
          <div className="attach-strip" aria-label="Attached files">
            {pending.map((pf) => (
              <AttachmentChip key={pf.id} pf={pf} onDetach={onDetach} />
            ))}
          </div>
        )}
        <div className="composer-row">
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files?.length) onAttach(Array.from(e.target.files));
              e.target.value = "";
            }}
          />
          <button
            type="button"
            className="btn-icon"
            onClick={() => fileRef.current?.click()}
            aria-label="Attach files"
            title="Attach files"
          >
            <Paperclip size={18} />
          </button>
          <textarea
            ref={taRef}
            rows={1}
            value={draft}
            maxLength={COMPOSER_MAX_CHARS}
            placeholder="Type a message"
            aria-label="Message"
            onChange={(e) => {
              setDraft(e.target.value);
              autosize();
            }}
            onKeyDown={onComposerKey}
            onPaste={onComposerPaste}
          />
          <button type="submit" className="btn btn-primary" disabled={!canSend} aria-label="Send">
            <SendIcon size={15} /> Send
          </button>
        </div>
      </form>
    </div>
  );
}

function AttachmentChip({ pf, onDetach }: { pf: PendingFile; onDetach: (id: string) => void }) {
  const isImage = pf.file.type.startsWith("image/");
  const url = useMemo(
    () => (isImage ? URL.createObjectURL(pf.file) : undefined),
    [isImage, pf.file],
  );
  useEffect(() => {
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [url]);
  return (
    <div className="attach-chip">
      {url ? (
        <img className="attach-thumb" src={url} alt="" />
      ) : (
        <span className="attach-icon">
          <FileIcon size={18} />
        </span>
      )}
      <span className="attach-info">
        <span className="attach-name" title={pf.file.name}>
          {pf.file.name}
        </span>
        <span className="attach-size">{formatBytes(pf.file.size)}</span>
      </span>
      <button
        type="button"
        className="btn-icon attach-x"
        onClick={() => onDetach(pf.id)}
        aria-label={`Remove ${pf.file.name}`}
        title="Remove"
      >
        <XIcon size={14} />
      </button>
    </div>
  );
}

function MessageBubble({
  message,
  onOpenImage,
  onCancel,
  onCopy,
  onResend,
  onSaveAll,
}: {
  message: TimelineMessage;
  onOpenImage: (t: TransferView) => void;
  onCancel: (id: string) => void;
  onCopy: (text: string) => void;
  onResend: (m: TimelineMessage) => void;
  onSaveAll: (m: TimelineMessage) => void;
}) {
  const sending = message.files.some((f) => f.status === "queued" || f.status === "active");
  const resending = !sending && message.files.some((f) => f.blob);
  const savable = message.files.filter((f) => f.blob);
  // caption + any long text that traveled as an asText part — one Copy grabs all
  const copyable = [
    ...(message.text != null ? [message.text] : []),
    ...message.files.filter((f) => f.asText && f.text != null).map((f) => f.text!),
  ].join("\n\n");
  return (
    <div className={`msg ${message.mine ? "msg-mine" : ""}`}>
      {message.firstOfGroup && (
        <div className="msg-head">
          <span className="msg-author">{message.mine ? "you" : message.peerName}</span>
          <span className="msg-time">{formatClock(message.at)}</span>
          {message.sealed !== undefined && !message.system && (
            <span
              className={`msg-lock ${message.sealed ? "is-sealed" : "is-open"}`}
              title={
                message.sealed
                  ? "Sealed with the room key — end-to-end encrypted"
                  : "Not end-to-end encrypted — traveled over DTLS only"
              }
            >
              {message.sealed ? <LockIcon size={12} /> : <LockOpenIcon size={12} />}
            </span>
          )}
          {message.unreadableBy && message.unreadableBy.length > 0 && (
            <span
              className="msg-lock msg-warn"
              title={`Not readable by ${message.unreadableBy.join(", ")} — they don't have the room key`}
            >
              ⚠
            </span>
          )}
        </div>
      )}
      <div className={`bubble ${message.system ? "bubble-system" : ""}`}>
        {message.text != null && (
          <TextPart text={message.text} detected={message.textDetected} onCopy={onCopy} />
        )}
        {message.files.length > 0 && (
          <div className="bubble-files">
            {message.files.map((f) =>
              // a long text that traveled as a .txt renders back as a text
              // part — until its bytes land there is no text, so it still
              // shows as an ordinary (progressing) file card
              f.asText && f.text != null ? (
                <TextPart key={f.id} text={f.text} detected={f.detected} onCopy={onCopy} />
              ) : f.mime.startsWith("image/") ? (
                <ImageCell key={f.id} t={f} onOpen={onOpenImage} onCancel={onCancel} />
              ) : (
                <FileRow key={f.id} t={f} onCancel={onCancel} />
              ),
            )}
          </div>
        )}
      </div>
      {!message.system && (
        <div className="msg-actions">
          {copyable && (
            <button
              type="button"
              onClick={() => onCopy(copyable)}
              aria-label="Copy message"
              title="Copy"
            >
              <CopyIcon size={14} />
            </button>
          )}
          {savable.length >= 2 && (
            <button
              type="button"
              onClick={() => onSaveAll(message)}
              aria-label="Save all attachments"
              title="Save all — zip every attachment"
            >
              <SaveAllIcon size={14} />
            </button>
          )}
          {resending && (
            <button
              type="button"
              onClick={() => onResend(message)}
              aria-label="Resend message"
              title="Resend — send the attachments again to everyone connected"
            >
              <RefreshIcon size={14} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function TextPart({
  text,
  detected,
  onCopy,
}: {
  text: string;
  detected?: SniffInfo;
  onCopy?: (text: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const huge = text.length > LONG_TEXT_CHARS || text.split("\n").length > LONG_TEXT_LINES;
  return (
    <div className={`bubble-text-part ${huge && !expanded ? "bubble-clamped" : ""}`}>
      {isCodeText(detected) ? (
        <CodeBlock text={text} detected={detected} onCopy={onCopy} />
      ) : (
        <div className="bubble-line">{text}</div>
      )}
      {huge && (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

/** code text rendered as a highlighted block — the grammar chunk loads on
 * demand, so the block starts as plain monospace and swaps once the
 * highlighted HTML lands (or stays plain if it never does) */
function CodeBlock({
  text,
  detected,
  onCopy,
}: {
  text: string;
  detected: SniffInfo;
  onCopy?: (text: string) => void;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const lang = codeLanguage(detected) ?? "code";
  useEffect(() => {
    let alive = true;
    void highlightCode(text, detected).then((value) => {
      if (alive && value) setHtml(value);
    });
    return () => {
      alive = false;
    };
  }, [text, detected]);
  return (
    <div className="bubble-code">
      <div className="bubble-code-head">
        <span className="bubble-code-lang">{lang}</span>
        {onCopy && (
          <button
            type="button"
            className="bubble-code-copy"
            onClick={() => onCopy(text)}
            aria-label="Copy code"
            title="Copy code"
          >
            <CopyIcon size={12} />
          </button>
        )}
      </div>
      <pre className="bubble-code-body">
        {/* hljs output is escaped — the only injected HTML is its own */}
        {html ? <code dangerouslySetInnerHTML={{ __html: html }} /> : <code>{text}</code>}
      </pre>
    </div>
  );
}

/** per-image circular transfer progress, drawn over the small thumbnail */
function ThumbRing({ pct, label }: { pct: number; label: string }) {
  const r = 24;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <span className="thumb-ring" aria-hidden="true">
      <svg viewBox="0 0 56 56">
        <circle className="ring-track" cx="28" cy="28" r={r} />
        <circle
          className="ring-bar"
          cx="28"
          cy="28"
          r={r}
          strokeDasharray={c}
          strokeDashoffset={c * (1 - clamped / 100)}
        />
      </svg>
      <span className="ring-label">{label}</span>
    </span>
  );
}

/** small square preview for image attachments; the ring carries live progress
 * and every transfer state gets a visible marker, tapping opens the viewer */
function ImageCell({
  t,
  onOpen,
  onCancel,
}: {
  t: TransferView;
  onOpen: (t: TransferView) => void;
  onCancel: (id: string) => void;
}) {
  const active = t.status === "active" || t.status === "queued";
  const pct = t.size > 0 ? Math.min(100, Math.round((t.bytes / t.size) * 100)) : 0;
  return (
    <div className="thumb-cell">
      {t.blobUrl ? (
        <button
          type="button"
          className={`bubble-img is-${t.status}`}
          onClick={() => onOpen(t)}
          title={`${t.name} — ${statusText(t)}`}
          aria-label={`Open ${t.name} (${statusText(t)})`}
        >
          <img className="thumb-img" src={t.blobUrl} alt={t.name} loading="lazy" />
          {active && <ThumbRing pct={pct} label={`${pct}%`} />}
          {t.status === "error" && (
            <span className="thumb-badge badge-error">
              <XIcon size={12} />
            </span>
          )}
          {t.status === "cancelled" && (
            <span className="thumb-badge badge-cancelled">
              <XIcon size={12} />
            </span>
          )}
          {t.status === "active" && t.speed > 0 && (
            <span className="thumb-status">{formatSpeed(t.speed)}</span>
          )}
          {t.status === "queued" && <span className="thumb-status">waiting…</span>}
        </button>
      ) : (
        /* incoming images have no blob until every chunk arrives */
        <div className={`bubble-img is-${t.status} thumb-placeholder`}>
          <ImageIcon size={20} />
          {active && <ThumbRing pct={pct} label={`${pct}%`} />}
          <span className="thumb-status">{statusText(t)}</span>
        </div>
      )}
      {active && (
        <button
          type="button"
          className="thumb-x"
          onClick={() => onCancel(t.id)}
          aria-label={`Cancel ${t.name}`}
          title="Cancel"
        >
          <XIcon size={11} />
        </button>
      )}
    </div>
  );
}

/** non-image attachments keep the classic row: icon, name, status, actions */
function FileRow({ t, onCancel }: { t: TransferView; onCancel: (id: string) => void }) {
  const active = t.status === "active" || t.status === "queued";
  const pct = t.size > 0 ? Math.min(100, Math.round((t.bytes / t.size) * 100)) : 0;
  return (
    <div className={`bubble-file transfer-${t.status}`}>
      <span className="bubble-file-icon">
        <FileTypeIcon t={t} />
      </span>
      <div className="bubble-file-main">
        <span className="bubble-file-name" title={t.name}>
          {t.name}
        </span>
        <span className="bubble-file-meta">
          {formatBytes(t.size)}
          {active
            ? ` · ${statusText(t)}${t.status === "active" ? ` · ${pct}%` : ""}${
                t.speed ? ` · ${formatSpeed(t.speed)}` : ""
              }`
            : ` · ${statusText(t)}`}
          {t.status === "done" && t.speed ? ` · ${formatSpeed(t.speed)} avg` : ""}
        </span>
        {active && (
          <div className="progress">
            <div className="progress-bar" style={{ width: `${pct}%` }} />
          </div>
        )}
        {/* the wire says delivered, but a peer reported the sealed bytes as
         * unreadable — never show a reassuring "sent" alone in that case */}
        {t.status === "done" && t.unreadableBy?.length && (
          <span
            className="bubble-file-warn"
            title={`Not readable by ${t.unreadableBy.join(", ")} — they don't have the room key`}
          >
            ⚠ unreadable to {t.unreadableBy.join(", ")}
          </span>
        )}
      </div>
      <span className="bubble-actions">
        {t.status === "done" && t.dir === "in" && t.blobUrl && (
          <a
            className="btn-icon"
            href={t.blobUrl}
            download={withDetectedExtension(t.name, t.detected)}
            aria-label={`Save ${t.name}`}
            title="Save"
          >
            <DownloadIcon size={15} />
          </a>
        )}
        {active && (
          <button
            type="button"
            className="btn-icon"
            onClick={() => onCancel(t.id)}
            aria-label={`Cancel ${t.name}`}
            title="Cancel"
          >
            <XIcon size={15} />
          </button>
        )}
      </span>
    </div>
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
      // inbound rows are queue previews from the sender's file-queued frame —
      // the point of the label is "this is not the end, more files are coming"
      return t.dir === "in" ? "in queue — more files coming" : "waiting for a peer…";
    default:
      return "sending";
  }
}
