import { useEffect, useState } from "react";
import { adminApi, formatBytes, type AuditEntry } from "./adminApi.ts";

const DESCRIBE: Record<string, (d: Record<string, any>) => string> = {
  "media.delete": (d) => `Deleted ${d.files} media file(s), ${formatBytes(d.bytes ?? 0)}`,
  "retention.update": (d) =>
    `Set automatic cleanup: images ${d.imageDays ? `after ${d.imageDays} days` : "kept"}, videos ${d.videoDays ? `after ${d.videoDays} days` : "kept"}`,
  "retention.run": (d) => `Automatic cleanup removed ${d.files} file(s), ${formatBytes(d.bytes ?? 0)}`,
  "orphans.delete": (d) => `Removed ${d.files} leftover profile picture(s)`,
  "role.change": (d) => `Changed ${d.user}'s role from ${d.from} to ${d.to}`,
  "channel.create": (d) => `Created ${d.type} channel ${d.type === "text" ? "#" : ""}${d.name}`,
  "channel.rename": (d) => `Renamed ${d.type} channel ${d.from} to ${d.to}`,
  "channel.delete": (d) => `Deleted ${d.type} channel ${d.type === "text" ? "#" : ""}${d.name}${d.files ? ` (${d.files} files)` : ""}`,
};

const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function Audit() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [more, setMore] = useState(false);

  const load = async (before?: number) => {
    const { entries: page } = await adminApi.audit(before);
    setEntries((prev) => (before && prev ? [...prev, ...page] : page));
    setMore(page.length === 100);
  };

  useEffect(() => {
    void load();
  }, []);

  if (!entries) return <p className="hint">Loading…</p>;

  return (
    <>
      <h1>Audit log</h1>
      <p className="hint">Administrative actions on this server. This log can't be cleared from the app.</p>
      <section className="admin-card">
        {entries.length === 0 ? (
          <p className="hint">Nothing recorded yet.</p>
        ) : (
          <table className="admin-table">
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="admin-table-num hint">{timeFormat.format(new Date(e.createdAt))}</td>
                  <td className="admin-table-name">{e.actor ?? "Server"}</td>
                  <td>{DESCRIBE[e.action]?.(e.details) ?? `${e.action} ${JSON.stringify(e.details)}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {more && (
        <button className="secondary admin-more" onClick={() => void load(entries[entries.length - 1]!.id)}>
          Load older
        </button>
      )}
    </>
  );
}
