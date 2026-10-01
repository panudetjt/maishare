import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { RoomClient, type RoomState } from "./room-client";

const EMPTY: RoomState = {
  roomId: "",
  selfId: "",
  selfName: "",
  encrypted: false,
  signalStatus: "connecting",
  addresses: [],
  peers: [],
  chats: [],
  transfers: [],
  toasts: [],
  consents: [],
  keyRequests: [],
  selfKey: null,
  hostId: null,
  keyShare: "host",
  kicked: false,
  sentTotal: 0,
  recvTotal: 0,
};

const noopSubscribe = () => () => {};
const emptySnapshot = () => EMPTY;

export function useRoom(
  roomId: string,
  key: string | undefined,
  name: string,
  keyShare?: "anyone",
) {
  const [client, setClient] = useState<RoomClient | null>(null);
  const clientRef = useRef<RoomClient | null>(null);

  useEffect(() => {
    // a router transient (the legacy ?k=→#k= migration replays this route
    // with the search already scrubbed and the hash not yet applied) can
    // remount here keyless — inherit the previous client's key for the room
    // so a keyed seat never silently demotes into a key-requesting one
    const effectiveKey = key ?? clientRef.current?.getSnapshot().selfKey ?? undefined;
    const c = new RoomClient({ roomId, key: effectiveKey, name, keyShare });
    clientRef.current = c;
    void c.start();
    setClient(c);
    return () => c.dispose();
    // name changes are applied via setName below, not by rebuilding the client
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, key]);

  useEffect(() => {
    if (client) client.setName(name);
  }, [client, name]);

  const state = useSyncExternalStore(
    client ? client.subscribe : noopSubscribe,
    client ? client.getSnapshot : emptySnapshot,
    emptySnapshot,
  );

  return { client, state };
}
