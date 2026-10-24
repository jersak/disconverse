import type { FastifyInstance } from "fastify";
import { requireUser, userFromRequest } from "./auth.ts";
import { getChannel, listChannels } from "./channels.ts";
import { config } from "./config.ts";
import { all, run, transaction } from "./db.ts";
import { broadcast, onlineUserIds, sockets } from "./hub.ts";
import { permissionsFor } from "./roles.ts";
import type { Message, ServerEvent, User } from "./types.ts";
import { toUser, userColumns, type UserRow } from "./users.ts";
import { attachToMessage, attachmentsFor, claimableUploads, MAX_ATTACHMENTS } from "./uploads.ts";
import { getVoiceState, pokeVoice } from "./voice.ts";

const PAGE_SIZE = 50;
const MAX_MESSAGE_LENGTH = 2000;
// Per-connection flood control: bursts of up to 5 messages, refilling one per second.
const BURST = 5;
const REFILL_MS = 1000;

const broadcastPresence = () => broadcast({ type: "presence", online: onlineUserIds() });

const MESSAGE_COLUMNS = `m.id, m.channel_id AS channelId, m.user_id AS userId,
  COALESCE(u.display_name, u.username) AS username, m.content,
  m.created_at AS createdAt FROM messages m JOIN users u ON u.id = m.user_id`;

/** The newest page of a channel's messages (optionally older than `before`), oldest first. */
function messagePage(channelId: number, before?: number): Message[] {
  type Row = Omit<Message, "attachments">;
  const rows = before
    ? all<Row>(
        `SELECT ${MESSAGE_COLUMNS} WHERE m.channel_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`,
        channelId,
        before,
        PAGE_SIZE,
      )
    : all<Row>(`SELECT ${MESSAGE_COLUMNS} WHERE m.channel_id = ? ORDER BY m.id DESC LIMIT ?`, channelId, PAGE_SIZE);
  const attachments = attachmentsFor(rows.map((r) => r.id));
  return rows.reverse().map((r) => ({ ...r, attachments: attachments.get(r.id) ?? [] }));
}

export function registerChatRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string }; Querystring: { before?: string } }>(
    "/api/channels/:id/messages",
    async (req, reply) => {
      if (!requireUser(req, reply)) return reply;
      const channel = getChannel(Number(req.params.id));
      if (!channel || channel.type !== "text") return reply.code(404).send({ error: "Channel not found" });
      return { messages: messagePage(channel.id, Number(req.query.before) || undefined) };
    },
  );

  app.get("/api/users", async (req, reply) => {
    if (!requireUser(req, reply)) return reply;
    const rows = all<UserRow>(
      `SELECT ${userColumns()} FROM users ORDER BY COALESCE(display_name, username) COLLATE NOCASE`,
    );
    return { users: rows.map(toUser) };
  });

  app.get("/api/ws", { websocket: true }, (socket, req) => {
    const origin = req.headers.origin;
    if (origin && origin !== config.publicOrigin) {
      socket.close(4003, "Origin not allowed");
      return;
    }
    const user = userFromRequest(req);
    if (!user) {
      socket.close(4001, "Not logged in");
      return;
    }

    sockets.set(socket, user);
    const hello: ServerEvent = {
      type: "hello",
      user,
      permissions: permissionsFor(user),
      channels: listChannels(),
      online: onlineUserIds(),
      voice: getVoiceState(),
    };
    socket.send(JSON.stringify(hello));
    broadcastPresence();

    let tokens = BURST;
    let lastRefill = Date.now();

    socket.on("message", (raw: Buffer) => {
      let msg: { type?: unknown; channelId?: unknown; content?: unknown; attachments?: unknown };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === "send") {
        const now = Date.now();
        tokens = Math.min(BURST, tokens + (now - lastRefill) / REFILL_MS);
        lastRefill = now;
        if (tokens < 1) return;
        tokens -= 1;

        const channel = typeof msg.channelId === "number" ? getChannel(msg.channelId) : undefined;
        if (!channel || channel.type !== "text") return;
        const content = typeof msg.content === "string" ? msg.content.trim() : "";
        const requested = Array.isArray(msg.attachments)
          ? msg.attachments.filter((a): a is string => typeof a === "string").slice(0, MAX_ATTACHMENTS)
          : [];
        const uploads = claimableUploads(user.id, requested);
        if ((!content && !uploads.length) || content.length > MAX_MESSAGE_LENGTH) return;

        const id = transaction(() => {
          const messageId = Number(
            run(
              "INSERT INTO messages (channel_id, user_id, content, created_at) VALUES (?, ?, ?, ?)",
              channel.id,
              user.id,
              content,
              now,
            ).lastInsertRowid,
          );
          attachToMessage(messageId, uploads);
          return messageId;
        });
        broadcast({
          type: "message",
          message: {
            id,
            channelId: channel.id,
            userId: user.id,
            username: user.displayName ?? user.username,
            content,
            createdAt: now,
            attachments: attachmentsFor([id]).get(id) ?? [],
          },
        });
      } else if (msg.type === "voice-changed") {
        pokeVoice();
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      broadcastPresence();
    });
  });

  // Keep idle connections alive through proxies and NATs.
  setInterval(() => {
    for (const ws of sockets.keys()) ws.ping();
  }, 30_000).unref();
}
