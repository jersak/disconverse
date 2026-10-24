import type { FastifyInstance } from "fastify";
import { AccessToken, RoomServiceClient, TrackSource } from "livekit-server-sdk";
import { requireUser } from "./auth.ts";
import { getChannel } from "./channels.ts";
import { config } from "./config.ts";
import type { VoiceMember, VoiceState } from "./types.ts";

// Each voice channel is a LiveKit room named `<prefix>-<channel id>`. Dev uses a different prefix:
// user ids from different databases would otherwise collide in the shared LiveKit server.
const ROOM_PREFIX = process.env.VOICE_ROOM ?? "voice";
const POLL_INTERVAL_MS = 3000;

export const roomName = (channelId: number) => `${ROOM_PREFIX}-${channelId}`;

function channelIdFromRoom(name: string): number | null {
  if (!name.startsWith(`${ROOM_PREFIX}-`)) return null;
  const id = Number(name.slice(ROOM_PREFIX.length + 1));
  return Number.isInteger(id) && id > 0 ? id : null;
}

const roomService = new RoomServiceClient(config.livekit.apiUrl, config.livekit.apiKey, config.livekit.apiSecret);

const isNotFound = (err: unknown) => (err as { status?: number }).status === 404;

let state: VoiceState = {};
let pollNow = () => {};

export const getVoiceState = () => state;

/** Re-check voice rooms right away (e.g. a client just joined or left). */
export const pokeVoice = () => pollNow();

async function fetchState(): Promise<VoiceState> {
  const next: VoiceState = {};
  for (const room of await roomService.listRooms()) {
    const channelId = channelIdFromRoom(room.name);
    if (channelId === null) continue;
    let participants;
    try {
      participants = await roomService.listParticipants(room.name);
    } catch (err) {
      if (isNotFound(err)) continue; // closed between the two calls
      throw err;
    }
    if (!participants.length) continue;
    next[channelId] = participants
      .map((p) => ({
        userId: Number(p.identity),
        username: p.name || p.identity,
        muted: !p.tracks.some((t) => t.source === TrackSource.MICROPHONE && !t.muted),
        video: p.tracks.some((t) => t.source === TrackSource.CAMERA && !t.muted),
        streaming: p.tracks.some((t) => t.source === TrackSource.SCREEN_SHARE),
      }))
      .sort((a, b) => a.username.localeCompare(b.username));
  }
  return next;
}

/** Disconnects everyone from a voice channel's room (used when the channel is deleted). */
export async function closeVoiceRoom(channelId: number) {
  try {
    await roomService.deleteRoom(roomName(channelId));
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

/**
 * Keeps the voice member lists current so the sidebar shows who's in each channel without joining.
 * Polls LiveKit only while someone is connected to the chat.
 */
export function startVoicePolling(
  app: FastifyInstance,
  onChange: (state: VoiceState) => void,
  isActive: () => boolean,
) {
  let running = false;
  const poll = async () => {
    if (running) return;
    running = true;
    try {
      const next = await fetchState();
      if (JSON.stringify(next) !== JSON.stringify(state)) {
        state = next;
        onChange(state);
      }
    } catch (err) {
      app.log.warn({ err }, "voice poll failed");
    } finally {
      running = false;
    }
  };
  pollNow = () => void poll();
  setInterval(() => isActive() && void poll(), POLL_INTERVAL_MS).unref();
}

export function registerVoiceRoutes(app: FastifyInstance) {
  app.post<{ Body: { channelId: number } }>(
    "/api/voice/token",
    {
      schema: { body: { type: "object", required: ["channelId"], properties: { channelId: { type: "integer" } } } },
    },
    async (req, reply) => {
      const user = requireUser(req, reply);
      if (!user) return reply;
      const channel = getChannel(req.body.channelId);
      if (!channel || channel.type !== "voice") return reply.code(404).send({ error: "Voice channel not found" });

      const token = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
        identity: String(user.id),
        name: user.displayName ?? user.username,
        ttl: "10m", // only needs to last until the client connects; LiveKit refreshes it after that
      });
      token.addGrant({
        roomJoin: true,
        room: roomName(channel.id),
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
      });
      return { url: config.livekit.url, token: await token.toJwt() };
    },
  );
}
