// GIFs: a media proxy for well-known GIF hosts (so members' browsers only talk to this server),
// Tenor link resolution, and GIF search via Giphy or Tenor (whichever API key is configured).
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireUser } from "./auth.ts";

const GIPHY_API_KEY = process.env.GIPHY_API_KEY || "";
const TENOR_API_KEY = process.env.TENOR_API_KEY || "";
/** off | low | medium | high (strictest). */
const CONTENT_FILTER = process.env.GIF_CONTENT_FILTER || "medium";
const SEARCH_PROVIDER: "giphy" | "tenor" | null = GIPHY_API_KEY ? "giphy" : TENOR_API_KEY ? "tenor" : null;

const FETCH_TIMEOUT_MS = 8000;
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const MEDIA_CACHE_BYTES = 150 * 1024 * 1024;
const PAGE_SIZE = 24;

/** Hosts GIF media may be proxied from. */
export function isGifHost(host: string): boolean {
  return (
    /^(media\d*|i)\.giphy\.com$/.test(host) ||
    /^(media\d*|c)\.tenor\.com$/.test(host) ||
    host === "i.imgur.com"
  );
}

const MEDIA_TYPES = /^(image\/(gif|webp|png|jpeg)|video\/(mp4|webm))$/;

// ---- Media proxy -----------------------------------------------------------

type Media = { type: string; data: Buffer };

const mediaCache = new Map<string, Media>();
let mediaCacheBytes = 0;
const mediaPending = new Map<string, Promise<Media | null>>();

function cacheMedia(url: string, media: Media) {
  mediaCache.set(url, media);
  mediaCacheBytes += media.data.length;
  for (const [key, old] of mediaCache) {
    if (mediaCacheBytes <= MEDIA_CACHE_BYTES) break;
    mediaCache.delete(key);
    mediaCacheBytes -= old.data.length;
  }
}

/** Validated, normalized media URL (https, allowlisted host, no query/fragment), or null. */
function mediaUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !isGifHost(url.hostname) || url.port) return null;
  url.search = ""; // tracking parameters (e.g. Giphy's ?cid=) aren't needed
  url.hash = "";
  return url;
}

async function readCapped(res: Response, limit: number): Promise<Buffer | null> {
  const declared = Number(res.headers.get("content-length"));
  if (declared > limit) return null;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > limit) return null;
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function fetchMedia(url: URL): Promise<Media | null> {
  const key = url.href;
  const cached = mediaCache.get(key);
  if (cached) {
    mediaCache.delete(key); // refresh recency
    mediaCache.set(key, cached);
    return cached;
  }
  let request = mediaPending.get(key);
  if (!request) {
    request = (async () => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "error" });
        const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
        if (!res.ok || !MEDIA_TYPES.test(type)) return null;
        const data = await readCapped(res, MAX_MEDIA_BYTES);
        if (!data) return null;
        const media = { type, data };
        cacheMedia(key, media);
        return media;
      } catch {
        return null;
      } finally {
        mediaPending.delete(key);
      }
    })();
    mediaPending.set(key, request);
  }
  return request;
}

/** Sends a buffer, honouring Range requests (Safari won't play video without them). */
function sendMedia(req: FastifyRequest, reply: FastifyReply, media: Media) {
  reply
    .header("Content-Type", media.type)
    .header("Accept-Ranges", "bytes")
    .header("X-Content-Type-Options", "nosniff")
    .header("Content-Security-Policy", "default-src 'none'; sandbox")
    .header("Cache-Control", "private, max-age=86400");
  const size = media.data.length;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (!range || (!range[1] && !range[2])) return reply.send(media.data);
  let start = range[1] ? Number(range[1]) : size - Number(range[2]);
  let end = range[1] && range[2] ? Number(range[2]) : size - 1;
  start = Math.max(0, start);
  end = Math.min(end, size - 1);
  if (start > end) return reply.code(416).header("Content-Range", `bytes */${size}`).send();
  return reply
    .code(206)
    .header("Content-Range", `bytes ${start}-${end}/${size}`)
    .send(media.data.subarray(start, end + 1));
}

// ---- Tenor links -----------------------------------------------------------

type TenorGif = { mp4: string; gif: string | null; width: number | null; height: number | null };
const tenorCache = new Map<string, TenorGif | null>();

const metaContent = (html: string, property: string) =>
  new RegExp(`<meta[^>]+property="${property}"[^>]+content="([^"]+)"`).exec(html)?.[1] ?? null;

/** A Tenor page names its own GIF in og:video / og:image (the page also lists unrelated GIFs). */
async function resolveTenor(id: string): Promise<TenorGif | null> {
  if (tenorCache.has(id)) return tenorCache.get(id)!;
  let result: TenorGif | null = null;
  try {
    const res = await fetch(`https://tenor.com/view/gif-${id}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Disconverse link preview)" },
    });
    // Tenor redirects to the canonical slug; stay on tenor.com.
    if (res.ok && new URL(res.url).hostname === "tenor.com") {
      const html = (await readCapped(res, 2 * 1024 * 1024))?.toString("utf8") ?? "";
      const mp4 = metaContent(html, "og:video:secure_url") ?? metaContent(html, "og:video");
      if (mp4 && mediaUrl(mp4)) {
        const gif = metaContent(html, "og:image");
        result = {
          mp4,
          gif: gif && mediaUrl(gif) ? gif : null,
          width: Number(metaContent(html, "og:image:width")) || null,
          height: Number(metaContent(html, "og:image:height")) || null,
        };
      }
    }
  } catch {
    // unreachable or changed page layout: the link just stays a link
  }
  if (tenorCache.size > 1000) tenorCache.clear();
  tenorCache.set(id, result);
  return result;
}

// ---- Search ----------------------------------------------------------------

export type GifResult = {
  id: string;
  title: string;
  /** Small looping preview (media URL; the client loads it through the proxy). */
  preview: string;
  width: number;
  height: number;
  /** Link posted to chat when picked; the chat renders it as a GIF. */
  url: string;
};

const GIPHY_RATING: Record<string, string> = { off: "r", low: "r", medium: "pg-13", high: "g" };

/** The provider refused the API key (missing, wrong, revoked or out of quota). */
class KeyRejected extends Error {}

function checkResponse(provider: string, res: Response) {
  if (res.ok) return;
  if ([400, 401, 403, 429].includes(res.status)) throw new KeyRejected(`${provider} rejected the API key (${res.status})`);
  throw new Error(`${provider} ${res.status}`);
}

async function searchGiphy(q: string, pos: number, limit = PAGE_SIZE) {
  const params = new URLSearchParams({
    api_key: GIPHY_API_KEY,
    limit: String(limit),
    offset: String(pos),
    rating: GIPHY_RATING[CONTENT_FILTER] ?? "pg-13",
  });
  if (q) params.set("q", q);
  const res = await fetch(`https://api.giphy.com/v1/gifs/${q ? "search" : "trending"}?${params}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  checkResponse("Giphy", res);
  type Image = { mp4?: string; url?: string; width?: string; height?: string };
  const body = (await res.json()) as {
    data: { id: string; title?: string; images: Record<string, Image> }[];
    pagination?: { total_count?: number; count?: number; offset?: number };
  };
  const results: GifResult[] = body.data.flatMap((g) => {
    const img = g.images.fixed_width ?? g.images.fixed_width_small;
    const preview = img?.mp4 ?? img?.url;
    if (!preview || !/^[A-Za-z0-9]+$/.test(g.id)) return [];
    return [
      {
        id: g.id,
        title: g.title ?? "",
        preview,
        width: Number(img!.width) || 200,
        height: Number(img!.height) || 200,
        url: `https://giphy.com/gifs/${g.id}`,
      },
    ];
  });
  const total = body.pagination?.total_count ?? 0;
  const next = pos + PAGE_SIZE < total ? String(pos + PAGE_SIZE) : null;
  return { results, next };
}

async function searchTenor(q: string, pos: string, limit = PAGE_SIZE) {
  const params = new URLSearchParams({
    key: TENOR_API_KEY,
    client_key: "disconverse",
    limit: String(limit),
    media_filter: "tinymp4",
    contentfilter: CONTENT_FILTER,
  });
  if (q) params.set("q", q);
  if (pos) params.set("pos", pos);
  const res = await fetch(`https://tenor.googleapis.com/v2/${q ? "search" : "featured"}?${params}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  checkResponse("Tenor", res);
  const body = (await res.json()) as {
    results: { id: string; content_description?: string; itemurl: string; media_formats: Record<string, { url: string; dims: number[] }> }[];
    next?: string;
  };
  const results: GifResult[] = body.results.flatMap((g) => {
    const media = g.media_formats.tinymp4;
    if (!media) return [];
    return [
      {
        id: g.id,
        title: g.content_description ?? "",
        preview: media.url,
        width: media.dims[0] ?? 200,
        height: media.dims[1] ?? 200,
        url: g.itemurl,
      },
    ];
  });
  return { results, next: body.next || null };
}

// ---- Key check -------------------------------------------------------------

/** Whether GIF search works: the key is verified at startup and whenever the provider refuses it. */
let searchStatus: "off" | "checking" | "ok" | "rejected" | "unreachable" = SEARCH_PROVIDER ? "checking" : "off";
let lastCheck = 0;
let checking: Promise<void> | null = null;
const RECHECK_UNREACHABLE_MS = 10 * 60 * 1000;

function verifyKey(app: FastifyInstance): Promise<void> | null {
  const due = searchStatus === "checking" || (searchStatus === "unreachable" && Date.now() - lastCheck > RECHECK_UNREACHABLE_MS);
  if (!SEARCH_PROVIDER || !due) return checking;
  checking ??= (async () => {
    try {
      await (SEARCH_PROVIDER === "giphy" ? searchGiphy("", 0, 1) : searchTenor("", "", 1));
      searchStatus = "ok";
      app.log.info(`GIF search enabled (${SEARCH_PROVIDER})`);
    } catch (err) {
      // A refused key stays off until the server restarts with a new one; an outage is retried.
      searchStatus = err instanceof KeyRejected ? "rejected" : "unreachable";
      app.log.error(`GIF search disabled: ${(err as Error).message}`);
    } finally {
      lastCheck = Date.now();
      checking = null;
    }
  })();
  return checking;
}

// ---- Routes ----------------------------------------------------------------

export function registerGifRoutes(app: FastifyInstance) {
  void verifyKey(app);

  app.get("/api/gifs", async (req, reply) => {
    if (!requireUser(req, reply)) return reply;
    await verifyKey(app);
    return { search: searchStatus === "ok" ? SEARCH_PROVIDER : null };
  });

  app.get<{ Querystring: { q?: string; pos?: string } }>(
    "/api/gifs/search",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req, reply) => {
      if (!requireUser(req, reply)) return reply;
      if (searchStatus !== "ok") return reply.code(503).send({ error: "GIF search isn't available on this server" });
      const q = (req.query.q ?? "").trim().slice(0, 100);
      try {
        return SEARCH_PROVIDER === "giphy"
          ? await searchGiphy(q, Math.max(0, Number(req.query.pos) || 0))
          : await searchTenor(q, (req.query.pos ?? "").slice(0, 100));
      } catch (err) {
        if (err instanceof KeyRejected) {
          searchStatus = "rejected";
          app.log.error(`GIF search disabled: ${err.message}`);
        }
        app.log.warn({ err }, "GIF search failed");
        return reply.code(502).send({ error: "GIF search is unavailable right now" });
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/gifs/tenor/:id",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (req, reply) => {
      if (!requireUser(req, reply)) return reply;
      if (!/^\d{1,20}$/.test(req.params.id)) return reply.code(400).send({ error: "Invalid id" });
      const gif = await resolveTenor(req.params.id);
      if (!gif) return reply.code(404).send({ error: "GIF not found" });
      return gif;
    },
  );

  app.get<{ Querystring: { url?: string } }>(
    "/api/gifs/media",
    { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } },
    async (req, reply) => {
      if (!requireUser(req, reply)) return reply;
      const url = mediaUrl(req.query.url ?? "");
      if (!url) return reply.code(400).send({ error: "Not an allowed GIF address" });
      const media = await fetchMedia(url);
      if (!media) return reply.code(404).send({ error: "GIF unavailable" });
      return sendMedia(req, reply, media);
    },
  );
}
