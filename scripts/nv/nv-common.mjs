// Shared helpers for the NV (needs-validation) test scripts — see
// .scratch/security-remediation/nv-observations.md for what each script
// answers and where the results are recorded.
//
// Usage notes:
// - Staging scripts take the deploy URL via NV_BASE_URL (default: the
//   isolated staging worker deploy-staging.mjs creates).
// - Sockets use the `ws` package so an Origin header can be set (Node's
//   native WebSocket forbids it) — /ws is same-origin gated, so scripts
//   simulating the app's own clients send the deployment origin, while
//   NV-05 explicitly sends a foreign one to test the gate.
// - Every script prints a RESULT line that is copied verbatim into the
//   evidence log.

import WebSocket from "ws";

export const STAGING_BASE =
  process.env.NV_BASE_URL ?? "https://maishare-nv-staging.panudetjt.workers.dev";

/** websocket signaling URL for a base URL */
export function wsUrl(base) {
  return base.replace(/^http/, "ws") + "/ws";
}

/**
 * Open a signaling socket and resolve once the welcome arrives.
 * opts.origin overrides the Origin header (defaults to the deployment's own
 * origin — passes the same-origin gate; pass anything else to test the gate).
 */
export function join(base, { room, peer, name = "nv" }, { origin } = {}) {
  const wsOrigin = origin ?? new URL(base).origin;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsUrl(base)}?room=${room}&peer=${peer}&name=${name}`, {
      origin: wsOrigin,
    });
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new Error(`join timeout: ${room}/${peer}`));
    }, 15_000);
    ws.onerror = (err) => {
      clearTimeout(timer);
      reject(new Error(`ws error: ${room}/${peer} — ${err?.message ?? "unknown"}`));
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.t === "welcome") {
        clearTimeout(timer);
        resolve({ ws, welcome: msg, send: (o) => ws.send(JSON.stringify(o)) });
      }
    };
  });
}

/** close and wait for the close to flush (bounded — a hung close must not
 * hang the script) */
export function quit(ws) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState >= 2) return resolve();
    const timer = setTimeout(resolve, 3000);
    ws.onclose = () => {
      clearTimeout(timer);
      resolve();
    };
    try {
      ws.close();
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

export async function discover(base) {
  const res = await fetch(`${base}/api/discover`, { cache: "no-store" });
  if (!res.ok) throw new Error(`discover ${res.status}`);
  return (await res.json()).rooms ?? [];
}

export function percentile(values, p) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/** unique-ish room/peer ids for each run */
export function runId() {
  return Date.now().toString(36).slice(-6) + Math.random().toString(36).slice(2, 5);
}
