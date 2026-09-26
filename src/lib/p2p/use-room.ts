import { useEffect, useState, useSyncExternalStore } from "react";
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
  clips: [],
  toasts: [],
  sentTotal: 0,
  recvTotal: 0,
};

const noopSubscribe = () => () => {};
const emptySnapshot = () => EMPTY;

export function useRoom(roomId: string, key: string | undefined, name: string) {
  const [client, setClient] = useState<RoomClient | null>(null);

  useEffect(() => {
    const c = new RoomClient({ roomId, key, name });
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
