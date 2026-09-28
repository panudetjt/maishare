// LAN probe backoff policy (pure) — the self-inflicted discovery flood fix:
// a failing room must be re-probed on an exponential ladder, go dormant after
// repeated failures, and reset immediately when its roster changes.
import { describe, expect, it } from "vite-plus/test";
import {
  DORMANT_RETRY_MS,
  FAIL_GIVE_UP,
  FAIL_LADDER_MS,
  VERIFY_TTL,
  freshProbeState,
  mayProbe,
  onProbeResult,
  roomIdentity,
  syncProbeIdentity,
} from "./lan-probe-backoff";

const T0 = 1_000_000;

describe("probe backoff policy", () => {
  it("re-probes a verified room only after VERIFY_TTL", () => {
    const st = freshProbeState("2|a,b");
    onProbeResult(st, true, T0);
    expect(mayProbe(st, T0, T0 + VERIFY_TTL - 1)).toBe(false);
    expect(mayProbe(st, T0, T0 + VERIFY_TTL)).toBe(true);
  });

  it("backs off exponentially per consecutive failure", () => {
    const st = freshProbeState("2|a,b");
    onProbeResult(st, false, T0); // 1st failure
    expect(mayProbe(st, 0, T0 + FAIL_LADDER_MS[0] - 1)).toBe(false);
    expect(mayProbe(st, 0, T0 + FAIL_LADDER_MS[0])).toBe(true);

    onProbeResult(st, false, T0 + FAIL_LADDER_MS[0]); // 2nd failure
    expect(mayProbe(st, 0, T0 + FAIL_LADDER_MS[0] + FAIL_LADDER_MS[1] - 1)).toBe(false);
    expect(mayProbe(st, 0, T0 + FAIL_LADDER_MS[0] + FAIL_LADDER_MS[1])).toBe(true);
  });

  it("goes dormant after FAIL_GIVE_UP failures and stays there while failing", () => {
    const st = freshProbeState("2|a,b");
    for (let i = 0; i < FAIL_GIVE_UP; i++) onProbeResult(st, false, T0);
    // dormant: no probe until the long cool-down passes
    expect(mayProbe(st, 0, T0 + DORMANT_RETRY_MS - 1)).toBe(false);
    expect(mayProbe(st, 0, T0 + DORMANT_RETRY_MS)).toBe(true);

    // and it re-dormants after the next failure (streak keeps growing)
    onProbeResult(st, false, T0 + DORMANT_RETRY_MS);
    expect(mayProbe(st, 0, T0 + DORMANT_RETRY_MS * 2 - 1)).toBe(false);
    expect(mayProbe(st, 0, T0 + DORMANT_RETRY_MS * 2)).toBe(true);
  });

  it("resets the streak when the roster identity changes", () => {
    const st = freshProbeState("2|a,b");
    for (let i = 0; i < FAIL_GIVE_UP - 1; i++) onProbeResult(st, false, T0);
    expect(st.streak).toBe(FAIL_GIVE_UP - 1);

    // someone joined — the room is worth probing again right now
    const reset = syncProbeIdentity(st, roomIdentity(3, ["a", "b", "c"]));
    expect(reset.streak).toBe(0);
    expect(reset.nextAttemptAt).toBe(0);
    expect(mayProbe(reset, 0, T0 + 1)).toBe(true);
  });

  it("keeps the state object when the identity is unchanged", () => {
    const st = freshProbeState("2|a,b");
    onProbeResult(st, false, T0);
    expect(syncProbeIdentity(st, "2|a,b")).toBe(st);
  });

  it("fingerprint distinguishes people counts, names and id-only rooms", () => {
    expect(roomIdentity(2, ["a"])).not.toBe(roomIdentity(3, ["a"]));
    expect(roomIdentity(2, ["a"])).not.toBe(roomIdentity(2, ["a", "b"]));
    expect(roomIdentity()).toBe(roomIdentity()); // id-only: constant fingerprint
    expect(roomIdentity()).not.toBe(roomIdentity(2, ["a"]));
  });
});
