import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Channel, type User } from "../api.ts";
import { imageThumbnail, videoThumbnail } from "../thumbnails.ts";
import { displayName } from "../users.tsx";
import { adminApi, formatAge, formatBytes, type MediaFilter, type MediaItem } from "./adminApi.ts";
import { OrphansCard, RetentionCard } from "./MediaCleanup.tsx";
import { useSudo } from "./sudo.tsx";

const EMPTY_FILTER: MediaFilter = { type: "", userId: "", channelId: "", olderThanDays: "", status: "", sort: "newest" };
const VIEW_KEY = "disconverse.adminMediaView";

type View = "grid" | "list";

/** What's selected: specific files, or every file matching the current filter. */
type Selection = { mode: "some"; ids: Map<string, number> } | { mode: "all" };

function initialView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

export function Media() {
  const withSudo = useSudo();
  const [filter, setFilter] = useState<MediaFilter>(EMPTY_FILTER);
  const [view, setView] = useState<View>(initialView);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [totals, setTotals] = useState({ files: 0, bytes: 0 });
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [selection, setSelection] = useState<Selection>({ mode: "some", ids: new Map() });
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const sentinel = useRef<HTMLDivElement>(null);
  const requestId = useRef(0);

  useEffect(() => {
    void api.users().then(({ users }) => setUsers(users));
    void fetch("/api/channels")
      .then((r) => r.json())
      .then((d: { channels: Channel[] }) => setChannels(d.channels.filter((c) => c.type === "text")));
  }, []);

  const load = useCallback(
    async (offset: number) => {
      const id = ++requestId.current;
      setLoading(true);
      setError(null);
      try {
        const page = await adminApi.media(filter, offset);
        if (id !== requestId.current) return; // the filter changed meanwhile
        setItems((prev) => (offset ? [...prev, ...page.items] : page.items));
        setTotals(page.totals);
        setNextOffset(page.nextOffset);
      } catch (err) {
        if (id === requestId.current) setError(err instanceof Error ? err.message : "Couldn't load media");
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [filter],
  );

  const reload = useCallback(() => {
    setSelection({ mode: "some", ids: new Map() });
    void load(0);
  }, [load]);

  useEffect(reload, [reload]);

  // Infinite scroll: load the next page when the end of the list comes into view.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || nextOffset === null || loading) return;
    const observer = new IntersectionObserver(([entry]) => entry?.isIntersecting && void load(nextOffset), {
      rootMargin: "600px",
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [nextOffset, loading, load]);

  const chooseView = (v: View) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // not essential
    }
  };

  // ---- selection
  const isSelected = (item: MediaItem) => selection.mode === "all" || selection.ids.has(item.id);
  const toggle = (item: MediaItem) =>
    setSelection((prev) => {
      // Unticking one file while "all matching" is selected falls back to the loaded files minus that one.
      const ids = prev.mode === "all" ? new Map(items.map((i) => [i.id, i.size])) : new Map(prev.ids);
      if (!ids.delete(item.id)) ids.set(item.id, item.size);
      return { mode: "some", ids };
    });
  const allLoadedSelected = items.length > 0 && items.every(isSelected);
  const toggleAllLoaded = () =>
    setSelection(allLoadedSelected ? { mode: "some", ids: new Map() } : { mode: "some", ids: new Map(items.map((i) => [i.id, i.size])) });

  const selectedCount = selection.mode === "all" ? totals.files : selection.ids.size;
  const selectedBytes =
    selection.mode === "all" ? totals.bytes : [...selection.ids.values()].reduce((a, b) => a + b, 0);

  const deleteSelected = async () => {
    setConfirming(false);
    setMessage(null);
    setError(null);
    try {
      const result = await withSudo(() =>
        selection.mode === "all"
          ? adminApi.deleteMatching(filter, totals.files)
          : adminApi.deleteMedia([...selection.ids.keys()]),
      );
      setMessage(`Deleted ${result.files.toLocaleString()} file${result.files === 1 ? "" : "s"} (${formatBytes(result.bytes)}).`);
      reload();
    } catch (err) {
      if ((err as Error).message !== "Cancelled") setError((err as Error).message);
    }
  };

  const set = (patch: Partial<MediaFilter>) => setFilter((f) => ({ ...f, ...patch }));
  const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

  return (
    <>
      <h1>Media</h1>
      <p className="hint">
        Images and videos uploaded to chat. Deleting removes the file from the server; the message stays and shows
        "removed by an admin".
      </p>

      <ThumbnailBackfill onDone={() => void load(0)} />

      <div className="admin-filters">
        <select value={filter.type} onChange={(e) => set({ type: e.target.value as MediaFilter["type"] })}>
          <option value="">All types</option>
          <option value="image">Images</option>
          <option value="video">Videos</option>
        </select>
        <select value={filter.userId} onChange={(e) => set({ userId: e.target.value })}>
          <option value="">Anyone</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {displayName(u)}
            </option>
          ))}
        </select>
        <select value={filter.channelId} onChange={(e) => set({ channelId: e.target.value })}>
          <option value="">Any channel</option>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              #{c.name}
            </option>
          ))}
        </select>
        <select value={filter.olderThanDays} onChange={(e) => set({ olderThanDays: e.target.value })}>
          <option value="">Any age</option>
          <option value="7">Older than a week</option>
          <option value="30">Older than a month</option>
          <option value="90">Older than 3 months</option>
          <option value="365">Older than a year</option>
        </select>
        <select value={filter.status} onChange={(e) => set({ status: e.target.value as MediaFilter["status"] })}>
          <option value="">Sent and unsent</option>
          <option value="sent">Sent in messages</option>
          <option value="unsent">Unsent uploads</option>
        </select>
        <select value={filter.sort} onChange={(e) => set({ sort: e.target.value as MediaFilter["sort"] })}>
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="size">Largest first</option>
        </select>
        <div className="view-toggle" role="group" aria-label="View">
          <button className={view === "grid" ? "active" : ""} onClick={() => chooseView("grid")}>
            Grid
          </button>
          <button className={view === "list" ? "active" : ""} onClick={() => chooseView("list")}>
            List
          </button>
        </div>
      </div>

      <div className="admin-toolbar">
        <label className="checkbox-row">
          <input type="checkbox" checked={allLoadedSelected} onChange={toggleAllLoaded} disabled={!items.length} />
          Select all shown
        </label>
        <span className="hint">
          {plural(totals.files, "file")} · {formatBytes(totals.bytes)}
        </span>
        <button className="danger" disabled={!selectedCount} onClick={() => setConfirming(true)}>
          Delete {selectedCount ? `${selectedCount.toLocaleString()} selected (${formatBytes(selectedBytes)})` : "selected"}
        </button>
      </div>

      {/* Gmail-style: after selecting everything loaded, offer everything matching the filter. */}
      {selection.mode === "some" && allLoadedSelected && totals.files > items.length && (
        <p className="select-all-banner">
          All {items.length.toLocaleString()} loaded files are selected.{" "}
          <button className="link" onClick={() => setSelection({ mode: "all" })}>
            Select all {plural(totals.files, "file")} matching these filters
          </button>
        </p>
      )}
      {selection.mode === "all" && (
        <p className="select-all-banner">
          All {plural(totals.files, "file")} matching these filters are selected ({formatBytes(totals.bytes)}).{" "}
          <button className="link" onClick={() => setSelection({ mode: "some", ids: new Map() })}>
            Clear selection
          </button>
        </p>
      )}

      {message && <p className="admin-success">{message}</p>}
      {error && <p className="form-error">{error}</p>}

      {view === "grid" ? (
        <div className="media-grid">
          {items.map((item) => (
            <div key={item.id} className={`media-card${isSelected(item) ? " selected" : ""}`}>
              <input type="checkbox" checked={isSelected(item)} onChange={() => toggle(item)} aria-label={`Select ${item.filename}`} />
              <a className="media-thumb" href={item.url} target="_blank" rel="noreferrer" title="Open the original">
                <Thumb item={item} />
              </a>
              <div className="media-meta">
                <span className="media-name" title={item.filename}>
                  {item.filename}
                </span>
                <span className="hint">
                  {formatBytes(item.size)} · {formatAge(item.createdAt)}
                </span>
                <span className="hint">
                  {item.uploader} · {item.channelName ? `#${item.channelName}` : "unsent"}
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <table className="admin-table media-list">
          <thead>
            <tr>
              <th />
              <th />
              <th>File</th>
              <th className="admin-table-num">Size</th>
              <th>Member</th>
              <th>Channel</th>
              <th className="admin-table-num">Uploaded</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className={isSelected(item) ? "selected" : ""} onClick={() => toggle(item)}>
                <td onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={isSelected(item)} onChange={() => toggle(item)} aria-label={`Select ${item.filename}`} />
                </td>
                <td className="media-list-thumb">
                  <Thumb item={item} />
                </td>
                <td className="media-name">
                  <a href={item.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                    {item.filename}
                  </a>
                </td>
                <td className="admin-table-num">{formatBytes(item.size)}</td>
                <td>{item.uploader}</td>
                <td>{item.channelName ? `#${item.channelName}` : <span className="hint">unsent</span>}</td>
                <td className="admin-table-num hint">{formatAge(item.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!items.length && !loading && !error && <p className="hint">No media matches these filters.</p>}
      <div ref={sentinel} />
      {loading && <p className="hint admin-more">Loading…</p>}

      <RetentionCard onApplied={() => void load(0)} />
      <OrphansCard />

      {confirming && (
        <div className="modal-backdrop" onClick={() => setConfirming(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <header className="modal-header">
              <h2>Delete {plural(selectedCount, "file")}?</h2>
            </header>
            <p>
              This permanently deletes {formatBytes(selectedBytes)} from the server
              {selection.mode === "all" ? ", every file matching the current filters" : ""}. Messages that contained
              them will show "removed by an admin".
            </p>
            <div className="modal-actions">
              <button className="secondary" onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button className="danger" onClick={() => void deleteSelected()}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** The stored preview; never the original (which can be tens of MB). */
function Thumb({ item }: { item: MediaItem }) {
  if (item.thumbUrl) return <img src={item.thumbUrl} alt="" loading="lazy" />;
  return <span className="media-placeholder">{item.mime.startsWith("video/") ? "▶ video" : "image"}</span>;
}

/** Generates previews for files uploaded before thumbnails existed, in this browser. */
function ThumbnailBackfill({ onDone }: { onDone: () => void }) {
  const [missing, setMissing] = useState<{ id: string; mime: string; url: string }[] | null>(null);
  const [progress, setProgress] = useState<{ done: number; failed: number } | null>(null);

  useEffect(() => {
    void adminApi.missingThumbs().then(({ items }) => setMissing(items));
  }, []);

  if (!missing?.length) return null;

  const run = async () => {
    let done = 0;
    let failed = 0;
    setProgress({ done, failed });
    const queue = [...missing];
    // A few at a time: fast, without hammering the server or this browser.
    const worker = async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        try {
          const thumb = item.mime.startsWith("video/")
            ? await videoThumbnail(item.url) // the video element only downloads what it needs
            : await imageThumbnail(await (await fetch(item.url)).blob());
          if (!thumb) throw new Error("unreadable");
          await adminApi.uploadThumb(item.id, thumb);
          done++;
        } catch {
          failed++;
        }
        setProgress({ done, failed });
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    const { items } = await adminApi.missingThumbs();
    setMissing(items);
    setProgress({ done, failed });
    onDone();
  };

  const total = missing.length;
  return (
    <div className="backfill-banner">
      {progress ? (
        <>
          <span>
            Generating previews… {(progress.done + progress.failed).toLocaleString()} of {total.toLocaleString()}
            {progress.failed ? ` (${progress.failed} couldn't be read by this browser)` : ""}
          </span>
          <div className="usage-bar small">
            <div className="usage-app" style={{ width: `${((progress.done + progress.failed) / total) * 100}%` }} />
          </div>
        </>
      ) : (
        <>
          <span>
            {total.toLocaleString()} file{total === 1 ? " has" : "s have"} no preview yet (uploaded before previews existed).
          </span>
          <button className="primary" onClick={() => void run()}>
            Generate previews
          </button>
        </>
      )}
    </div>
  );
}
