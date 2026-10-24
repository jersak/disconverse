import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type User } from "./api.ts";
import { canPickOutput, type DeviceKind } from "./devices.ts";
import type { Suppression } from "./noise.ts";
import { GIF_STOP_OPTIONS, setGifPrefs, useGifPrefs, type GifStopAfter } from "./prefs.ts";
import { playJoinSound, playMentionSound } from "./sounds.ts";
import { Avatar, Icon, type IconName } from "./ui.tsx";
import { displayName } from "./users.tsx";
import type { Voice } from "./useVoice.ts";

type SectionId = "account" | "voice" | "noise" | "chat" | "sounds";

const SECTIONS: { id: SectionId; label: string; icon: IconName }[] = [
  { id: "account", label: "My Account", icon: "people" },
  { id: "voice", label: "Voice & Video", icon: "mic" },
  { id: "noise", label: "Noise Suppression", icon: "headset" },
  { id: "chat", label: "Chat", icon: "chat" },
  { id: "sounds", label: "Sounds", icon: "speaker" },
];

const LAST_SECTION_KEY = "disconverse.settingsSection";

function initialSection(): SectionId {
  try {
    const saved = localStorage.getItem(LAST_SECTION_KEY);
    if (SECTIONS.some((s) => s.id === saved)) return saved as SectionId;
  } catch {
    // storage unavailable
  }
  return "account";
}

/** Per-user settings (all stored on this device), organized into sections. */
export function Settings({ user, voice, onClose }: { user: User; voice: Voice; onClose: () => void }) {
  const [section, setSection] = useState<SectionId>(initialSection);

  const choose = (id: SectionId) => {
    setSection(id);
    try {
      localStorage.setItem(LAST_SECTION_KEY, id);
    } catch {
      // not essential
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const current = SECTIONS.find((s) => s.id === section)!;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal settings-modal" role="dialog" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
        <nav className="settings-nav">
          <div className="settings-nav-title">Settings</div>
          {SECTIONS.map((s) => (
            <button key={s.id} className={s.id === section ? "active" : ""} onClick={() => choose(s.id)}>
              <Icon name={s.icon} size={18} />
              {s.label}
            </button>
          ))}
        </nav>

        <div className="settings-content">
          <header className="modal-header">
            <h2>{current.label}</h2>
            <button className="icon-button" onClick={onClose} title="Close">
              <Icon name="close" />
            </button>
          </header>
          {section === "account" && <AccountSection user={user} />}
          {section === "voice" && <VoiceSection voice={voice} />}
          {section === "noise" && <NoiseSection voice={voice} />}
          {section === "chat" && <ChatSection />}
          {section === "sounds" && <SoundsSection voice={voice} />}
        </div>
      </div>
    </div>
  );
}

// ---- My Account ----------------------------------------------------------------

const AVATAR_SIZE = 256;

/**
 * Crops an image to a centred square and shrinks it to 256×256, in the browser. Uploads stay tiny and
 * the original photo (and its metadata, e.g. location) never leaves the device.
 */
async function squareAvatar(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = AVATAR_SIZE;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  bitmap.close();
  const encode = (type: string) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.9));
  // WebP is smallest; browsers that can't encode it hand back PNG instead.
  const blob = (await encode("image/webp")) ?? (await encode("image/png"));
  if (!blob) throw new Error("Couldn't process that image");
  return blob;
}

function AccountSection({ user }: { user: User }) {
  const [name, setName] = useState(user.displayName ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // Keep the field in sync if the name changes elsewhere (e.g. another device).
  useEffect(() => setName(user.displayName ?? ""), [user.displayName]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await action(); // everyone's view (including ours) updates via the users-changed event
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveName = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api.updateProfile(name.trim() || null))) setSaved(true);
  };

  const pickAvatar = async (file: File | undefined) => {
    if (!file) return;
    await run(async () => {
      let image: Blob;
      try {
        image = await squareAvatar(file);
      } catch {
        throw new Error("That image couldn't be read. Try a PNG, JPEG or WebP.");
      }
      await api.uploadAvatar(image);
    });
  };

  const changed = name.trim() !== (user.displayName ?? "");

  return (
    <>
      <section>
        <h3>Profile picture</h3>
        <div className="account-avatar">
          <Avatar userId={user.id} name={displayName(user)} avatarUrl={user.avatarUrl} size={80} />
          <div className="account-avatar-actions">
            <button className="primary" disabled={busy} onClick={() => fileInput.current?.click()}>
              {user.avatarUrl ? "Change picture" : "Upload picture"}
            </button>
            {user.avatarUrl && (
              <button className="secondary" disabled={busy} onClick={() => void run(() => api.removeAvatar())}>
                Remove
              </button>
            )}
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              hidden
              onChange={(e) => {
                void pickAvatar(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </div>
        </div>
        <p className="hint settings-hint">The image is cropped to a square from its centre.</p>
      </section>

      <section>
        <h3>Display name</h3>
        <form className="account-name" onSubmit={saveName}>
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setSaved(false);
            }}
            placeholder={user.username}
            maxLength={64}
          />
          <button type="submit" className="primary" disabled={busy || !changed}>
            Save
          </button>
        </form>
        <p className="hint settings-hint">
          {saved ? "Saved." : "Shown instead of your username. Leave empty to use your username."}
        </p>
      </section>

      <section>
        <h3>Username</h3>
        <p className="account-username">@{user.username}</p>
        <p className="hint settings-hint">Used to log in. It can't be changed.</p>
      </section>

      {error && <div className="form-error settings-hint">{error}</div>}
    </>
  );
}

// ---- Voice & Video -----------------------------------------------------------

const DEVICE_PICKERS: { kind: DeviceKind; label: string; fallback: string }[] = [
  { kind: "audioinput", label: "Input device", fallback: "Microphone" },
  { kind: "audiooutput", label: "Output device", fallback: "Speakers" },
  { kind: "videoinput", label: "Camera", fallback: "Camera" },
];

const METER_MIN_DB = -80;
const METER_MAX_DB = 0;
const toPercent = (db: number) =>
  Math.max(0, Math.min(100, ((db - METER_MIN_DB) / (METER_MAX_DB - METER_MIN_DB)) * 100));

function VoiceSection({ voice }: { voice: Voice }) {
  const settings = voice.audioSettings;
  const { devices, deviceSettings, refreshDevices, setDevice } = voice;
  const meterRef = useRef<HTMLDivElement>(null);

  useEffect(() => void refreshDevices(), [refreshDevices]);

  // Browsers hide device names until mic/camera access has been granted once.
  const namesHidden = devices.audioinput.some((d) => !d.label);
  const revealNames = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      // Denied: lists keep their generic names.
    }
    await refreshDevices();
  };

  // Live input level, read straight from the audio graph each frame.
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const level = voice.micLevel();
      if (meterRef.current) meterRef.current.style.width = `${level === null ? 0 : toPercent(level)}%`;
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [voice.micLevel]);

  const metering = voice.status === "connected" && !voice.muted && voice.micLevel() !== null;

  return (
    <>
      <section>
        <h3>Devices</h3>
        <div className="device-pickers">
          {DEVICE_PICKERS.filter((p) => p.kind !== "audiooutput" || canPickOutput).map((p) => {
            // Chrome lists a "default" pseudo-device; our "System default" option covers it.
            const options = devices[p.kind].filter((d) => d.deviceId && d.deviceId !== "default");
            return (
              <label key={p.kind}>
                {p.label}
                <select value={deviceSettings[p.kind]} onChange={(e) => void setDevice(p.kind, e.target.value)}>
                  <option value="">System default</option>
                  {options.map((d, i) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `${p.fallback} ${i + 1}`}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
        </div>
        {namesHidden && (
          <button className="link" onClick={revealNames}>
            Show device names (asks for microphone access)
          </button>
        )}
      </section>

      <section>
        <h3>Input sensitivity</h3>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={!settings.gate}
            onChange={(e) => voice.setAudioSettings({ ...settings, gate: !e.target.checked })}
          />
          Always transmit (no noise gate)
        </label>
        <div className={`sensitivity${settings.gate ? "" : " disabled"}`}>
          <div className="meter">
            <div className="meter-fill" ref={meterRef} />
            {settings.gate && <div className="meter-threshold" style={{ left: `${toPercent(settings.gateThreshold)}%` }} />}
          </div>
          <input
            type="range"
            min={METER_MIN_DB}
            max={METER_MAX_DB}
            step={1}
            value={settings.gateThreshold}
            disabled={!settings.gate}
            onChange={(e) => voice.setAudioSettings({ ...settings, gateThreshold: Number(e.target.value) })}
            aria-label="Gate threshold"
          />
          <p className="hint">
            {metering
              ? "Sound below the marker isn't sent. Speak normally and set the marker just below your voice."
              : "Join voice (unmuted) to see your microphone level."}
          </p>
        </div>
      </section>
    </>
  );
}

// ---- Noise Suppression -------------------------------------------------------

const SUPPRESSION_OPTIONS: { value: Suppression; label: string; hint: string }[] = [
  { value: "standard", label: "Standard", hint: "RNNoise. Removes keyboard clicks, fans and background noise." },
  { value: "high", label: "High quality", hint: "GTCRN. Cleaner voice, uses a bit more CPU." },
  { value: "off", label: "Off", hint: "Only the browser's basic noise suppression." },
];

function NoiseSection({ voice }: { voice: Voice }) {
  const settings = voice.audioSettings;
  return (
    <section>
      <p className="hint settings-intro">
        Filters background noise from your microphone before it's sent. It runs on this device; nothing is
        processed elsewhere.
      </p>
      {SUPPRESSION_OPTIONS.map((o) => (
        <label key={o.value} className="radio-row">
          <input
            type="radio"
            name="suppression"
            checked={settings.suppression === o.value}
            onChange={() => voice.setAudioSettings({ ...settings, suppression: o.value })}
          />
          <span>
            <span className="radio-label">{o.label}</span>
            <span className="radio-hint">{o.hint}</span>
          </span>
        </label>
      ))}
    </section>
  );
}

// ---- Chat --------------------------------------------------------------------

function ChatSection() {
  const gifPrefs = useGifPrefs();
  return (
    <section>
      <h3>GIFs</h3>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={gifPrefs.pauseWhenUnfocused}
          onChange={(e) => setGifPrefs({ ...gifPrefs, pauseWhenUnfocused: e.target.checked })}
        />
        Pause GIFs when this window isn't focused
      </label>
      <label className="select-row">
        Stop playing GIFs
        <select
          value={gifPrefs.stopAfter}
          onChange={(e) => setGifPrefs({ ...gifPrefs, stopAfter: e.target.value as GifStopAfter })}
        >
          {GIF_STOP_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <p className="hint settings-hint">Hover or tap a stopped GIF to play it again.</p>
    </section>
  );
}

// ---- Sounds ------------------------------------------------------------------

function SoundsSection({ voice }: { voice: Voice }) {
  const settings = voice.audioSettings;
  return (
    <section>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={settings.joinLeaveSounds}
          onChange={(e) => {
            voice.setAudioSettings({ ...settings, joinLeaveSounds: e.target.checked });
            if (e.target.checked) playJoinSound(voice.deviceSettings.audiooutput);
          }}
        />
        Play a sound when someone joins or leaves voice
      </label>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={settings.mentionSound}
          onChange={(e) => {
            voice.setAudioSettings({ ...settings, mentionSound: e.target.checked });
            if (e.target.checked) playMentionSound(voice.deviceSettings.audiooutput);
          }}
        />
        Play a sound when someone mentions you
      </label>
    </section>
  );
}
