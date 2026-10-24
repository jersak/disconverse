import { useEffect, useRef, useState, type MouseEvent } from "react";
import { api, gifProxyUrl } from "./api.ts";
import type { Embed } from "./embeds.ts";
import { loopLimit, timeLimitMs, useGifPrefs, useWindowFocused } from "./prefs.ts";
import { Icon } from "./ui.tsx";

type Resolved = { src: string; video: boolean; width: number | null; height: number | null };

// Tenor links are resolved once per page load and shared between messages.
const tenorCache = new Map<string, Promise<Resolved | null>>();

function resolveTenor(id: string): Promise<Resolved | null> {
  let result = tenorCache.get(id);
  if (!result) {
    result = api
      .tenorGif(id)
      .then((g) => ({ src: g.mp4, video: true, width: g.width, height: g.height }))
      .catch(() => null);
    tenorCache.set(id, result);
  }
  return result;
}

const MAX_SIZE = 300;

/** True while the element is (at least partly) on screen. */
function useOnScreen(ref: React.RefObject<Element | null>) {
  const [onScreen, setOnScreen] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => setOnScreen(!!entry?.isIntersecting));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return onScreen;
}

/**
 * An inline GIF (usually its MP4 version), loaded through the server's GIF proxy. Plays only while
 * on screen and (by preference) while the window is focused, and stops after the configured loops/time.
 */
export function GifEmbed({ embed, url }: { embed: Extract<Embed, { provider: "gif" | "tenor" }>; url: string }) {
  const [resolved, setResolved] = useState<Resolved | null | undefined>(
    embed.provider === "gif" ? { src: embed.src, video: embed.video, width: null, height: null } : undefined,
  );

  useEffect(() => {
    if (embed.provider !== "tenor") return;
    let current = true;
    void resolveTenor(embed.id).then((r) => current && setResolved(r));
    return () => {
      current = false;
    };
  }, [embed.provider === "tenor" ? embed.id : null]);

  if (resolved === null) return null; // couldn't resolve: the link in the message text remains
  if (resolved === undefined) return <div className="gif-embed gif-loading" />;
  return <GifPlayer gif={resolved} url={url} />;
}

function GifPlayer({ gif, url }: { gif: Resolved; url: string }) {
  const containerRef = useRef<HTMLAnchorElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const prefs = useGifPrefs();
  const focused = useWindowFocused();
  const onScreen = useOnScreen(containerRef);

  const [stopped, setStopped] = useState(false);
  const loopsDone = useRef(0);
  /** Milliseconds played so far (only counts while actually playing). */
  const playedMs = useRef(0);

  const active = onScreen && (focused || !prefs.pauseWhenUnfocused);
  const shouldPlay = active && !stopped;

  // Changing the setting gives every GIF a fresh start.
  useEffect(() => {
    loopsDone.current = 0;
    playedMs.current = 0;
    setStopped(false);
  }, [prefs.stopAfter]);

  // Play/pause, and enforce the time limit while playing.
  useEffect(() => {
    const limit = timeLimitMs(prefs.stopAfter, gif.video);
    if (gif.video) {
      const video = videoRef.current;
      if (!video) return;
      if (shouldPlay) void video.play().catch(() => {});
      else video.pause();
    } else {
      freezeImage(!shouldPlay);
    }
    if (!shouldPlay || limit === null) return;
    const startedAt = performance.now();
    const timer = setTimeout(() => setStopped(true), Math.max(0, limit - playedMs.current));
    return () => {
      clearTimeout(timer);
      playedMs.current += performance.now() - startedAt;
    };
  }, [shouldPlay, prefs.stopAfter, gif.video]);

  /** GIF images can't be paused: show the current frame on a canvas over them instead. */
  const freezeImage = (freeze: boolean) => {
    const img = imgRef.current;
    const canvas = canvasRef.current;
    if (!img || !canvas) return;
    if (freeze && img.complete && img.naturalWidth) {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext("2d")?.drawImage(img, 0, 0); // same-origin (proxied), so this is allowed
    }
    canvas.hidden = !freeze;
  };

  const onEnded = () => {
    loopsDone.current += 1;
    const limit = loopLimit(prefs.stopAfter);
    if (limit !== null && loopsDone.current >= limit) {
      setStopped(true);
      return;
    }
    const video = videoRef.current;
    if (video && shouldPlay) {
      video.currentTime = 0;
      void video.play().catch(() => {});
    }
  };

  const replay = () => {
    loopsDone.current = 0;
    playedMs.current = 0;
    setStopped(false);
  };

  const onClick = (e: MouseEvent) => {
    // A stopped GIF replays instead of opening the link.
    if (stopped) {
      e.preventDefault();
      replay();
    }
  };

  const style =
    gif.width && gif.height
      ? {
          width: Math.round(gif.width * Math.min(1, MAX_SIZE / gif.width, MAX_SIZE / gif.height)),
          aspectRatio: `${gif.width} / ${gif.height}`,
        }
      : undefined;
  const src = gifProxyUrl(gif.src);

  return (
    <a
      ref={containerRef}
      className={`gif-embed${stopped ? " stopped" : ""}`}
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      style={style}
      onMouseEnter={() => stopped && replay()}
      onClick={onClick}
    >
      {gif.video ? (
        <video ref={videoRef} src={src} muted playsInline preload="auto" onEnded={onEnded} />
      ) : (
        <>
          <img ref={imgRef} src={src} alt="GIF" />
          <canvas ref={canvasRef} className="gif-freeze" hidden />
        </>
      )}
      {stopped && (
        <span className="gif-replay" title="Play again">
          <Icon name="play" size={24} />
        </span>
      )}
    </a>
  );
}
