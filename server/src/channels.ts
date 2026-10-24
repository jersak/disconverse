import type { FastifyInstance } from "fastify";
import { requireUser } from "./auth.ts";
import { all, one, run, transaction } from "./db.ts";
import { audit } from "./audit.ts";
import { broadcast } from "./hub.ts";
import { requirePermission } from "./roles.ts";
import type { Channel, ChannelType } from "./types.ts";
import { removeUploadFiles } from "./uploads.ts";
import { closeVoiceRoom, pokeVoice } from "./voice.ts";

const MAX_NAME_LENGTH = 32;

/** Text channels look like `game-night` (Discord style); voice channels allow any short name. */
export function normalizeChannelName(type: ChannelType, raw: string): string | null {
  let name = raw.trim();
  if (type === "text") {
    name = name
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^\p{L}\p{N}_-]/gu, "")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "");
  } else {
    name = name.replace(/\s+/g, " ");
  }
  return name.length >= 1 && name.length <= MAX_NAME_LENGTH ? name : null;
}

export function listChannels(): Channel[] {
  return all<Channel>(
    `SELECT c.id, c.type, c.name, c.position,
            (SELECT MAX(m.id) FROM messages m WHERE m.channel_id = c.id) AS latestMessageId
     FROM channels c ORDER BY c.type = 'voice', c.position, c.id`,
  );
}

export const getChannel = (id: number) =>
  one<{ id: number; type: ChannelType; name: string }>("SELECT id, type, name FROM channels WHERE id = ?", id);

const broadcastChannels = () => broadcast({ type: "channels", channels: listChannels() });

const INVALID_NAME = `Channel names must be 1–${MAX_NAME_LENGTH} characters`;

export function registerChannelRoutes(app: FastifyInstance) {
  app.get("/api/channels", async (req, reply) => {
    if (!requireUser(req, reply)) return reply;
    return { channels: listChannels() };
  });

  app.post<{ Body: { type: ChannelType; name: string } }>(
    "/api/channels",
    {
      schema: {
        body: {
          type: "object",
          required: ["type", "name"],
          properties: { type: { enum: ["text", "voice"] }, name: { type: "string", maxLength: 100 } },
        },
      },
    },
    async (req, reply) => {
      const actor = requirePermission(req, reply, "manageChannels");
      if (!actor) return reply;
      const { type } = req.body;
      const name = normalizeChannelName(type, req.body.name);
      if (!name) return reply.code(400).send({ error: INVALID_NAME });

      const id = transaction(() => {
        const { next } = one<{ next: number }>(
          "SELECT COALESCE(MAX(position), -1) + 1 AS next FROM channels WHERE type = ?",
          type,
        )!;
        return Number(
          run("INSERT INTO channels (type, name, position, created_at) VALUES (?, ?, ?, ?)", type, name, next, Date.now())
            .lastInsertRowid,
        );
      });
      audit(actor.id, "channel.create", { type, name });
      broadcastChannels();
      return { channel: listChannels().find((c) => c.id === id) };
    },
  );

  app.patch<{ Params: { id: string }; Body: { name: string } }>(
    "/api/channels/:id",
    {
      schema: {
        body: { type: "object", required: ["name"], properties: { name: { type: "string", maxLength: 100 } } },
      },
    },
    async (req, reply) => {
      const actor = requirePermission(req, reply, "manageChannels");
      if (!actor) return reply;
      const channel = getChannel(Number(req.params.id));
      if (!channel) return reply.code(404).send({ error: "Channel not found" });
      const name = normalizeChannelName(channel.type, req.body.name);
      if (!name) return reply.code(400).send({ error: INVALID_NAME });

      run("UPDATE channels SET name = ? WHERE id = ?", name, channel.id);
      audit(actor.id, "channel.rename", { type: channel.type, from: channel.name, to: name });
      broadcastChannels();
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>("/api/channels/:id", async (req, reply) => {
    const actor = requirePermission(req, reply, "manageChannels");
    if (!actor) return reply;
    const channel = getChannel(Number(req.params.id));
    if (!channel) return reply.code(404).send({ error: "Channel not found" });

    if (channel.type === "voice") {
      await closeVoiceRoom(channel.id); // disconnects anyone still in it
      run("DELETE FROM channels WHERE id = ?", channel.id);
      audit(actor.id, "channel.delete", { type: "voice", name: channel.name });
      broadcastChannels();
      pokeVoice();
      return { ok: true };
    }

    const result = transaction((): { error: string } | { files: string[] } => {
      const { count } = one<{ count: number }>("SELECT COUNT(*) AS count FROM channels WHERE type = 'text'")!;
      if (count <= 1) return { error: "The last text channel can't be deleted" };
      const files = all<{ id: string }>(
        "SELECT a.id FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.channel_id = ?",
        channel.id,
      ).map((f) => f.id);
      run("DELETE FROM messages WHERE channel_id = ?", channel.id); // attachments rows cascade
      run("DELETE FROM channels WHERE id = ?", channel.id);
      return { files };
    });
    if ("error" in result) return reply.code(400).send(result);

    await removeUploadFiles(result.files);
    audit(actor.id, "channel.delete", { type: "text", name: channel.name, files: result.files.length });
    broadcastChannels();
    return { ok: true };
  });
}
