import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { VideoTrack } from "livekit-client";
import type { Channel } from "./api.ts";
import { StreamStats } from "./StreamStats.tsx";
import { Avatar, Icon } from "./ui.tsx";
import { profileOf, useUsers } from "./users.tsx";
import {
  canShareScreen,
  DEFAULT_STREAM_AUDIO,
  isFirefox,
  STREAM_QUALITIES,
  type StreamAudio,
  type Voice,
  type VoiceParticipant,
} from "./useVoice.ts";

type Tile = { key: string; kind: "user" | "screen"; p: VoiceParticipant };

function Video({ track, mirror = false, fit = "cover" }: { track: VideoTrack; mirror?: boolean; fit?: "cover" | "contain" }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => void track.detach(el);
  }, [track]);
  return <video ref={ref} className={`tile-video${mirror ? " mirror" : ""}`} style={{ objectFit: fit }} autoPlay playsInline muted />;
}

/** Mute button and volume slider for a stream's sound. */
function StreamVolume({ audio, onChange }: { audio: StreamAudio; onChange: (change: Partial<StreamAudio>) => void }) {
  const silent = audio.muted || audio.volume === 0;
  const stop = (e: MouseEvent) => e.stopPropagation(); // don't focus or fullscreen the tile
  return (
    <div className="stream-volume" onClick={stop} onDoubleClick={stop}>
      <button
        className="icon-button"
        title={silent ? "Unmute stream" : "Mute stream"}
        onClick={() => onChange(audio.volume === 0 ? { volume: 1, muted: false } : { muted: !audio.muted })}
      >
        <Icon name="speaker" slashed={silent} />
      </button>
      <input
        type="range"
        min={0}
        max={100}
        value={audio.muted ? 0 : Math.round(audio.volume * 100)}
        onChange={(e) => onChange({ volume: Number(e.target.value) / 100, muted: false })}
        aria-label="Stream volume"
        title={`Volume: ${audio.muted ? 0 : Math.round(audio.volume * 100)}%`}
      />
    </div>
  );
}

type IOSVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };
type LockableOrientation = ScreenOrientation & { lock?: (orientation: string) => Promise<void> };

/** The voice channel view: a grid of participants and screen shares, plus call controls. */
export function Stage({
  voice,
  channel,
  qualityMenu,
  setQualityMenu,
  onJoin,
  onOpenChannels,
}: {
  voice: Voice;
  channel: Channel;
  onJoin: () => void;
  /** Owned by App so the sidebar's share button can open it too. */
  qualityMenu: boolean;
  setQualityMenu: (open: boolean) => void;
  onOpenChannels: () => void;
}) {
  const [focused, setFocused] = useState<string | null>(null);
  const users = useUsers();
  // Tile expanded to fill the window when the Fullscreen API isn't available.
  const [expanded, setExpanded] = useState<string | null>(null);
  const [statsFor, setStatsFor] = useState<Set<string>>(new Set());
  const toggleStats = (key: string) => (e: MouseEvent) => {
    e.stopPropagation();
    setStatsFor((cur) => {
      const next = new Set(cur);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  };
  const statsButton = (key: string) => (
    <button className={`icon-button${statsFor.has(key) ? " active" : ""}`} title="Stream stats" onClick={toggleStats(key)}>
      <Icon name="info" />
    </button>
  );

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setExpanded(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  const toggleFullscreen = (key: string) => (e: MouseEvent) => {
    e.stopPropagation();
    if (document.fullscreenElement) return void document.exitFullscreen();
    if (expanded) return setExpanded(null);
    const tile = (e.currentTarget as HTMLElement).closest<HTMLElement>(".tile");
    if (!tile?.requestFullscreen) {
      // iPhone Safari has no element fullscreen, only its own <video> API; otherwise fill the window.
      const video = tile?.querySelector("video") as IOSVideo | null;
      if (video?.webkitEnterFullscreen) video.webkitEnterFullscreen();
      else setExpanded(key);
      return;
    }
    tile
      .requestFullscreen()
      // Phones: watch in landscape (Android allows this once fullscreen).
      .then(() => (screen.orientation as LockableOrientation).lock?.("landscape").catch(() => {}))
      .catch(() => setExpanded(key));
  };

  // Close the quality menu on any click outside it.
  useEffect(() => {
    if (!qualityMenu) return;
    const close = (e: PointerEvent) => {
      if (!(e.target as Element).closest(".control-menu-wrap")) setQualityMenu(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [qualityMenu, setQualityMenu]);

  const menuButton = (
    <button className="icon-button mobile-only channels-toggle stage-menu-button" onClick={onOpenChannels} title="Channels">
      <Icon name="menu" />
    </button>
  );

  if (voice.status !== "connected" || voice.channelId !== channel.id) {
    const connecting = voice.status === "connecting" && voice.channelId === channel.id;
    return (
      <div className="stage stage-empty">
        {menuButton}
        <Icon name="speaker" size={64} />
        <h2>{channel.name}</h2>
        {voice.error && <p className="error">{voice.error}</p>}
        <button className="primary" onClick={onJoin} disabled={connecting}>
          {connecting ? "Connecting…" : "Join Voice"}
        </button>
      </div>
    );
  }

  // Screen shares first, then people.
  const tiles: Tile[] = [
    ...voice.participants.filter((p) => p.screen).map((p) => ({ key: `s${p.userId}`, kind: "screen" as const, p })),
    ...voice.participants.map((p) => ({ key: `u${p.userId}`, kind: "user" as const, p })),
  ];
  const focusedTile = tiles.find((t) => t.key === focused);
  const others = focusedTile ? tiles.filter((t) => t !== focusedTile) : tiles;
  const toggleFocus = (key: string) => setFocused((cur) => (cur === key ? null : key));

  const renderTile = (t: Tile, isFocused = false) => {
    const { p } = t;
    const profile = profileOf(users, p.userId, p.name);
    if (t.kind === "user") {
      return (
        <div key={t.key} className={`tile${p.speaking ? " speaking" : ""}${expanded === t.key ? " expanded" : ""}`} onClick={() => toggleFocus(t.key)} onDoubleClick={toggleFullscreen(t.key)}>
          {p.camera ? (
            <>
              <Video track={p.camera} mirror={p.isLocal} fit={isFocused ? "contain" : "cover"} />
              {statsFor.has(t.key) && <StreamStats track={p.camera} isLocal={p.isLocal} />}
              <div className="tile-actions">{statsButton(t.key)}</div>
            </>
          ) : (
            <div className="tile-avatar">
              <Avatar userId={p.userId} name={profile.name} avatarUrl={profile.avatarUrl} size={80} speaking={p.speaking} />
            </div>
          )}
          <div className="tile-label">
            {p.muted && <Icon name="mic" size={16} slashed />}
            {profile.name}
          </div>
        </div>
      );
    }

    const screen = p.screen!;
    const showVideo = screen.watching && screen.track;
    return (
      <div key={t.key} className={`tile screen${expanded === t.key ? " expanded" : ""}`} onClick={() => toggleFocus(t.key)} onDoubleClick={toggleFullscreen(t.key)}>
        {showVideo ? (
          <>
            <Video track={screen.track!} fit="contain" />
            {statsFor.has(t.key) && <StreamStats track={screen.track!} isLocal={p.isLocal} />}
          </>
        ) : (
          <div className="tile-avatar">
            {screen.watching ? (
              <span className="tile-hint">Loading stream…</span>
            ) : (
              <button
                className="watch-button"
                onClick={(e) => {
                  e.stopPropagation();
                  voice.watchStream(p.userId, true);
                  setFocused(t.key);
                }}
              >
                Watch Stream
              </button>
            )}
          </div>
        )}
        <div className="tile-label">
          <span className="live-badge">LIVE</span>
          {p.isLocal ? "Your screen" : `${profile.name}'s screen`}
        </div>
        <div className="tile-actions">
          {!p.isLocal && screen.watching && screen.hasAudio && (
            <StreamVolume
              audio={voice.streamAudio[p.userId] ?? DEFAULT_STREAM_AUDIO}
              onChange={(change) => voice.setStreamAudio(p.userId, change)}
            />
          )}
          {showVideo && statsButton(t.key)}
          <button className="icon-button" title="Fullscreen" onClick={toggleFullscreen(t.key)}>
            <Icon name="fullscreen" />
          </button>
          {!p.isLocal && screen.watching && (
            <button
              className="icon-button"
              title="Stop watching"
              onClick={(e) => {
                e.stopPropagation();
                voice.watchStream(p.userId, false);
              }}
            >
              <Icon name="close" />
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="stage">
      {menuButton}
      {focusedTile ? (
        <div className="stage-focus">
          <div className="focus-main">{renderTile(focusedTile, true)}</div>
          {others.length > 0 && <div className="focus-strip">{others.map((t) => renderTile(t))}</div>}
        </div>
      ) : (
        <div className={`stage-grid count-${Math.min(tiles.length, 9)}`}>{tiles.map((t) => renderTile(t))}</div>
      )}

      <div className="call-controls">
        <button className={`control${voice.muted ? " off" : ""}`} onClick={voice.toggleMute} title={voice.muted ? "Unmute" : "Mute"}>
          <Icon name="mic" size={24} slashed={voice.muted} />
        </button>
        <button className={`control${voice.cameraOn ? " on" : ""}`} onClick={voice.toggleCamera} title={voice.cameraOn ? "Turn off camera" : "Turn on camera"}>
          <Icon name="camera" size={24} slashed={!voice.cameraOn} />
        </button>
        {canShareScreen && (
          <div className="control-menu-wrap">
          <button
            className={`control${voice.sharing ? " on" : ""}`}
            onClick={() => (voice.sharing ? void voice.stopScreenShare() : setQualityMenu(!qualityMenu))}
            title={voice.sharing ? "Stop streaming" : "Share your screen"}
          >
            <Icon name="screen" size={24} />
          </button>
          {qualityMenu && !voice.sharing && (
            <div className="control-menu">
              <div className="control-menu-title">Stream quality</div>
              {isFirefox && <div className="control-menu-hint">Streams are smoother from Chrome or Edge.</div>}
              {STREAM_QUALITIES.map((q) => (
                <button
                  key={q.id}
                  onClick={() => {
                    setQualityMenu(false);
                    void voice.startScreenShare(q);
                  }}
                >
                  {q.label}
                </button>
              ))}
            </div>
          )}
          </div>
        )}
        <button className="control hangup" onClick={voice.leave} title="Disconnect">
          <Icon name="hangup" size={24} />
        </button>
      </div>
      {voice.error && <div className="stage-error">{voice.error}</div>}
    </div>
  );
}
