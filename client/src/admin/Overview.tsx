import { useEffect, useState } from "react";
import { adminApi, formatBytes, formatUptime, type Overview } from "./adminApi.ts";

export function OverviewPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      adminApi
        .overview()
        .then(setData)
        .catch((err) => setError(err.message));
    load();
    const timer = setInterval(load, 15_000); // live numbers stay fresh
    return () => clearInterval(timer);
  }, []);

  if (error) return <p className="form-error">{error}</p>;
  if (!data) return <p className="hint">Loading…</p>;

  const s = data.storage;
  const appBytes = s.images.bytes + s.videos.bytes + s.unsent.bytes + s.avatars.bytes + s.database.bytes;
  const breakdown = [
    { label: "Images", bytes: s.images.bytes, detail: `${s.images.files} files`, color: "#5865f2" },
    { label: "Videos", bytes: s.videos.bytes, detail: `${s.videos.files} files`, color: "#eb459e" },
    { label: "Profile pictures", bytes: s.avatars.bytes, color: "#23a55a" },
    { label: "Database", bytes: s.database.bytes, color: "#f0b232" },
    { label: "Unsent uploads", bytes: s.unsent.bytes, detail: `${s.unsent.files} files, removed after 24 h`, color: "#949ba4" },
  ];

  return (
    <>
      <h1>Overview</h1>

      <section className="admin-card">
        <h2>Drives</h2>
        {data.drives.map((d) => {
          const usedPct = (d.used / d.total) * 100;
          const appPct = Math.min(usedPct, (d.app / d.total) * 100);
          return (
            <div key={d.label} className="drive">
              <div className="drive-head">
                <strong>{d.label}</strong>
                <span className="hint">
                  {formatBytes(d.free)} free of {formatBytes(d.total)}
                </span>
              </div>
              <div className="usage-bar" title={`${usedPct.toFixed(1)}% used`}>
                <div className="usage-other" style={{ width: `${usedPct}%` }} />
                <div className="usage-app" style={{ width: `${appPct}%` }} />
              </div>
              <div className="hint">
                {formatBytes(d.used)} used ({usedPct.toFixed(0)}%) · Disconverse: {formatBytes(d.app)}
              </div>
            </div>
          );
        })}
      </section>

      <section className="admin-card">
        <h2>Disconverse storage · {formatBytes(appBytes)}</h2>
        <div className="usage-bar stacked">
          {breakdown.map((b) => (
            <div key={b.label} style={{ width: `${appBytes ? (b.bytes / appBytes) * 100 : 0}%`, background: b.color }} title={b.label} />
          ))}
        </div>
        <ul className="legend">
          {breakdown.map((b) => (
            <li key={b.label}>
              <span className="swatch" style={{ background: b.color }} />
              <span>{b.label}</span>
              <span className="legend-value">{formatBytes(b.bytes)}</span>
              {b.detail && <span className="hint">{b.detail}</span>}
            </li>
          ))}
        </ul>
      </section>

      <div className="admin-stats">
        <Stat label="Members" value={data.counts.users} />
        <Stat label="Messages" value={data.counts.messages} />
        <Stat label="Channels" value={`${data.counts.textChannels} text · ${data.counts.voiceChannels} voice`} />
        <Stat label="Unused invites" value={data.counts.unusedInvites} />
        <Stat label="Online now" value={data.live.online} />
        <Stat label="In voice now" value={data.live.inVoice} />
      </div>

      <section className="admin-card">
        <h2>Server</h2>
        <dl className="admin-facts">
          <dt>Version</dt>
          <dd>{data.server.version}</dd>
          <dt>Running for</dt>
          <dd>{formatUptime(data.server.startedAt)}</dd>
          <dt>Node.js</dt>
          <dd>{data.server.node}</dd>
        </dl>
      </section>
    </>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="admin-stat">
      <div className="admin-stat-value">{value}</div>
      <div className="hint">{label}</div>
    </div>
  );
}
