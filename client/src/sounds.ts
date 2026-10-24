// Short UI sounds synthesized with Web Audio (no audio files to ship or license).

type SinkableContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };

let ctx: SinkableContext | undefined;
let currentSink = "";

function context(sinkId: string): SinkableContext {
  ctx ??= new AudioContext();
  // Follow the chosen output device where supported (Chrome/Edge); otherwise the system default.
  if (sinkId !== currentSink && ctx.setSinkId) {
    currentSink = sinkId;
    void ctx.setSinkId(sinkId).catch(() => {});
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

/** Plays notes back to back: [frequency Hz, duration s]. */
function chime(notes: [number, number][], sinkId: string, volume = 0.12) {
  const audio = context(sinkId);
  let t = audio.currentTime + 0.01;
  for (const [freq, duration] of notes) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    // Soft attack and exponential decay: a bell-like blip rather than a beep.
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(volume, t + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(gain).connect(audio.destination);
    osc.start(t);
    osc.stop(t + duration + 0.02);
    t += duration * 0.6; // notes overlap slightly
  }
}

// E5 → A5 rising, A5 → D5 falling.
export const playJoinSound = (sinkId = "") => chime([[659.25, 0.16], [880, 0.24]], sinkId);
export const playLeaveSound = (sinkId = "") => chime([[880, 0.16], [587.33, 0.26]], sinkId);
// Two quick high notes (B5, E6): distinct from the voice chimes.
export const playMentionSound = (sinkId = "") => chime([[987.77, 0.1], [1318.51, 0.2]], sinkId, 0.1);
