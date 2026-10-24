// Small per-device preferences shared across components, plus window-focus tracking.
import { useSyncExternalStore } from "react";

export type GifStopAfter = "never" | "loops3" | "loops5" | "seconds15";

export type GifPrefs = {
  /** Freeze GIFs while the window/tab isn't focused. */
  pauseWhenUnfocused: boolean;
  stopAfter: GifStopAfter;
};

export const GIF_STOP_OPTIONS: { value: GifStopAfter; label: string }[] = [
  { value: "loops3", label: "After 3 loops" },
  { value: "loops5", label: "After 5 loops" },
  { value: "seconds15", label: "After 15 seconds" },
  { value: "never", label: "Never (loop forever)" },
];

/** Loop limit for a setting, or null if the setting is time-based / unlimited. */
export const loopLimit = (s: GifStopAfter) => (s === "loops3" ? 3 : s === "loops5" ? 5 : null);

/** Time limit in ms. Loop limits are approximated for GIF images, whose loops can't be counted. */
export const timeLimitMs = (s: GifStopAfter, countableLoops: boolean) =>
  s === "seconds15" ? 15_000 : s === "never" || countableLoops ? null : (loopLimit(s) ?? 0) * 3000;

const GIF_KEY = "disconverse.gifs";
const DEFAULT_GIF_PREFS: GifPrefs = { pauseWhenUnfocused: true, stopAfter: "loops3" };

function load(): GifPrefs {
  try {
    return { ...DEFAULT_GIF_PREFS, ...JSON.parse(localStorage.getItem(GIF_KEY) ?? "null") };
  } catch {
    return DEFAULT_GIF_PREFS;
  }
}

let gifPrefs = load();
const listeners = new Set<() => void>();

export function setGifPrefs(next: GifPrefs) {
  gifPrefs = next;
  try {
    localStorage.setItem(GIF_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable: applies until reload.
  }
  listeners.forEach((l) => l());
}

export const useGifPrefs = () =>
  useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => gifPrefs,
  );

/** True while this window is focused and its tab visible. */
export const useWindowFocused = () =>
  useSyncExternalStore(
    (onChange) => {
      window.addEventListener("focus", onChange);
      window.addEventListener("blur", onChange);
      document.addEventListener("visibilitychange", onChange);
      return () => {
        window.removeEventListener("focus", onChange);
        window.removeEventListener("blur", onChange);
        document.removeEventListener("visibilitychange", onChange);
      };
    },
    () => document.hasFocus() && document.visibilityState === "visible",
  );
