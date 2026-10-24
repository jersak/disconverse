// Video link previews. The server fetches titles and thumbnails so viewers' browsers don't contact
// the provider until someone presses play. Only fixed provider URLs built from validated ids are
// ever requested, so this can't be used to make the server fetch arbitrary addresses.
import type { FastifyInstance } from "fastify";
import { requireUser } from "./auth.ts";

type Provider = {
  /** Valid video id shape. */
  id: RegExp;
  /** oEmbed endpoint for the canonical URL of an id. */
  oembed: (id: string) => string;
  /** Hosts thumbnails may be fetched from. */
  thumbnailHost: (host: string) => boolean;
};

const enc = encodeURIComponent;

const PROVIDERS: Record<string, Provider> = {
  youtube: {
    id: /^[A-Za-z0-9_-]{11}$/,
    oembed: (id) => `https://www.youtube.com/oembed?format=json&url=${enc(`https://www.youtube.com/watch?v=${id}`)}`,
    thumbnailHost: (h) => h === "i.ytimg.com",
  },
  vimeo: {
    id: /^\d{1,12}$/,
    oembed: (id) => `https://vimeo.com/api/oembed.json?url=${enc(`https://vimeo.com/${id}`)}`,
    thumbnailHost: (h) => h === "i.vimeocdn.com",
  },
  streamable: {
    id: /^[a-z0-9]{3,12}$/i,
    oembed: (id) => `https://api.streamable.com/oembed.json?url=${enc(`https://streamable.com/${id}`)}`,
    thumbnailHost: (h) => h === "streamable.com" || h.endsWith(".streamable.com"),
  },
};

export type EmbedInfo = { title: string | null; author: string | null; hasThumbnail: boolean };

type CacheEntry = { info: EmbedInfo; thumbnail?: { type: string; data: Buffer }; expires: number };

const CACHE_LIMIT = 300;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 10 * 60 * 1000;
const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 5000;

const cache = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<CacheEntry>>();

function remember(key: string, entry: CacheEntry) {
  cache.delete(key);
  cache.set(key, entry);
  // Map keeps insertion order, so the first key is the least recently stored.
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

async function fetchThumbnail(url: string, provider: Provider) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !provider.thumbnailHost(parsed.hostname)) return undefined;
  const res = await fetch(parsed, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "error" });
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || !/^image\/(jpeg|png|webp|gif)$/.test(type.split(";")[0]!)) return undefined;
  const data = Buffer.from(await res.arrayBuffer());
  return data.length <= MAX_THUMBNAIL_BYTES ? { type: type.split(";")[0]!, data } : undefined;
}

async function load(providerName: string, provider: Provider, id: string): Promise<CacheEntry> {
  try {
    const res = await fetch(provider.oembed(id), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`oEmbed ${res.status}`);
    const data = (await res.json()) as { title?: unknown; author_name?: unknown; thumbnail_url?: unknown };
    let thumbnailUrl = typeof data.thumbnail_url === "string" ? data.thumbnail_url : null;
    // YouTube's oEmbed gives a letterboxed 4:3 image; the 16:9 one is cleaner.
    if (providerName === "youtube") thumbnailUrl = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
    const thumbnail = thumbnailUrl ? await fetchThumbnail(thumbnailUrl, provider).catch(() => undefined) : undefined;
    return {
      info: {
        title: typeof data.title === "string" ? data.title.slice(0, 300) : null,
        author: typeof data.author_name === "string" ? data.author_name.slice(0, 100) : null,
        hasThumbnail: !!thumbnail,
      },
      thumbnail,
      expires: Date.now() + CACHE_TTL_MS,
    };
  } catch {
    // Private/deleted video or provider unreachable: the client still shows a playable card.
    return { info: { title: null, author: null, hasThumbnail: false }, expires: Date.now() + FAILURE_TTL_MS };
  }
}

async function getEntry(providerName: string, id: string): Promise<CacheEntry | null> {
  const provider = PROVIDERS[providerName];
  if (!provider || !provider.id.test(id)) return null;
  const key = `${providerName}:${id}`;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached;

  // Several viewers loading the same message share one upstream request.
  let request = pending.get(key);
  if (!request) {
    request = load(providerName, provider, id).finally(() => pending.delete(key));
    pending.set(key, request);
  }
  const entry = await request;
  remember(key, entry);
  return entry;
}

export function registerEmbedRoutes(app: FastifyInstance) {
  app.get<{ Params: { provider: string; id: string } }>(
    "/api/embeds/:provider/:id",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (req, reply) => {
      if (!requireUser(req, reply)) return reply;
      const entry = await getEntry(req.params.provider, req.params.id);
      if (!entry) return reply.code(404).send({ error: "Unsupported link" });
      reply.header("Cache-Control", "private, max-age=3600");
      return entry.info;
    },
  );

  app.get<{ Params: { provider: string; id: string } }>(
    "/api/embeds/:provider/:id/thumbnail",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (req, reply) => {
      if (!requireUser(req, reply)) return reply;
      const entry = await getEntry(req.params.provider, req.params.id);
      if (!entry?.thumbnail) return reply.code(404).send({ error: "No thumbnail" });
      return reply
        .header("Content-Type", entry.thumbnail.type)
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "private, max-age=86400")
        .send(entry.thumbnail.data);
    },
  );
}
