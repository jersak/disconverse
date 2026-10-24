// Connected WebSocket clients, shared by the modules that push live updates.
import type { WebSocket } from "@fastify/websocket";
import type { ServerEvent, User } from "./types.ts";

export const sockets = new Map<WebSocket, User>();

export const hasClients = () => sockets.size > 0;

export function broadcast(event: ServerEvent) {
  const data = JSON.stringify(event);
  for (const ws of sockets.keys()) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

export const onlineUserIds = () => [...new Set(Array.from(sockets.values(), (u) => u.id))];
