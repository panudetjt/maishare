const ADJECTIVES = [
  "swift",
  "neon",
  "cosmic",
  "amber",
  "quiet",
  "brave",
  "lucky",
  "solar",
  "arctic",
  "rapid",
  "mellow",
  "crimson",
];
const NOUNS = [
  "falcon",
  "otter",
  "lynx",
  "heron",
  "panda",
  "koala",
  "tiger",
  "ibex",
  "orca",
  "bison",
  "quokka",
  "narwhal",
];

const NAME_KEY = "maishare.name";

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function generateName(): string {
  return `${pick(ADJECTIVES)} ${pick(NOUNS)}`;
}

export function loadName(): string {
  try {
    const v = localStorage.getItem(NAME_KEY);
    if (v) return v;
  } catch {}
  const n = generateName();
  saveName(n);
  return n;
}

export function saveName(n: string) {
  try {
    localStorage.setItem(NAME_KEY, n);
  } catch {}
}

export function platformLabel(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Macintosh/.test(ua)) return "macOS";
  if (/Windows/.test(ua)) return "Windows";
  if (/CrOS/.test(ua)) return "ChromeOS";
  if (/Linux/.test(ua)) return "Linux";
  return "Web";
}

const ROOM_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function makeRoomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => ROOM_ALPHABET[b % ROOM_ALPHABET.length]).join("");
}

export function makeRoomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * RFC4122 v4 UUID. `crypto.randomUUID` only exists in secure contexts
 * (HTTPS / localhost) — Safari over http://<lan-ip> doesn't expose it — so
 * fall back to building one from getRandomValues, which is always available.
 */
export function uuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return uuidFromRandomValues(c.getRandomValues(new Uint8Array(16)));
}

/** Build a v4 UUID string from 16 random bytes (version/variant bits set). */
export function uuidFromRandomValues(bytes: Uint8Array): string {
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
