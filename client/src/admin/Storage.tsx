import { useEffect, useState } from "react";
import { adminApi, formatBytes, type StorageRow } from "./adminApi.ts";

export function Storage() {
  const [data, setData] = useState<{ byUser: StorageRow[]; byChannel: StorageRow[] } | null>(null);

  useEffect(() => {
    void adminApi.storage().then(setData);
  }, []);

  if (!data) return <p className="hint">Loading…</p>;

  return (
    <>
      <h1>Storage</h1>
      <p className="hint">Space used by uploaded media (profile pictures and the database not included).</p>
      <StorageTable title="By member" rows={data.byUser} />
      <StorageTable title="By channel" rows={data.byChannel} prefix="#" />
    </>
  );
}

function StorageTable({ title, rows, prefix = "" }: { title: string; rows: StorageRow[]; prefix?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.bytes));
  return (
    <section className="admin-card">
      <h2>{title}</h2>
      <table className="admin-table">
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="admin-table-name">
                {prefix}
                {r.name}
              </td>
              <td className="admin-table-bar">
                <div className="usage-bar small">
                  <div className="usage-app" style={{ width: `${(r.bytes / max) * 100}%` }} />
                </div>
              </td>
              <td className="admin-table-num">{formatBytes(r.bytes)}</td>
              <td className="admin-table-num hint">
                {r.files} file{r.files === 1 ? "" : "s"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
