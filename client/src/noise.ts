// Microphone processing: ML noise suppression (RNNoise or GTCRN, both run locally as WebAssembly)
// and an optional noise gate ("input sensitivity"). Plugged into LiveKit as a track processor.
import {
  GtcrnWorkletNode,
  loadGtcrn,
  loadRnnoise,
  NoiseGateWorkletNode,
  RnnoiseWorkletNode,
} from "@sapphi-red/web-noise-suppressor";
import gtcrnWasmUrl from "@sapphi-red/web-noise-suppressor/gtcrn.wasm?url";
import gtcrnWorkletUrl from "@sapphi-red/web-noise-suppressor/gtcrnWorklet.js?url";
import noiseGateWorkletUrl from "@sapphi-red/web-noise-suppressor/noiseGateWorklet.js?url";
import rnnoiseWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import rnnoiseWorkletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import type { AudioProcessorOptions, Track, TrackProcessor } from "livekit-client";

export type Suppression = "off" | "standard" | "high";

export type AudioSettings = {
  /** off = browser's built-in suppression only; standard = RNNoise; high = GTCRN */
  suppression: Suppression;
  /** Noise gate on: audio below `gateThreshold` (dBFS) is silenced. Off = always transmit. */
  gate: boolean;
  gateThreshold: number;
  /** Chime when people join or leave the voice channel. */
  joinLeaveSounds: boolean;
  /** Ping when someone mentions you in a channel you're not looking at. */
  mentionSound: boolean;
};

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  suppression: "standard",
  gate: false,
  gateThreshold: -50,
  joinLeaveSounds: true,
  mentionSound: true,
};

const STORAGE_KEY = "disconverse.audio";

export function loadAudioSettings(): AudioSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    return { ...DEFAULT_AUDIO_SETTINGS, ...saved };
  } catch {
    return DEFAULT_AUDIO_SETTINGS;
  }
}

export function saveAudioSettings(settings: AudioSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable (private mode): settings just won't persist.
  }
}

/** Whether our processor needs to run at all for these settings. */
export const needsProcessor = (s: AudioSettings) => s.suppression !== "off" || s.gate;

// Model binaries are fetched once per page load.
let rnnoiseBinary: Promise<ArrayBuffer> | undefined;
let gtcrnBinary: Promise<ArrayBuffer> | undefined;

const GATE_HOLD_MS = 300;
const GATE_HYSTERESIS_DB = 6;

export class MicProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  name = "disconverse-mic";
  processedTrack?: MediaStreamTrack;

  private settings: AudioSettings;
  private ctx?: AudioContext;
  private nodes: AudioNode[] = [];
  private analyser?: AnalyserNode;
  private samples?: Float32Array<ArrayBuffer>;

  constructor(settings: AudioSettings) {
    this.settings = settings;
  }

  async init({ track }: AudioProcessorOptions) {
    // Both models run natively at 48 kHz, so use our own context rather than the room's.
    const ctx = new AudioContext({ sampleRate: 48_000 });
    this.ctx = ctx;
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    this.nodes.push(source);
    let last: AudioNode = source;
    const chain = (node: AudioNode) => {
      last.connect(node);
      last = node;
      this.nodes.push(node);
    };

    const { suppression, gate, gateThreshold } = this.settings;
    if (suppression === "standard") {
      rnnoiseBinary ??= loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl });
      const [wasmBinary] = await Promise.all([rnnoiseBinary, ctx.audioWorklet.addModule(rnnoiseWorkletUrl)]);
      chain(new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary }));
    } else if (suppression === "high") {
      gtcrnBinary ??= loadGtcrn({ url: gtcrnWasmUrl });
      const [wasmBinary] = await Promise.all([gtcrnBinary, ctx.audioWorklet.addModule(gtcrnWorkletUrl)]);
      chain(new GtcrnWorkletNode(ctx, { maxChannels: 1, wasmBinary }));
    }

    // Level meter taps the signal before the gate, so it shows your voice against the threshold.
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    last.connect(analyser);
    this.analyser = analyser;
    this.samples = new Float32Array(analyser.fftSize);

    if (gate) {
      await ctx.audioWorklet.addModule(noiseGateWorkletUrl);
      chain(
        new NoiseGateWorkletNode(ctx, {
          openThreshold: gateThreshold,
          closeThreshold: gateThreshold - GATE_HYSTERESIS_DB,
          holdMs: GATE_HOLD_MS,
          maxChannels: 1,
        }),
      );
    }

    const destination = ctx.createMediaStreamDestination();
    last.connect(destination);
    this.processedTrack = destination.stream.getAudioTracks()[0];
    await ctx.resume();
  }

  async restart(opts: AudioProcessorOptions) {
    await this.destroy();
    await this.init(opts);
  }

  async destroy() {
    for (const node of this.nodes) {
      node.disconnect();
      (node as { destroy?: () => void }).destroy?.();
    }
    this.nodes = [];
    this.analyser?.disconnect();
    this.analyser = undefined;
    this.processedTrack?.stop();
    this.processedTrack = undefined;
    await this.ctx?.close().catch(() => {});
    this.ctx = undefined;
  }

  /** Current input level in dBFS (before the gate), or -Infinity when silent. */
  level(): number {
    if (!this.analyser || !this.samples) return -Infinity;
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (const s of this.samples) sum += s * s;
    return 10 * Math.log10(sum / this.samples.length);
  }
}
