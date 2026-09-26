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
    const list = loadRecents().filter((x) => x.roomId !== r.roomId);
    list.unshift(r);
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {}
}

export function clearRecents() {
  try {
    localStorage.removeItem(KEY);
  } catch {}
}
