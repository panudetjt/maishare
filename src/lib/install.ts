// PWA install offer. Chromium fires beforeinstallprompt when the app is
// installable (manifest + service worker + https) — we capture it so the UI
// can offer installation from our own button. iOS Safari never fires the
// event: there the button walks the user through Share → Add to Home Screen.
// The button hides itself once the app runs as installed (standalone).

export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export type InstallPlatform = "ios" | "other";

export interface InstallState {
  /** browser handed us the native install prompt */
  canPrompt: boolean;
  /** app already runs installed (standalone window / home-screen icon) */
  installed: boolean;
  /** iOS/iPadOS — no native prompt, needs the manual Share steps */
  ios: boolean;
}

// ---- pure helpers (unit-tested) ----

/** iOS/iPadOS detection, including iPadOS 13+ which poses as desktop Safari */
export function isIOSPlatform(ua: string, maxTouchPoints = 0): boolean {
  if (/iphone|ipod|ipad/i.test(ua)) return true;
  return /macintosh/i.test(ua) && maxTouchPoints > 1;
}

/** running as an installed app rather than a browser tab */
export function isStandaloneDisplay(displayMode: string, navigatorStandalone?: boolean): boolean {
  if (navigatorStandalone === true) return true; // iOS home-screen web app
  return (
    displayMode === "standalone" || displayMode === "fullscreen" || displayMode === "minimal-ui"
  );
}

export function shouldOfferInstall(state: InstallState): boolean {
  if (state.installed) return false;
  return state.canPrompt || state.ios;
}

// ---- tiny external store (useSyncExternalStore, same pattern as RoomClient) ----

let state: InstallState = { canPrompt: false, installed: false, ios: false };
const listeners = new Set<() => void>();
let promptEvent: BeforeInstallPromptEvent | null = null;
let initialized = false;

function setState(patch: Partial<InstallState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

/** wire the browser events — call once at startup; no-op without a window */
export function initInstall(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  const mq = (q: string) => typeof matchMedia === "function" && matchMedia(q).matches;
  const displayMode =
    mq("(display-mode: standalone)") ||
    mq("(display-mode: fullscreen)") ||
    mq("(display-mode: minimal-ui)")
      ? "standalone"
      : "browser";
  state.ios = isIOSPlatform(navigator.userAgent, navigator.maxTouchPoints ?? 0);
  if (
    isStandaloneDisplay(displayMode, (navigator as Navigator & { standalone?: boolean }).standalone)
  ) {
    state.installed = true;
  }
  window.addEventListener("beforeinstallprompt", (e: Event) => {
    e.preventDefault();
    promptEvent = e as BeforeInstallPromptEvent;
    setState({ canPrompt: true });
  });
  window.addEventListener("appinstalled", () => {
    promptEvent = null;
    setState({ installed: true, canPrompt: false });
  });
}

export function subscribeInstall(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getInstallState(): InstallState {
  return state;
}

/** show the native install dialog from a user gesture; "unavailable" when no
 * prompt was captured (wrong browser, or iOS manual flow) */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const ev = promptEvent;
  if (!ev) return "unavailable";
  promptEvent = null;
  try {
    await ev.prompt();
    const { outcome } = await ev.userChoice;
    if (outcome === "accepted") setState({ installed: true, canPrompt: false });
    else setState({ canPrompt: false });
    return outcome;
  } catch {
    setState({ canPrompt: false });
    return "unavailable";
  }
}
