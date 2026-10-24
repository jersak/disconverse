import { useEffect, useState } from "react";
import { adminApi, formatBytes, type Retention } from "./adminApi.ts";
import { useSudo } from "./sudo.tsx";

const RETENTION_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Keep forever" },
  { value: "30", label: "Delete after 30 days" },
  { value: "90", label: "Delete after 90 days" },
  { value: "180", label: "Delete after 6 months" },
  { value: "365", label: "Delete after 1 year" },
];

const toDays = (v: string) => (v ? Number(v) : null);

export function RetentionCard({ onApplied }: { onApplied: () => void }) {
  const withSudo = useSudo();
  const [saved, setSaved] = useState<Retention | null>(null);
  const [images, setImages] = useState("");
  const [videos, setVideos] = useState("");
  const [preview, setPreview] = useState<{ files: number; bytes: number } | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    void adminApi.retention().then(({ policy }) => {
      setSaved(policy);
      setImages(policy.imageDays ? String(policy.imageDays) : "");
      setVideos(policy.videoDays ? String(policy.videoDays) : "");
    });
  }, []);

  const policy: Retention = { imageDays: toDays(images), videoDays: toDays(videos) };
  const changed = saved !== null && (saved.imageDays !== policy.imageDays || saved.videoDays !== policy.videoDays);

  useEffect(() => {
    void adminApi.previewRetention(policy).then(setPreview).catch(() => setPreview(null));
  }, [images, videos]);

  const save = async () => {
    setStatus(null);
    try {
      const result = await withSudo(() => adminApi.saveRetention(policy));
      setSaved(result.policy);
      setStatus("Saved. Matching media is being removed now; the policy then runs every hour.");
      setTimeout(onApplied, 1500);
    } catch (err) {
      if ((err as Error).message !== "Cancelled") setStatus((err as Error).message);
    }
  };

  return (
    <section className="admin-card">
      <h2>Automatic cleanup</h2>
      <p className="hint">Delete old media automatically. Messages stay; their files show as removed.</p>
      <div className="admin-filters">
        <label>
          Images
          <select value={images} onChange={(e) => setImages(e.target.value)}>
            {RETENTION_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Videos
          <select value={videos} onChange={(e) => setVideos(e.target.value)}>
            {RETENTION_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <button className="primary" disabled={!changed} onClick={() => void save()}>
          Save
        </button>
      </div>
      {preview && (policy.imageDays || policy.videoDays) && (
        <p className={preview.files ? "admin-warning" : "hint"}>
          {preview.files
            ? `With this policy, ${preview.files} file${preview.files === 1 ? "" : "s"} (${formatBytes(preview.bytes)}) would be deleted right away.`
            : "Nothing is old enough to be deleted yet."}
        </p>
      )}
      {status && <p className="hint">{status}</p>}
    </section>
  );
}

export function OrphansCard() {
  const withSudo = useSudo();
  const [orphans, setOrphans] = useState<{ files: number; bytes: number } | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const load = () => void adminApi.orphans().then((o) => setOrphans(o.avatars));
  useEffect(load, []);

  const clean = async () => {
    try {
      const result = await withSudo(() => adminApi.deleteOrphans());
      setStatus(`Removed ${result.files} file${result.files === 1 ? "" : "s"} (${formatBytes(result.bytes)}).`);
      load();
    } catch (err) {
      if ((err as Error).message !== "Cancelled") setStatus((err as Error).message);
    }
  };

  return (
    <section className="admin-card">
      <h2>Leftover files</h2>
      <p className="hint">Profile pictures no longer used by anyone (normally cleaned up automatically).</p>
      {orphans && (
        <div className="admin-toolbar">
          <span>
            {orphans.files} file{orphans.files === 1 ? "" : "s"} · {formatBytes(orphans.bytes)}
          </span>
          <button className="danger" disabled={!orphans.files} onClick={() => void clean()}>
            Clean up
          </button>
        </div>
      )}
      {status && <p className="hint">{status}</p>}
    </section>
  );
}
