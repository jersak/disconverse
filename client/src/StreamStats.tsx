import type { VideoTrack } from "livekit-client";
import { useEffect, useRef, useState } from "react";

type Row = { label: string; value: string };

type RtpStats = RTCStats & {
  kind?: string;
  rid?: string;
  codecId?: string;
  frameWidth?: number;
  frameHeight?: number;
  framesPerSecond?: number;
  bytesSent?: number;
  bytesReceived?: number;
  framesDropped?: number;
  packetsLost?: number;
  jitter?: number;
  encoderImplementation?: string;
  decoderImplementation?: string;
  powerEfficientEncoder?: boolean;
  powerEfficientDecoder?: boolean;
  qualityLimitationReason?: string;
  mimeType?: string;
};

const kbps = (bytes: number, prevBytes: number | undefined, ms: number) =>
  prevBytes === undefined ? "…" : `${Math.round(((bytes - prevBytes) * 8) / ms)} kbps`;

const hw = (impl?: string, efficient?: boolean) =>
  `${impl ?? "?"}${efficient === undefined ? "" : efficient ? " (hardware)" : " (software)"}`;

/** Live WebRTC stats for one video track, to diagnose choppy streams. */
export function StreamStats({ track, isLocal }: { track: VideoTrack; isLocal: boolean }) {
  const [rows, setRows] = useState<Row[]>([]);
  const prev = useRef<{ time: number; bytes: Map<string, number> }>({ time: 0, bytes: new Map() });

  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      const report = await track.getRTCStatsReport();
      if (stopped || !report) return;
      const all = [...report.values()] as RtpStats[];
      const codec = (id?: string) => all.find((s) => s.id === id)?.mimeType?.replace("video/", "") ?? "?";
      const now = performance.now();
      const elapsed = now - prev.current.time;
      const bytes = new Map<string, number>();
      const out: Row[] = [];

      if (isLocal) {
        const layers = all
          .filter((s) => s.type === "outbound-rtp" && s.kind === "video")
          .sort((a, b) => (b.frameHeight ?? 0) - (a.frameHeight ?? 0));
        if (layers[0]) {
          out.push({ label: "Codec", value: codec(layers[0].codecId) });
          out.push({ label: "Encoder", value: hw(layers[0].encoderImplementation, layers[0].powerEfficientEncoder) });
          out.push({ label: "Limited by", value: layers[0].qualityLimitationReason ?? "?" });
        }
        for (const l of layers) {
          bytes.set(l.id, l.bytesSent ?? 0);
          out.push({
            label: `Layer ${l.rid || "main"}`,
            value: `${l.frameWidth ?? 0}×${l.frameHeight ?? 0} @ ${Math.round(l.framesPerSecond ?? 0)} fps, ${kbps(l.bytesSent ?? 0, prev.current.bytes.get(l.id), elapsed)}`,
          });
        }
      } else {
        const s = all.find((x) => x.type === "inbound-rtp" && x.kind === "video");
        if (s) {
          bytes.set(s.id, s.bytesReceived ?? 0);
          out.push(
            { label: "Codec", value: codec(s.codecId) },
            { label: "Decoder", value: hw(s.decoderImplementation, s.powerEfficientDecoder) },
            { label: "Receiving", value: `${s.frameWidth ?? 0}×${s.frameHeight ?? 0} @ ${Math.round(s.framesPerSecond ?? 0)} fps` },
            { label: "Bitrate", value: kbps(s.bytesReceived ?? 0, prev.current.bytes.get(s.id), elapsed) },
            { label: "Dropped frames", value: String(s.framesDropped ?? 0) },
            { label: "Packets lost", value: String(s.packetsLost ?? 0) },
            { label: "Jitter", value: `${Math.round((s.jitter ?? 0) * 1000)} ms` },
          );
        }
      }
      prev.current = { time: now, bytes };
      setRows(out.length ? out : [{ label: "Stats", value: "waiting for data…" }]);
    };
    void poll();
    const timer = setInterval(() => void poll(), 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [track, isLocal]);

  return (
    <div className="stream-stats" onClick={(e) => e.stopPropagation()}>
      {rows.map((r) => (
        <div key={r.label}>
          <span>{r.label}</span> {r.value}
        </div>
      ))}
    </div>
  );
}
