import { ApiError } from "../api.ts";

export type Drive = {
  label: string;
  path: string;
  total: number;
  free: number;
  used: number;
  /** Disconverse's own data on this drive. */
  app: number;
};

export type Overview = {
  drives: Drive[];
  storage: {
    images: { files: number; bytes: number };
    videos: { files: number; bytes: number };
    unsent: { files: number; bytes: number };
    avatars: { bytes: number };
    database: { bytes: number };
  };
  counts: { users: number; messages: number; textChannels: number; voiceChannels: number; unusedInvites: number };
  live: { online: number; inVoice: number };
  server: { version: string; node: string; startedAt: number };
};

export type MediaItem = {
  id: string;
  filename: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  createdAt: number;
  messageId: number | null;
  userId: number;
  uploader: string;
  channelId: number | null;
  channelName: string | null;
  url: string;
  thumbUrl: string | null;
};

export type MediaFilter = {
  type: "" | "image" | "video";
  userId: string;
  channelId: string;
  olderThanDays: string;
  status: "" | "sent" | "unsent";
  sort: "newest" | "oldest" | "size";
};

export type Retention = { imageDays: number | null; videoDays: number | null };

export type AuditEntry = { id: number; action: string; details: Record<string, unknown>; createdAt: number; actor: string | null };

export type StorageRow = { id: number; name: string; files: number; bytes: number };

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`, data.code);
  return data as T;
}

export const adminApi = {
  sudo: (password: string) => call<{ until: number }>("POST", "/api/admin/sudo", { password }),
  overview: () => call<Overview>("GET", "/api/admin/overview"),
  media: (filter: MediaFilter, offset: number) => {
    const params = new URLSearchParams({ ...filter, offset: String(offset) });
    return call<{ items: MediaItem[]; totals: { files: number; bytes: number }; nextOffset: number | null }>(
      "GET",
      `/api/admin/media?${params}`,
    );
  },
  deleteMedia: (ids: string[]) => call<{ files: number; bytes: number }>("DELETE", "/api/admin/media", { ids }),
  /** Deletes everything matching the filter; refused if the count no longer equals `expected`. */
  deleteMatching: (filter: MediaFilter, expected: number) =>
    call<{ files: number; bytes: number }>("POST", "/api/admin/media/delete-matching", { filter, expected }),
  missingThumbs: () =>
    call<{ items: { id: string; filename: string; mime: string; url: string }[] }>("GET", "/api/admin/media/missing-thumbs"),
  uploadThumb: async (id: string, thumb: Blob) => {
    const form = new FormData();
    form.append("file", thumb, "thumb");
    const res = await fetch(`/api/admin/media/${id}/thumb`, { method: "PUT", body: form });
    if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({}))).error ?? "Upload failed");
  },
  storage: () => call<{ byUser: StorageRow[]; byChannel: StorageRow[] }>("GET", "/api/admin/storage"),
  retention: () => call<{ policy: Retention; preview: { files: number; bytes: number } }>("GET", "/api/admin/retention"),
  previewRetention: (policy: Retention) =>
    call<{ files: number; bytes: number }>("POST", "/api/admin/retention/preview", policy),
  saveRetention: (policy: Retention) => call<{ policy: Retention }>("PUT", "/api/admin/retention", policy),
  orphans: () => call<{ avatars: { files: number; bytes: number } }>("GET", "/api/admin/orphans"),
  deleteOrphans: () => call<{ files: number; bytes: number }>("DELETE", "/api/admin/orphans"),
  audit: (before?: number) => call<{ entries: AuditEntry[] }>("GET", `/api/admin/audit${before ? `?before=${before}` : ""}`),
};

// ---- formatting -------------------------------------------------------------------

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatAge(ts: number): string {
  const seconds = Math.max(0, (Date.now() - ts) / 1000);
  if (seconds < 60) return "just now";
  const units: [number, string][] = [
    [60, "minute"],
    [3600, "hour"],
    [86400, "day"],
    [86400 * 30, "month"],
    [86400 * 365, "year"],
  ];
  let [size, name] = units[0]!;
  for (const u of units) if (seconds >= u[0]) [size, name] = u;
  const n = Math.floor(seconds / size);
  return `${n} ${name}${n === 1 ? "" : "s"} ago`;
}

export function formatUptime(startedAt: number): string {
  const s = Math.floor((Date.now() - startedAt) / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
