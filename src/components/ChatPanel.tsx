import { useEffect, useRef, useState } from "react";
import type { RoomClient, RoomState } from "../lib/p2p/room-client";
import { formatClock } from "../lib/format";
import { LockIcon, SendIcon, TrashIcon } from "./Icons";

export function ChatPanel({ client, state }: { client: RoomClient; state: RoomState }) {
  const [text, setText] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [state.chats.length]);

  function onScroll() {
    const el = listRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }

  function submit() {
    if (!text.trim()) return;
    client.sendChat(text);
    setText("");
    stick.current = true;
  }

  return (
    <div className="chat panel">
      <div className="panel-head">
        <span className="badge badge-ok">
          <LockIcon size={12} /> end-to-end encrypted
        </span>
        <span className="muted small">{state.chats.length} messages</span>
        {state.chats.length > 0 && (
          <button className="btn btn-ghost btn-sm" onClick={() => client.clearChat()}>
            <TrashIcon size={14} /> Clear
          </button>
        )}
      </div>
      <div className="chat-log" ref={listRef} onScroll={onScroll}>
        {state.chats.map((m) => (
          <div key={m.id} className={`msg ${m.mine ? "msg-mine" : ""}`}>
            <div className="msg-head">
              <span className="msg-author">{m.mine ? "you" : m.name}</span>
              <span className="msg-time">{formatClock(m.at)}</span>
            </div>
            <div className="msg-body">{m.text}</div>
          </div>
        ))}
        {!state.chats.length && (
          <div className="empty">
            <LockIcon size={28} />
            <p>
              Messages travel straight to your peers over an encrypted data channel.
              <br />
              The server only ever saw the handshake.
            </p>
          </div>
        )}
      </div>
      <form
        className="chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type a message…"
          aria-label="Message"
          maxLength={8000}
        />
        <button type="submit" className="btn btn-primary" disabled={!text.trim()}>
          <SendIcon size={15} /> Send
        </button>
      </form>
    </div>
  );
}
