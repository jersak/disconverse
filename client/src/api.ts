// Types mirror server/src/types.ts.
export type Role = "owner" | "admin" | "member";

export type User = {
  id: number;
  /** Login name. */
  username: string;
  role: Role;
  /** Shown instead of the username when set. */
  displayName: string | null;
  avatarUrl: string | null;
};

export type Permission = "manageChannels" | "manageInvites" | "manageRoles" | "manageServer";

export type ChannelType = "text" | "voice";

export type Channel = {
  id: number;
  type: ChannelType;
  name: string;
  position: number;
  latestMessageId: number | null;
};

export type Invite = { code: string; createdAt: number; createdBy: string | null; usedBy: string | null };

export type Attachment = {
  id: string;
  filename: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  url: string;
  /** Small preview image, if the uploader's browser could make one. */
  thumbUrl: string | null;
  /** Deleted by an admin. */
  removed?: boolean;
};

export type Message = {
  id: number;
  channelId: number;
  userId: number;
  username: string;
  content: string;
  createdAt: number;
  attachments: Attachment[];
};

export type VoiceMember = {
  userId: number;
  username: string;
  muted: boolean;
  video: boolean;
  streaming: boolean;
};

/** Who is in each voice channel, by channel id. */
export type VoiceState = Record<number, VoiceMember[]>;

export type ServerEvent =
  | {
      type: "hello";
      user: User;
      permissions: Permission[];
      channels: Channel[];
      online: number[];
      voice: VoiceState;
    }
  | { type: "message"; message: Message }
  | { type: "presence"; online: number[] }
  | { type: "voice"; voice: VoiceState }
  | { type: "channels"; channels: Channel[] }
  | { type: "users-changed" }
  | { type: "attachments-removed"; ids: string[] };

type Session = { user: User; permissions: Permission[] };

export type GifResult = { id: string; title: string; preview: string; width: number; height: number; url: string };

/** Loads GIF media through the server so members' browsers only talk to this server. */
export const gifProxyUrl = (mediaUrl: string) => `/api/gifs/media?url=${encodeURIComponent(mediaUrl)}`;

export const PAGE_SIZE = 50;

export class ApiError extends Error {
  status: number;
  /** Machine-readable reason, e.g. "sudo_required". */
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? data.message ?? `Request failed (${res.status})`, data.code);
  return data as T;
}

/** Uploads one file with progress reporting (fetch can't report upload progress). */
export function uploadFile(
  file: File,
  size: { width?: number; height?: number },
  thumbnail: Blob | null,
  onProgress: (fraction: number) => void,
): { promise: Promise<Attachment>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<Attachment>((resolve, reject) => {
    xhr.open("POST", "/api/uploads");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data: { attachment?: Attachment; error?: string } = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // non-JSON error page
      }
      if (xhr.status < 300 && data.attachment) resolve(data.attachment);
      else reject(new Error(data.error ?? (xhr.status === 413 ? "File too large" : `Upload failed (${xhr.status})`)));
    };
    xhr.onerror = () => reject(new Error("Upload failed"));
    xhr.onabort = () => reject(new Error("Cancelled"));
  });
  // Fields before the file so the server sees them when the file stream starts.
  const form = new FormData();
  if (size.width) form.append("width", String(size.width));
  if (size.height) form.append("height", String(size.height));
  // The thumbnail goes before the file so the server reads it without buffering the file.
  if (thumbnail) form.append("thumb", thumbnail, "thumb");
  form.append("file", file, file.name || "pasted");
  xhr.send(form);
  return { promise, abort: () => xhr.abort() };
}

export const api = {
  me: () => request<Session>("GET", "/api/me"),
  login: (username: string, password: string) => request<Session>("POST", "/api/auth/login", { username, password }),
  signup: (inviteCode: string, username: string, password: string) =>
    request<Session>("POST", "/api/auth/signup", { inviteCode, username, password }),
  logout: () => request<{ ok: true }>("POST", "/api/auth/logout"),
  users: () => request<{ users: User[] }>("GET", "/api/users"),
  messages: (channelId: number, before?: number) =>
    request<{ messages: Message[] }>(
      "GET",
      `/api/channels/${channelId}/messages${before ? `?before=${before}` : ""}`,
    ),
  createChannel: (type: ChannelType, name: string) =>
    request<{ channel: Channel }>("POST", "/api/channels", { type, name }),
  renameChannel: (id: number, name: string) => request<{ ok: true }>("PATCH", `/api/channels/${id}`, { name }),
  deleteChannel: (id: number) => request<{ ok: true }>("DELETE", `/api/channels/${id}`),
  invites: () => request<{ invites: Invite[] }>("GET", "/api/invites"),
  createInvite: () => request<{ code: string }>("POST", "/api/invites"),
  revokeInvite: (code: string) => request<{ ok: true }>("DELETE", `/api/invites/${encodeURIComponent(code)}`),
  setRole: (userId: number, role: "admin" | "member") =>
    request<{ ok: true }>("PUT", `/api/users/${userId}/role`, { role }),
  gifConfig: () => request<{ search: "giphy" | "tenor" | null }>("GET", "/api/gifs"),
  gifSearch: (q: string, pos: string | null) =>
    request<{ results: GifResult[]; next: string | null }>(
      "GET",
      `/api/gifs/search?q=${encodeURIComponent(q)}${pos ? `&pos=${encodeURIComponent(pos)}` : ""}`,
    ),
  tenorGif: (id: string) =>
    request<{ mp4: string; gif: string | null; width: number | null; height: number | null }>("GET", `/api/gifs/tenor/${id}`),
  updateProfile: (displayName: string | null) => request<{ user: User }>("PATCH", "/api/me", { displayName }),
  uploadAvatar: async (image: Blob) => {
    const form = new FormData();
    form.append("file", image, `avatar.${image.type.split("/")[1] ?? "png"}`);
    const res = await fetch("/api/me/avatar", { method: "PUT", body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error ?? `Upload failed (${res.status})`);
    return data as { user: User };
  },
  removeAvatar: () => request<{ user: User }>("DELETE", "/api/me/avatar"),
  uploadLimits: () => request<{ limitsMb: { image: number; video: number } }>("GET", "/api/uploads/limits"),
  voiceToken: (channelId: number) => request<{ url: string; token: string }>("POST", "/api/voice/token", { channelId }),
};
