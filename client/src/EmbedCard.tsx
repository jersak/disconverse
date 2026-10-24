import { useEffect, useState } from "react";
import { embedKey, hasServerPreview, playerUrl, PROVIDER_NAMES, type Embed } from "./embeds.ts";
import { Icon } from "./ui.tsx";

type Info = { title: string | null; author: string | null; hasThumbnail: boolean };

// Titles/thumbnails are fetched once per page load and shared by every card showing the same video.
const infoCache = new Map<string, Promise<Info | null>>();

function loadInfo(e: Embed): Promise<Info | null> {
  if (!hasServerPreview(e)) return Promise.resolve(null);
  const key = embedKey(e);
  let info = infoCache.get(key);
  if (!info) {
    info = fetch(`/api/embeds/${e.provider}/${e.id}`)
      .then((r) => (r.ok ? (r.json() as Promise<Info>) : null))
      .catch(() => null);
    infoCache.set(key, info);
  }
  return info;
}

const WIDTH = 400;

/**
 * A playable video card. Nothing loads from the provider until play is pressed: the title and
 * thumbnail come from our own server.
 */
export function EmbedCard({ embed, url }: { embed: Embed; url: string }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    let current = true;
    void loadInfo(embed).then((i) => current && setInfo(i));
    return () => {
      current = false;
    };
  }, [embedKey(embed)]);

  const vertical = embed.provider === "youtube" && embed.vertical;
  const mediaStyle = vertical ? { width: 200, aspectRatio: "9 / 16" } : { width: WIDTH, aspectRatio: "16 / 9" };
  const twitchLabel =
    embed.provider === "twitch"
      ? embed.kind === "channel"
        ? `${embed.id} on Twitch`
        : embed.kind === "clip"
          ? "Twitch clip"
          : "Twitch video"
      : null;
  const title = info?.title ?? twitchLabel ?? (embed.provider === "file" ? url.split("/").pop() : null);

  return (
    <div className={`embed embed-${embed.provider}`}>
      <div className="embed-provider">{PROVIDER_NAMES[embed.provider]}</div>
      {info?.author && <div className="embed-author">{info.author}</div>}
      <a className="embed-title" href={url} target="_blank" rel="noreferrer noopener">
        {title ?? url}
      </a>

      <div className="embed-media" style={mediaStyle}>
        {embed.provider === "file" ? (
          // preload="none": the file's host isn't contacted until play is pressed.
          <video src={url} controls preload="none" playsInline />
        ) : playing ? (
          <iframe
            src={playerUrl(embed)}
            title={title ?? PROVIDER_NAMES[embed.provider]}
            allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        ) : (
          <button className="embed-play" onClick={() => setPlaying(true)} title="Play">
            {info?.hasThumbnail && hasServerPreview(embed) && (
              <img src={`/api/embeds/${embed.provider}/${embed.id}/thumbnail`} alt="" loading="lazy" />
            )}
            <span className="embed-play-button">
              <Icon name="play" size={32} />
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
