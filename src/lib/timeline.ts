// Merges the two room streams (chats, transfers) into chronological message
// units for the conversation UI. A message = optional text + the file batch
// attached to it: items sharing a groupId render as ONE bubble. Pure
// derivation — grouping/day decisions live here so they are testable
// without React.

import type { ChatMsg, RoomState, TransferView } from "./p2p/room-client";

/** consecutive messages from one author within this gap share a group */
export const GROUP_GAP_MS = 5 * 60 * 1000;

export interface TimelineMessage {
  /** stable across renders — the text's id when present, else the first file's */
  id: string;
  at: number;
  peerId: string;
  peerName: string;
  mine: boolean;
  dayKey: string;
  firstOfDay: boolean;
  firstOfGroup: boolean;
  text: string | null;
  files: TransferView[];
  /** arrived sealed with the room key (false = DTLS only, undefined = unknown) */
  sealed: boolean | undefined;
  /** unreadable-frame placeholder — render with the warning style, no actions */
  system: boolean;
}

export function dayKeyOf(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function startOfDay(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function dayLabel(at: number, now = Date.now()): string {
  const days = Math.round((startOfDay(at) - startOfDay(now)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === -1) return "Yesterday";
  const d = new Date(at);
  if (days > -7) {
    return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  }
  return d.toLocaleDateString(undefined, { dateStyle: "medium" });
}

interface Item {
  kind: "text" | "file";
  id: string;
  at: number;
  peerId: string;
  peerName: string;
  mine: boolean;
  text?: string;
  system?: boolean;
  sealed?: boolean;
  groupId?: string;
  transfer?: TransferView;
}

function collectItems(state: Pick<RoomState, "chats" | "transfers" | "selfId">): Item[] {
  const items: Item[] = [];
  for (const m of state.chats as ChatMsg[]) {
    items.push({
      kind: "text",
      id: m.id,
      at: m.at,
      peerId: m.peerId,
      peerName: m.name,
      mine: m.mine,
      text: m.text,
      system: m.system,
      sealed: m.sealed,
      groupId: m.groupId,
    });
  }
  // transfers are stored newest-first; flip so a stable sort keeps send order
  // for items that share a millisecond
  for (const t of [...state.transfers].reverse()) {
    items.push({
      kind: "file",
      id: t.id,
      at: t.at,
      peerId: t.peerId,
      peerName: t.peerName,
      mine: t.dir === "out",
      sealed: t.sealed,
      groupId: t.groupId,
      transfer: t,
    });
  }
  items.sort((a, b) => a.at - b.at);
  return items;
}

export function buildTimeline(
  state: Pick<RoomState, "chats" | "transfers" | "selfId">,
): TimelineMessage[] {
  const items = collectItems(state);

  // fold items into messages: everything with the same groupId is one message
  // (the text arrives instantly, files trickle in as they start transferring)
  const byGroup = new Map<string, Item[]>();
  const ordered: (Item | Item[])[] = [];
  for (const it of items) {
    if (!it.groupId) {
      ordered.push(it);
      continue;
    }
    let group = byGroup.get(it.groupId);
    if (!group) {
      group = [];
      byGroup.set(it.groupId, group);
      ordered.push(group);
    }
    group.push(it);
  }

  const messages: TimelineMessage[] = ordered.map((entry) => {
    const parts = Array.isArray(entry) ? entry : [entry];
    const text = parts.find((p) => p.kind === "text");
    const files = parts
      .filter((p): p is Item & { transfer: TransferView } => p.kind === "file")
      .map((p) => p.transfer)
      .sort((a, b) => a.at - b.at);
    const head = text ?? parts[0];
    return {
      id: head.id,
      at: Math.min(...parts.map((p) => p.at)),
      peerId: head.peerId,
      peerName: head.peerName,
      mine: head.mine,
      dayKey: "",
      firstOfDay: false,
      firstOfGroup: false,
      text: text?.text ?? null,
      files,
      // one truth per message: first part that actually knows wins (text and
      // file-starts carry the frame type they arrived as)
      sealed: parts.find((p) => p.sealed !== undefined)?.sealed,
      system: parts.some((p) => p.system),
    };
  });

  let prev: TimelineMessage | null = null;
  for (const m of messages) {
    m.dayKey = dayKeyOf(m.at);
    m.firstOfDay = !prev || prev.dayKey !== m.dayKey;
    m.firstOfGroup = m.firstOfDay || prev!.peerId !== m.peerId || m.at - prev!.at > GROUP_GAP_MS;
    prev = m;
  }
  return messages;
}
