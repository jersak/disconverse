// Recognizes video links that can be played inline in chat.

export type Embed =
  | { provider: "youtube"; id: string; start: number; vertical: boolean }
  | { provider: "vimeo"; id: string; hash: string | null; start: number }
  | { provider: "streamable"; id: string }
  | { provider: "twitch"; kind: "clip" | "video" | "channel"; id: string }
  | { provider: "file"; url: string }
  /** Media on a known GIF host, shown inline and looping (loaded through the server's GIF proxy). */
  | { provider: "gif"; src: string; video: boolean }
  /** Tenor page link; the server resolves it to the GIF's media. */
  | { provider: "tenor"; id: string };

export const isGif = (e: Embed): e is Extract<Embed, { provider: "gif" | "tenor" }> =>
  e.provider === "gif" || e.provider === "tenor";

const giphyMp4 = (id: string): Embed => ({ provider: "gif", src: `https://media.giphy.com/media/${id}/giphy.mp4`, video: true });

/** GIF links: Giphy pages and media, Tenor pages and media, Imgur GIFs. */
function parseGif(url: URL): Embed | null {
  const host = url.hostname.replace(/^www\./, "");
  const path = url.pathname;
  if (host === "giphy.com") {
    const m = path.match(/^\/(?:gifs|stickers|clips)\/(?:[\w-]*-)?([A-Za-z0-9]{6,40})\/?$/);
    return m ? giphyMp4(m[1]!) : null;
  }
  if (/^(media\d*|i)\.giphy\.com$/.test(host)) {
    const id =
      path.match(/\/media\/(?:[^/]+\/)?([A-Za-z0-9]{6,40})\/[\w.-]+$/)?.[1] ??
      path.match(/^\/([A-Za-z0-9]{6,40})\.(?:gif|webp|mp4)$/)?.[1];
    return id ? giphyMp4(id) : null;
  }
  if (host === "tenor.com") {
    const m = path.match(/\/view\/[^/]*?(\d{4,20})\/?$/);
    return m ? { provider: "tenor", id: m[1]! } : null;
  }
  if (/^(media\d*|c)\.tenor\.com$/.test(host)) {
    const ext = path.match(/\.(gif|mp4|webp)$/)?.[1];
    return ext ? { provider: "gif", src: `https://${host}${path}`, video: ext === "mp4" } : null;
  }
  if (host === "i.imgur.com") {
    const m = path.match(/^\/([A-Za-z0-9]{5,10})\.(gif|gifv|mp4)$/);
    // Imgur serves every GIF as a much smaller MP4 too.
    return m ? { provider: "gif", src: `https://i.imgur.com/${m[1]}.mp4`, video: true } : null;
  }
  return null;
}

/** "90", "90s", "1m30s", "1h2m3s" → seconds. */
function parseTime(value: string | null): number {
  if (!value) return 0;
  if (/^\d+s?$/.test(value)) return parseInt(value, 10);
  const m = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : 0;
}

// twitch.tv/<name> paths that aren't channels.
const TWITCH_RESERVED = new Set(["directory", "downloads", "jobs", "p", "search", "settings", "subscriptions", "turbo", "videos", "wallet", "inventory", "drops"]);

export function parseEmbed(raw: string): Embed | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const gif = parseGif(url);
  if (gif) return gif;
  const host = url.hostname.replace(/^(www|m|music)\./, "");
  const path = url.pathname;

  if (host === "youtube.com" || host === "youtube-nocookie.com" || host === "youtu.be") {
    const fromPath = path.match(/^\/(shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/);
    const id = host === "youtu.be" ? path.slice(1, 12) : (fromPath?.[2] ?? url.searchParams.get("v"));
    if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
    const start = parseTime(url.searchParams.get("t") ?? url.searchParams.get("start"));
    return { provider: "youtube", id, start, vertical: fromPath?.[1] === "shorts" };
  }

  if (host === "vimeo.com" || host === "player.vimeo.com") {
    // vimeo.com/123, vimeo.com/123/abcdef (unlisted), vimeo.com/channels/x/123, player.vimeo.com/video/123?h=abcdef
    const m = path.match(/\/(\d{1,12})(?:\/([0-9a-f]{6,20}))?\/?$/);
    if (!m) return null;
    return {
      provider: "vimeo",
      id: m[1]!,
      hash: m[2] ?? url.searchParams.get("h"),
      start: parseTime(url.hash.match(/t=([\dhms]+)/)?.[1] ?? null),
    };
  }

  if (host === "streamable.com") {
    const m = path.match(/^\/(?:e\/|o\/)?([a-z0-9]{3,12})\/?$/i);
    return m ? { provider: "streamable", id: m[1]! } : null;
  }

  if (host === "clips.twitch.tv") {
    const slug = path.slice(1).split("/")[0];
    return slug && /^[\w-]{3,100}$/.test(slug) ? { provider: "twitch", kind: "clip", id: slug } : null;
  }
  if (host === "twitch.tv") {
    const clip = path.match(/^\/\w+\/clip\/([\w-]{3,100})/);
    if (clip) return { provider: "twitch", kind: "clip", id: clip[1]! };
    const video = path.match(/^\/videos\/(\d+)/);
    if (video) return { provider: "twitch", kind: "video", id: video[1]! };
    const channel = path.match(/^\/(\w{3,25})\/?$/);
    if (channel && !TWITCH_RESERVED.has(channel[1]!.toLowerCase())) {
      return { provider: "twitch", kind: "channel", id: channel[1]! };
    }
    return null;
  }

  if (/\.(mp4|webm|mov|m4v)$/i.test(path)) return { provider: "file", url: url.href };
  return null;
}

/** The player URL to load once the user presses play. */
export function playerUrl(e: Embed): string {
  const parent = location.hostname; // Twitch only plays on sites it's told about
  switch (e.provider) {
    case "youtube":
      return `https://www.youtube-nocookie.com/embed/${e.id}?autoplay=1&rel=0${e.start ? `&start=${e.start}` : ""}`;
    case "vimeo":
      return `https://player.vimeo.com/video/${e.id}?autoplay=1${e.hash ? `&h=${e.hash}` : ""}${e.start ? `#t=${e.start}s` : ""}`;
    case "streamable":
      return `https://streamable.com/e/${e.id}?autoplay=1`;
    case "twitch":
      if (e.kind === "clip") return `https://clips.twitch.tv/embed?clip=${e.id}&parent=${parent}&autoplay=true`;
      return `https://player.twitch.tv/?${e.kind === "video" ? `video=v${e.id}` : `channel=${e.id}`}&parent=${parent}&autoplay=true`;
    case "file":
      return e.url;
    case "gif":
      return e.src;
    case "tenor":
      return `https://tenor.com/view/gif-${e.id}`;
  }
}

export const PROVIDER_NAMES: Record<Embed["provider"], string> = {
  youtube: "YouTube",
  vimeo: "Vimeo",
  streamable: "Streamable",
  twitch: "Twitch",
  file: "Video",
  gif: "GIF",
  tenor: "Tenor",
};

/** Providers the server can fetch titles/thumbnails for. */
export const hasServerPreview = (e: Embed): e is Extract<Embed, { provider: "youtube" | "vimeo" | "streamable" }> =>
  e.provider === "youtube" || e.provider === "vimeo" || e.provider === "streamable";

export function embedKey(e: Embed): string {
  if (e.provider === "file") return e.url;
  if (e.provider === "gif") return e.src;
  return `${e.provider}:${"kind" in e ? e.kind : ""}:${e.id}`;
}
