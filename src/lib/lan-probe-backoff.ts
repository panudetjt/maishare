// Probe-backoff policy for LAN room discovery (pure, unit-tested): a room
// that is discoverable but not host-only-reachable used to be re-probed every
// poll tick (5 s) by every open home page — a silent self-inflicted flood of
// signaling relay requests (measured ~130k DO requests/day from forgotten
// tabs). The policy: exponential backoff per consecutive failure, a dormant
// state after repeated failures, and an immediate reset when the room's
// roster changes — a roster change is a real signal that someone is there.

/** a verified room is re-probed this often to keep verification fresh */
export const VERIFY_TTL = 60_000;
/** backoff after the 1st, 2nd, 3rd… consecutive failure (capped at the last) */
export const FAIL_LADDER_MS = [60_000, 300_000, 900_000] as const;
/** consecutive failures before the room goes dormant (stop probing) */
export const FAIL_GIVE_UP = 3;
/** a dormant room is given one more chance after this long — the only reset
 * path for id-only rooms whose roster the discovery API withholds */
export const DORMANT_RETRY_MS = 1_800_000;

export interface ProbeBackoffState {
  /** consecutive failed verifications for the current roster identity */
  streak: number;
  /** earliest wall-clock ms (Date.now) the next probe may start */
  nextAttemptAt: number;
  /** discover-entry fingerprint this state belongs to */
  identity: string;
}

/** fingerprint of the discovery entry — people count + names (id-only rooms
 * have neither, so their identity never changes) */
export function roomIdentity(people?: number, names?: string[]): string {
  return `${people ?? ""}|${(names ?? []).join(",")}`;
}

export function freshProbeState(identity: string): ProbeBackoffState {
  return { streak: 0, nextAttemptAt: 0, identity };
}

/** a roster change resets the failure streak: the room just proved someone
 * new is live, so the next probe is worth firing immediately */
export function syncProbeIdentity(state: ProbeBackoffState, identity: string): ProbeBackoffState {
  if (state.identity === identity) return state;
  return freshProbeState(identity);
}

/** may a probe for this room start now? `verifiedAt` is the last successful
 * verification (0 = never/failed) */
export function mayProbe(
  state: ProbeBackoffState | undefined,
  verifiedAt: number,
  now: number,
): boolean {
  if (now - verifiedAt < VERIFY_TTL) return false;
  if (!state) return true;
  return now >= state.nextAttemptAt;
}

/** record a probe outcome, mutating the state in place */
export function onProbeResult(state: ProbeBackoffState, ok: boolean, now: number): void {
  if (ok) {
    state.streak = 0;
    state.nextAttemptAt = 0;
    return;
  }
  state.streak += 1;
  if (state.streak >= FAIL_GIVE_UP) {
    // dormant: stop probing until the roster changes or the cool-down passes
    state.nextAttemptAt = now + DORMANT_RETRY_MS;
  } else {
    const step = Math.min(state.streak, FAIL_LADDER_MS.length) - 1;
    state.nextAttemptAt = now + FAIL_LADDER_MS[step];
  }
}
