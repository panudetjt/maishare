export interface Recent {
  roomId: string;
  k?: string;
  at: number;
}

const KEY = "maishare.recents";
const MAX = 8;

export function loadRecents(): Recent[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as Recent[];
    return Array.isArray(list)
      ? list.filter((r) => r && typeof r.roomId === "string").slice(0, MAX)
      : [];
  } catch {
    return [];
  }
}

export function addRecent(r: Recent) {
  try {
    const stored = loadRecents();
    const list = stored.filter((x) => x.roomId !== r.roomId);
    // a keyless landing (bare LAN link, or a key-offer still pending) keeps
    // the key this device already holds — only a fresh invite replaces it
    const k = r.k ?? stored.find((x) => x.roomId === r.roomId)?.k;
    list.unshift(k ? { ...r, k } : r);
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {}
}

export function clearRecents() {
  try {
    localStorage.removeItem(KEY);
  } catch {}
}
