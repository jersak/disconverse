import {
  Room,
  RoomEvent,
  Track,
  VideoPreset,
  VideoPresets,
  type AudioCaptureOptions,
  type LocalAudioTrack,
  type Participant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type VideoTrack,
} from "livekit-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import {
  deviceIdOrDefault,
  loadDeviceSettings,
  saveDeviceSettings,
  type DeviceKind,
  type DeviceLists,
  type DeviceSettings,
} from "./devices.ts";
import { playJoinSound, playLeaveSound } from "./sounds.ts";
import { MicProcessor, loadAudioSettings, needsProcessor, saveAudioSettings, type AudioSettings } from "./noise.ts";

export type VoiceStatus = "idle" | "connecting" | "connected";

export type ScreenShare = {
  /** Present once the video is available locally (always for our own share, after "Watch" for others). */
  track?: VideoTrack;
  watching: boolean;
  hasAudio: boolean;
};

export type VoiceParticipant = {
  userId: number;
  name: string;
  isLocal: boolean;
  speaking: boolean;
  muted: boolean;
  camera?: VideoTrack;
  screen?: ScreenShare;
};

export type StreamQuality = {
  id: string;
  label: string;
  width: number;
  height: number;
  fps: number;
  bitrate: number;
};

export const STREAM_QUALITIES: StreamQuality[] = [
  { id: "720p30", label: "720p · 30 FPS", width: 1280, height: 720, fps: 30, bitrate: 2_500_000 },
  { id: "1080p30", label: "1080p · 30 FPS", width: 1920, height: 1080, fps: 30, bitrate: 4_000_000 },
  { id: "1080p60", label: "1080p · 60 FPS (recommended)", width: 1920, height: 1080, fps: 60, bitrate: 6_000_000 },
  { id: "1440p60", label: "1440p · 60 FPS (PC viewers)", width: 2560, height: 1440, fps: 60, bitrate: 10_000_000 },
];

/** Firefox encodes video in software and doesn't send a fallback layer for screen shares. */
export const isFirefox = navigator.userAgent.includes("Firefox");

/** Mic constraints: the browser's own noise suppression is only used when ours is off. */
const micCapture = (s: AudioSettings, deviceId: string): AudioCaptureOptions => ({
  deviceId: deviceIdOrDefault(deviceId),
  echoCancellation: true,
  autoGainControl: true,
  noiseSuppression: s.suppression === "off",
  channelCount: 1,
});

/** Mobile browsers can't capture the screen. */
export const canShareScreen = typeof navigator.mediaDevices?.getDisplayMedia === "function";

/** How loud someone's voice or stream sound plays for us (remembered per person on this device). */
export type Playback = { volume: number; muted: boolean };
export const DEFAULT_PLAYBACK: Playback = { volume: 1, muted: false };
/** Voices can be boosted up to 200% (streams up to 100%). */
export const MAX_VOICE_VOLUME = 2;
export type PlaybackKind = "voice" | "stream";
type PlaybackSettings = Record<PlaybackKind, Record<string, Playback>>;
const PLAYBACK_KEYS: Record<PlaybackKind, string> = {
  voice: "disconverse.voiceAudio",
  stream: "disconverse.streamAudio",
};

function loadPlayback(): PlaybackSettings {
  const load = (kind: PlaybackKind) => {
    try {
      return JSON.parse(localStorage.getItem(PLAYBACK_KEYS[kind]) ?? "null") ?? {};
    } catch {
      return {};
    }
  };
  return { voice: load("voice"), stream: load("stream") };
}

/** A voice played louder than 100%: routed through a gain node into its own <audio> element. */
type Boost = { el: HTMLAudioElement; source: MediaStreamAudioSourceNode; gain: GainNode };
let boostContext: AudioContext | null = null;

/** Hidden container holding the <audio> elements for remote participants. */
function audioContainer(): HTMLElement {
  let el = document.getElementById("voice-audio");
  if (!el) {
    el = document.createElement("div");
    el.id = "voice-audio";
    el.hidden = true;
    document.body.appendChild(el);
  }
  return el;
}

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Voice and cameras are always received; screen shares only when the user clicks "Watch".
function subscribeByDefault(pub: RemoteTrackPublication) {
  if (pub.source === Track.Source.Microphone || pub.source === Track.Source.Camera) pub.setSubscribed(true);
}

function toVoiceParticipant(p: Participant, isLocal: boolean): VoiceParticipant {
  const camera = p.getTrackPublication(Track.Source.Camera);
  const screen = p.getTrackPublication(Track.Source.ScreenShare);
  return {
    userId: Number(p.identity),
    name: p.name || p.identity,
    isLocal,
    speaking: p.isSpeaking,
    muted: !p.isMicrophoneEnabled,
    camera: camera && !camera.isMuted ? camera.videoTrack : undefined,
    screen: screen && {
      track: screen.videoTrack,
      watching: isLocal || (screen as RemoteTrackPublication).isDesired,
      hasAudio: !!p.getTrackPublication(Track.Source.ScreenShareAudio),
    },
  };
}

/** Voice channel connection. Mute/deafen persist across joins, like Discord. */
export function useVoice(onMembershipChange: () => void) {
  const [status, setStatus] = useState<VoiceStatus>("idle");
  /** The voice channel we're in (or connecting to). */
  const [channelId, setChannelId] = useState<number | null>(null);
  const [participants, setParticipants] = useState<VoiceParticipant[]>([]);
  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audioSettings, setAudioSettingsState] = useState(loadAudioSettings);
  const [deviceSettings, setDeviceSettings] = useState(loadDeviceSettings);
  const [devices, setDevices] = useState<DeviceLists>({ audioinput: [], audiooutput: [], videoinput: [] });
  const deviceSettingsRef = useRef(deviceSettings);
  deviceSettingsRef.current = deviceSettings;

  const roomRef = useRef<Room | null>(null);
  const channelIdRef = useRef<number | null>(null);
  const processorRef = useRef<MicProcessor | null>(null);
  const audioSettingsRef = useRef(audioSettings);
  audioSettingsRef.current = audioSettings;
  const appliedSuppression = useRef(audioSettings.suppression);
  const deafenedRef = useRef(deafened);
  deafenedRef.current = deafened;
  const [playback, setPlaybackState] = useState(loadPlayback);
  const playbackRef = useRef(playback);
  playbackRef.current = playback;
  /** Boosted voices, by the <audio> element LiveKit attached for them. */
  const boostsRef = useRef(new Map<HTMLMediaElement, Boost>());
  /**
   * Our <audio> element per remote track. Kept here because LiveKit may detach a track itself
   * before reporting it unsubscribed (e.g. when someone leaves), leaving track.detach() empty.
   */
  const audioElementsRef = useRef(new Map<RemoteTrack, HTMLMediaElement>());
  const onChangeRef = useRef(onMembershipChange);
  onChangeRef.current = onMembershipChange;

  /** Re-reads the available devices (names are only visible once mic/camera access was granted). */
  const refreshDevices = useCallback(async () => {
    const list = async (kind: DeviceKind) => {
      try {
        return await Room.getLocalDevices(kind, false);
      } catch {
        return [];
      }
    };
    const [audioinput, audiooutput, videoinput] = await Promise.all([
      list("audioinput"),
      list("audiooutput"),
      list("videoinput"),
    ]);
    setDevices({ audioinput, audiooutput, videoinput });
  }, []);

  useEffect(() => {
    void refreshDevices();
    navigator.mediaDevices?.addEventListener("devicechange", refreshDevices);
    return () => navigator.mediaDevices?.removeEventListener("devicechange", refreshDevices);
  }, [refreshDevices]);

  const deafenedForSounds = useRef(deafened);
  deafenedForSounds.current = deafened;
  /** Join/leave chime, unless turned off or deafened. */
  const chime = useCallback((kind: "join" | "leave") => {
    if (!audioSettingsRef.current.joinLeaveSounds || deafenedForSounds.current) return;
    const sink = deviceSettingsRef.current.audiooutput;
    if (kind === "join") playJoinSound(sink);
    else playLeaveSound(sink);
  }, []);

  const removeBoost = useCallback((el: HTMLMediaElement) => {
    const boost = boostsRef.current.get(el);
    if (!boost) return;
    boost.source.disconnect();
    boost.gain.disconnect();
    boost.el.srcObject = null;
    boost.el.remove();
    boostsRef.current.delete(el);
  }, []);

  /**
   * Element volume can't go above 100%, so a boosted voice plays through Web Audio instead. The
   * original element stays attached (muted): Chrome only delivers remote audio to Web Audio then.
   */
  const boostFor = useCallback((el: HTMLMediaElement): Boost => {
    const existing = boostsRef.current.get(el);
    if (existing) return existing;
    const ctx = (boostContext ??= new AudioContext());
    void ctx.resume();
    const source = ctx.createMediaStreamSource(el.srcObject as MediaStream);
    const gain = ctx.createGain();
    const destination = ctx.createMediaStreamDestination();
    source.connect(gain).connect(destination);
    const out = new Audio();
    out.dataset.boost = "";
    out.srcObject = destination.stream;
    const sink = deviceSettingsRef.current.audiooutput;
    if (sink) void out.setSinkId?.(sink).catch(() => {});
    audioContainer().appendChild(out);
    void out.play().catch(() => {});
    const boost = { el: out, source, gain };
    boostsRef.current.set(el, boost);
    return boost;
  }, []);

  const removeAudioElement = useCallback(
    (track: RemoteTrack) => {
      const el = audioElementsRef.current.get(track);
      if (!el) return;
      removeBoost(el);
      el.remove();
      audioElementsRef.current.delete(track);
    },
    [removeBoost],
  );

  /** Applies deafen and per-person volume/mute to every remote <audio> element. */
  const applyAudioElements = useCallback(() => {
    document.querySelectorAll<HTMLMediaElement>("#voice-audio audio:not([data-boost])").forEach((el) => {
      // iPhones ignore volume (always 1), but muting works everywhere.
      if (el.dataset.stream) {
        // Deafen silences voices only: streams keep playing (e.g. a movie night), with their own mute.
        const s = playbackRef.current.stream[el.dataset.stream] ?? DEFAULT_PLAYBACK;
        el.muted = s.muted;
        el.volume = Math.min(s.volume, 1);
        return;
      }
      const v = (el.dataset.voice && playbackRef.current.voice[el.dataset.voice]) || DEFAULT_PLAYBACK;
      const silent = deafenedRef.current || v.muted;
      if (v.volume > 1 && !silent) {
        boostFor(el).gain.gain.value = v.volume;
        el.muted = true;
      } else {
        removeBoost(el);
        el.muted = silent;
        el.volume = Math.min(v.volume, 1);
      }
    });
  }, [boostFor, removeBoost]);

  /** Sets how loud someone's voice or stream plays for us. */
  const setPlayback = useCallback(
    (kind: PlaybackKind, userId: number, change: Partial<Playback>) => {
      const key = String(userId);
      const current = playbackRef.current;
      const updated = { ...current[kind], [key]: { ...(current[kind][key] ?? DEFAULT_PLAYBACK), ...change } };
      const next = { ...current, [kind]: updated };
      playbackRef.current = next;
      setPlaybackState(next);
      try {
        localStorage.setItem(PLAYBACK_KEYS[kind], JSON.stringify(updated));
      } catch {
        // not essential
      }
      applyAudioElements();
    },
    [applyAudioElements],
  );

  const refresh = useCallback(() => {
    const room = roomRef.current;
    if (!room) {
      setParticipants([]);
      setCameraOn(false);
      setSharing(false);
      return;
    }
    const local = room.localParticipant;
    setParticipants(
      [toVoiceParticipant(local, true), ...Array.from(room.remoteParticipants.values(), (p) => toVoiceParticipant(p, false))].sort(
        (a, b) => a.name.localeCompare(b.name),
      ),
    );
    setCameraOn(local.isCameraEnabled);
    setSharing(local.isScreenShareEnabled);
  }, []);

  /** Attaches, replaces or removes our mic processor to match the current audio settings. */
  const applyProcessor = useCallback(async () => {
    const pub = roomRef.current?.localParticipant.getTrackPublication(Track.Source.Microphone);
    const track = pub?.audioTrack as LocalAudioTrack | undefined;
    if (!track) return;
    const settings = audioSettingsRef.current;
    try {
      if (appliedSuppression.current !== settings.suppression) {
        // Toggle the browser's built-in suppression to complement ours.
        await track.restartTrack(micCapture(settings, deviceSettingsRef.current.audioinput));
        appliedSuppression.current = settings.suppression;
      }
      if (needsProcessor(settings)) {
        const processor = new MicProcessor(settings);
        await track.setProcessor(processor);
        processorRef.current = processor;
      } else if (processorRef.current) {
        await track.stopProcessor();
        processorRef.current = null;
      }
    } catch (err) {
      setError(`Noise suppression unavailable: ${describe(err)}`);
      processorRef.current = null;
      await track.stopProcessor().catch(() => {});
    }
  }, []);

  const setAudioSettings = useCallback((settings: AudioSettings) => {
    setAudioSettingsState(settings);
    saveAudioSettings(settings);
  }, []);

  // Apply setting changes to a live mic, debounced so dragging the sensitivity slider doesn't thrash.
  useEffect(() => {
    if (status !== "connected") return;
    const timer = setTimeout(() => void applyProcessor(), 250);
    return () => clearTimeout(timer);
  }, [audioSettings, status, applyProcessor]);

  /** Mic input level in dBFS for the sensitivity meter; null when not processing. */
  const micLevel = useCallback(() => processorRef.current?.level() ?? null, []);

  const setMicEnabled = useCallback(async (enabled: boolean) => {
    const room = roomRef.current;
    if (!room) return;
    try {
      await room.localParticipant.setMicrophoneEnabled(
        enabled,
        micCapture(audioSettingsRef.current, deviceSettingsRef.current.audioinput),
      );
      if (enabled) await applyProcessor();
      setError(null);
    } catch (err) {
      setError(`Microphone unavailable: ${describe(err)}`);
      setMuted(true);
    }
  }, [applyProcessor]);

  const join = useCallback(async (targetChannelId: number) => {
    if (roomRef.current) {
      if (channelIdRef.current === targetChannelId) return;
      await roomRef.current.disconnect(); // switching channels
    }
    channelIdRef.current = targetChannelId;
    setChannelId(targetChannelId);
    setStatus("connecting");
    setError(null);

    const room = new Room({
      adaptiveStream: true, // receive lower quality when a video is shown small or hidden
      dynacast: true, // stop sending layers nobody is watching
      audioCaptureDefaults: micCapture(audioSettingsRef.current, deviceSettingsRef.current.audioinput),
      videoCaptureDefaults: { deviceId: deviceIdOrDefault(deviceSettingsRef.current.videoinput) },
      audioOutput: { deviceId: deviceSettingsRef.current.audiooutput || "default" },
    });
    roomRef.current = room;
    let joined = false; // only chime on leave if we actually got in

    room
      .on(RoomEvent.TrackPublished, (pub: RemoteTrackPublication) => {
        subscribeByDefault(pub);
        refresh();
      })
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub: RemoteTrackPublication, participant: Participant) => {
        if (track.kind === Track.Kind.Audio) {
          const el = track.attach();
          audioElementsRef.current.set(track, el);
          if (track.source === Track.Source.ScreenShareAudio) el.dataset.stream = participant.identity;
          else el.dataset.voice = participant.identity;
          audioContainer().appendChild(el);
          applyAudioElements();
        }
        refresh();
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        if (track.kind === Track.Kind.Audio) {
          track.detach();
          removeAudioElement(track);
        }
        refresh();
      })
      .on(RoomEvent.ParticipantConnected, () => {
        chime("join");
        refresh();
      })
      .on(RoomEvent.ParticipantDisconnected, () => {
        chime("leave");
        refresh();
      })
      .on(RoomEvent.ActiveSpeakersChanged, refresh)
      .on(RoomEvent.TrackMuted, refresh)
      .on(RoomEvent.TrackUnmuted, refresh)
      .on(RoomEvent.TrackUnpublished, refresh)
      .on(RoomEvent.TrackSubscriptionStatusChanged, refresh)
      .on(RoomEvent.LocalTrackPublished, refresh)
      .on(RoomEvent.LocalTrackUnpublished, () => {
        refresh();
        onChangeRef.current(); // e.g. the browser's "Stop sharing" button
      })
      .on(RoomEvent.Disconnected, () => {
        if (joined) chime("leave");
        // When switching channels a newer room may already be in place; leave its state alone.
        if (roomRef.current !== room) return;
        roomRef.current = null;
        channelIdRef.current = null;
        for (const track of [...audioElementsRef.current.keys()]) removeAudioElement(track);
        processorRef.current = null;
        setChannelId(null);
        setStatus("idle");
        refresh();
        onChangeRef.current();
      });

    try {
      const { url, token } = await api.voiceToken(targetChannelId);
      await room.connect(url, token, { autoSubscribe: false });
      for (const p of room.remoteParticipants.values()) {
        for (const pub of p.trackPublications.values()) subscribeByDefault(pub);
      }
      await room.startAudio();
      joined = true;
      chime("join");
      setStatus("connected");
      refresh();
      if (!muted && !deafened) await setMicEnabled(true);
      void refreshDevices();
      onChangeRef.current();
    } catch (err) {
      setError(`Couldn't join voice: ${describe(err)}`);
      await room.disconnect();
    }
  }, [muted, deafened, refresh, setMicEnabled, refreshDevices, chime, applyAudioElements, removeAudioElement]);

  const leave = useCallback(() => {
    setError(null);
    void roomRef.current?.disconnect();
  }, []);

  const applyDeafen = (value: boolean) => {
    setDeafened(value);
    deafenedRef.current = value;
    applyAudioElements();
  };

  const toggleMute = useCallback(() => {
    const nextMuted = !muted;
    // Unmuting while deafened also undeafens (Discord behaviour).
    if (!nextMuted && deafened) applyDeafen(false);
    setMuted(nextMuted);
    void setMicEnabled(!nextMuted);
  }, [muted, deafened, setMicEnabled]);

  const toggleDeafen = useCallback(() => {
    const next = !deafened;
    applyDeafen(next);
    void setMicEnabled(!next && !muted);
  }, [muted, deafened, setMicEnabled]);

  const toggleCamera = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    const local = room.localParticipant;
    try {
      await local.setCameraEnabled(!local.isCameraEnabled, {
        resolution: VideoPresets.h720.resolution,
        deviceId: deviceIdOrDefault(deviceSettingsRef.current.videoinput),
      });
      setError(null);
    } catch (err) {
      setError(`Camera unavailable: ${describe(err)}`);
    }
    refresh();
    onChangeRef.current();
  }, [refresh]);

  const startScreenShare = useCallback(
    async (quality: StreamQuality) => {
      const room = roomRef.current;
      if (!room) return;
      const motion = quality.fps >= 60;
      try {
        await room.localParticipant.setScreenShareEnabled(
          true,
          {
            // Game/music audio: no voice processing.
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
            systemAudio: "include",
            selfBrowserSurface: "exclude",
            surfaceSwitching: "include",
            resolution: { width: quality.width, height: quality.height, frameRate: quality.fps },
            contentHint: motion ? "motion" : "detail",
          },
          {
            // H.264: hardware encoded on most PCs and hardware decoded on phones (iPhones can't decode VP8 in hardware).
            videoCodec: "h264",
            screenShareEncoding: { maxBitrate: quality.bitrate, maxFramerate: quality.fps },
            // A lower layer for viewers on weaker connections (picked automatically by the SFU).
            screenShareSimulcastLayers:
              quality.height > 720
                ? [new VideoPreset(1280, 720, 1_500_000, 30)]
                : [new VideoPreset(854, 480, 800_000, 15)],
            degradationPreference: motion ? "maintain-framerate" : "maintain-resolution",
          },
        );
        setError(null);
      } catch (err) {
        // Closing the browser's picker is not an error.
        if ((err as Error).name !== "NotAllowedError") setError(`Couldn't share screen: ${describe(err)}`);
      }
      refresh();
      onChangeRef.current();
    },
    [refresh],
  );

  const stopScreenShare = useCallback(async () => {
    await roomRef.current?.localParticipant.setScreenShareEnabled(false);
    refresh();
    onChangeRef.current();
  }, [refresh]);

  /** Start or stop receiving someone's screen share (video and its audio). */
  const watchStream = useCallback(
    (userId: number, watch: boolean) => {
      const p = roomRef.current?.remoteParticipants.get(String(userId));
      if (!p) return;
      for (const source of [Track.Source.ScreenShare, Track.Source.ScreenShareAudio]) {
        (p.getTrackPublication(source) as RemoteTrackPublication | undefined)?.setSubscribed(watch);
      }
      refresh();
    },
    [refresh],
  );

  /** Chooses a device (empty id = system default); switches immediately if in a call. */
  const setDevice = useCallback(async (kind: DeviceKind, deviceId: string) => {
    const next: DeviceSettings = { ...deviceSettingsRef.current, [kind]: deviceId };
    deviceSettingsRef.current = next;
    setDeviceSettings(next);
    saveDeviceSettings(next);
    const room = roomRef.current;
    if (!room) return;
    try {
      await room.switchActiveDevice(kind, deviceId || "default");
      if (kind === "audiooutput") {
        for (const boost of boostsRef.current.values()) await boost.el.setSinkId?.(deviceId || "default");
      }
      setError(null);
    } catch (err) {
      setError(`Couldn't switch device: ${describe(err)}`);
    }
  }, []);

  useEffect(() => () => void roomRef.current?.disconnect(), []);

  return {
    status,
    channelId,
    participants,
    muted,
    deafened,
    cameraOn,
    sharing,
    error,
    join,
    leave,
    toggleMute,
    toggleDeafen,
    toggleCamera,
    startScreenShare,
    stopScreenShare,
    watchStream,
    playback,
    setPlayback,
    audioSettings,
    setAudioSettings,
    micLevel,
    devices,
    deviceSettings,
    refreshDevices,
    setDevice,
  };
}

export type Voice = ReturnType<typeof useVoice>;
