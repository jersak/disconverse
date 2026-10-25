import type { MouseEvent } from "react";
import { Icon } from "./ui.tsx";
import type { Playback } from "./useVoice.ts";

/** Mute button and volume slider for someone's voice or stream (how loud it plays for us). */
export function VolumeControl({
  audio,
  onChange,
  max = 1,
  what,
  showPercent = false,
}: {
  audio: Playback;
  onChange: (change: Partial<Playback>) => void;
  /** Highest volume, 1 = 100%. */
  max?: number;
  /** "stream" or a person's name, for button titles. */
  what: string;
  showPercent?: boolean;
}) {
  const silent = audio.muted || audio.volume === 0;
  const percent = audio.muted ? 0 : Math.round(audio.volume * 100);
  const stop = (e: MouseEvent) => e.stopPropagation(); // e.g. don't focus or fullscreen a tile
  return (
    <div className="volume-control" onClick={stop} onDoubleClick={stop}>
      <button
        className="icon-button"
        title={silent ? `Unmute ${what}` : `Mute ${what}`}
        onClick={() => onChange(audio.volume === 0 ? { volume: 1, muted: false } : { muted: !audio.muted })}
      >
        <Icon name="speaker" slashed={silent} />
      </button>
      <input
        type="range"
        min={0}
        max={max * 100}
        step={5}
        value={percent}
        onChange={(e) => onChange({ volume: Number(e.target.value) / 100, muted: false })}
        aria-label={`Volume for ${what}`}
        title={`Volume: ${percent}%`}
      />
      {showPercent && <span className="volume-percent">{percent}%</span>}
    </div>
  );
}
