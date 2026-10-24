// The owner's admin panel API: overview, media and storage, retention, audit log.
// Destructive actions need the owner's password re-entered recently ("sudo"), per login session.
import { readdir, rm, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { audit } from "./audit.ts";
import { sessionHash } from "./auth.ts";
import { all, dataDir, one, run } from "./db.ts";
import { onlineUserIds } from "./hub.ts";
import { verifyPassword } from "./passwords.ts";
import { avatarsDir } from "./profile.ts";
import { requirePermission } from "./roles.ts";
import { getSetting, setSetting } from "./settings.ts";
import type { User } from "./types.ts";
import { removeMedia, storeThumbnail, uploadsDir } from "./uploads.ts";
import { getVoiceState } from "./voice.ts";

const SUDO_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const startedAt = Date.now();

const requireOwner = (req: FastifyRequest, reply: FastifyReply) => requirePermission(req, reply, "manageServer");

/** The owner, if they confirmed their password in this session within the last 10 minutes. */
function requireSudo(req: FastifyRequest, reply: FastifyReply): User | null {
  const user = requireOwner(req, reply);
  if (!user) return null;
  const until = one<{ sudo_until: number | null }>("SELECT sudo_until FROM sessions WHERE token_hash = ?", sessionHash(req))
    ?.sudo_until;
  if (!until || until < Date.now()) {
    reply.code(403).send({ error: "Confirm your password to continue", code: "sudo_required" });
    return null;
  }
  return user;
}

// ---- Overview ------------------------------------------------------------------

async function drive(path: string) {
  const s = await statfs(path);
  const total = s.blocks * s.bsize;
  const free = s.bavail * s.bsize;
  return { total, free, used: total - free };
}

async function fileSize(path: string) {
  return (await stat(path).catch(() => null))?.size ?? 0;
}

async function dirSize(path: string) {
  let total = 0;
  for (const name of await readdir(path).catch(() => [] as string[])) total += await fileSize(join(path, name));
  return total;
}

async function overview() {
  const dbPath = join(dataDir, "disconverse.db");
  const [dataDrive, uploadsDrive, dataDev, uploadsDev] = await Promise.all([
    drive(dataDir),
    drive(uploadsDir),
    stat(dataDir).then((s) => s.dev),
    stat(uploadsDir).then((s) => s.dev),
  ]);
  const database = (await fileSize(dbPath)) + (await fileSize(`${dbPath}-wal`)) + (await fileSize(`${dbPath}-shm`));
  const media = all<{ kind: string; files: number; bytes: number }>(
    `SELECT CASE WHEN message_id IS NULL THEN 'unsent' WHEN mime LIKE 'image/%' THEN 'images' ELSE 'videos' END AS kind,
            COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes
     FROM attachments WHERE removed_at IS NULL GROUP BY kind`,
  );
  const byKind = (kind: string) => media.find((m) => m.kind === kind) ?? { files: 0, bytes: 0 };
  const count = (sql: string) => one<{ n: number }>(sql)!.n;
  const voice = getVoiceState();
  const avatars = await dirSize(avatarsDir);
  // What Disconverse itself stores on each drive.
  const uploadsBytes = media.reduce((n, m) => n + m.bytes, 0) + avatars;

  return {
    drives:
      dataDev === uploadsDev
        ? [{ label: "Database & uploads", path: dataDir, ...dataDrive, app: database + uploadsBytes }]
        : [
            { label: "Database", path: dataDir, ...dataDrive, app: database },
            { label: "Uploads", path: uploadsDir, ...uploadsDrive, app: uploadsBytes },
          ],
    storage: {
      images: byKind("images"),
      videos: byKind("videos"),
      unsent: byKind("unsent"),
      avatars: { bytes: avatars },
      database: { bytes: database },
    },
    counts: {
      users: count("SELECT COUNT(*) AS n FROM users"),
      messages: count("SELECT COUNT(*) AS n FROM messages"),
      textChannels: count("SELECT COUNT(*) AS n FROM channels WHERE type = 'text'"),
      voiceChannels: count("SELECT COUNT(*) AS n FROM channels WHERE type = 'voice'"),
      unusedInvites: count("SELECT COUNT(*) AS n FROM invites WHERE used_by IS NULL"),
    },
    live: {
      online: onlineUserIds().length,
      inVoice: Object.values(voice).reduce((n, members) => n + members.length, 0),
    },
    server: {
      version: process.env.APP_VERSION || "dev",
      node: process.version,
      startedAt,
    },
  };
}

// ---- Media -----------------------------------------------------------------------

type MediaQuery = {
  type?: string;
  userId?: string;
  channelId?: string;
  olderThanDays?: string;
  status?: string;
  sort?: string;
  offset?: string;
};

function mediaFilter(q: MediaQuery) {
  const where = ["a.removed_at IS NULL"];
  const params: (string | number)[] = [];
  if (q.type === "image" || q.type === "video") {
    where.push("a.mime LIKE ?");
    params.push(`${q.type}/%`);
  }
  if (Number(q.userId)) {
    where.push("a.user_id = ?");
    params.push(Number(q.userId));
  }
  if (Number(q.channelId)) {
    where.push("m.channel_id = ?");
    params.push(Number(q.channelId));
  }
  if (Number(q.olderThanDays) > 0) {
    where.push("a.created_at < ?");
    params.push(Date.now() - Number(q.olderThanDays) * DAY_MS);
  }
  if (q.status === "sent") where.push("a.message_id IS NOT NULL");
  if (q.status === "unsent") where.push("a.message_id IS NULL");
  return { where: where.join(" AND "), params };
}

const MEDIA_FROM = `FROM attachments a JOIN users u ON u.id = a.user_id
  LEFT JOIN messages m ON m.id = a.message_id LEFT JOIN channels c ON c.id = m.channel_id`;

const MEDIA_ORDER: Record<string, string> = {
  size: "a.size DESC",
  newest: "a.created_at DESC",
  oldest: "a.created_at ASC",
};

// ---- Retention -------------------------------------------------------------------

type Retention = { imageDays: number | null; videoDays: number | null };
const RETENTION_KEY = "retention";

/** Media older than the retention policy allows. */
function expiredMedia(policy: Retention) {
  const now = Date.now();
  const rules: string[] = [];
  const params: number[] = [];
  if (policy.imageDays) {
    rules.push("(mime LIKE 'image/%' AND created_at < ?)");
    params.push(now - policy.imageDays * DAY_MS);
  }
  if (policy.videoDays) {
    rules.push("(mime LIKE 'video/%' AND created_at < ?)");
    params.push(now - policy.videoDays * DAY_MS);
  }
  if (!rules.length) return [];
  return all<{ id: string; size: number }>(
    `SELECT id, size FROM attachments WHERE removed_at IS NULL AND (${rules.join(" OR ")})`,
    ...params,
  );
}

async function runRetention(app: FastifyInstance) {
  const expired = expiredMedia(getSetting<Retention>(RETENTION_KEY, { imageDays: null, videoDays: null }));
  if (!expired.length) return;
  const result = await removeMedia(expired.map((e) => e.id));
  audit(null, "retention.run", result);
  app.log.info(`retention removed ${result.files} file(s), ${result.bytes} bytes`);
}

const validDays = (d: unknown) => d === null || (Number.isInteger(d) && (d as number) >= 1 && (d as number) <= 3650);

// ---- Orphaned profile pictures ---------------------------------------------------

async function orphanAvatars() {
  const used = new Set(all<{ avatar: string }>("SELECT avatar FROM users WHERE avatar IS NOT NULL").map((r) => r.avatar));
  const files = (await readdir(avatarsDir).catch(() => [] as string[])).filter((f) => !used.has(f));
  let bytes = 0;
  for (const f of files) bytes += await fileSize(join(avatarsDir, f));
  return { files, bytes };
}

// ---- Routes ----------------------------------------------------------------------

export function registerServerAdminRoutes(app: FastifyInstance) {
  // Password re-confirmation for destructive actions (10 minutes, this login session only).
  app.post<{ Body: { password: string } }>(
    "/api/admin/sudo",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: {
        body: { type: "object", required: ["password"], properties: { password: { type: "string", maxLength: 200 } } },
      },
    },
    async (req, reply) => {
      const user = requireOwner(req, reply);
      if (!user) return reply;
      const { password_hash } = one<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = ?", user.id)!;
      if (!(await verifyPassword(req.body.password, password_hash))) {
        return reply.code(401).send({ error: "Wrong password" });
      }
      const until = Date.now() + SUDO_MS;
      run("UPDATE sessions SET sudo_until = ? WHERE token_hash = ?", until, sessionHash(req));
      return { until };
    },
  );

  app.get("/api/admin/overview", async (req, reply) => {
    if (!requireOwner(req, reply)) return reply;
    return overview();
  });

  app.get<{ Querystring: { before?: string } }>("/api/admin/audit", async (req, reply) => {
    if (!requireOwner(req, reply)) return reply;
    const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
    const rows = all<{ id: number; action: string; details: string; createdAt: number; actor: string | null }>(
      `SELECT a.id, a.action, a.details, a.created_at AS createdAt, COALESCE(u.display_name, u.username) AS actor
       FROM admin_audit a LEFT JOIN users u ON u.id = a.user_id WHERE a.id < ? ORDER BY a.id DESC LIMIT 100`,
      before,
    );
    return { entries: rows.map((r) => ({ ...r, details: JSON.parse(r.details || "{}") })) };
  });

  app.get<{ Querystring: MediaQuery }>("/api/admin/media", async (req, reply) => {
    if (!requireOwner(req, reply)) return reply;
    const { where, params } = mediaFilter(req.query);
    const order = MEDIA_ORDER[req.query.sort ?? ""] ?? MEDIA_ORDER.newest;
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const items = all<Record<string, unknown>>(
      `SELECT a.id, a.filename, a.mime, a.size, a.width, a.height, a.created_at AS createdAt, a.thumb_mime AS thumbMime,
              a.message_id AS messageId, a.user_id AS userId, COALESCE(u.display_name, u.username) AS uploader,
              m.channel_id AS channelId, c.name AS channelName
       ${MEDIA_FROM} WHERE ${where} ORDER BY ${order} LIMIT 60 OFFSET ?`,
      ...params,
      offset,
    ).map(({ thumbMime, ...r }) => ({
      ...r,
      url: `/api/files/${r.id}/${encodeURIComponent(String(r.filename))}`,
      thumbUrl: thumbMime ? `/api/thumbs/${r.id}` : null,
    }));
    const totals = one<{ files: number; bytes: number }>(
      `SELECT COUNT(*) AS files, COALESCE(SUM(a.size), 0) AS bytes ${MEDIA_FROM} WHERE ${where}`,
      ...params,
    )!;
    return { items, totals, nextOffset: offset + items.length < totals.files ? offset + items.length : null };
  });

  app.delete<{ Body: { ids: string[] } }>(
    "/api/admin/media",
    {
      schema: {
        body: {
          type: "object",
          required: ["ids"],
          properties: { ids: { type: "array", maxItems: 1000, items: { type: "string", maxLength: 64 } } },
        },
      },
    },
    async (req, reply) => {
      const user = requireSudo(req, reply);
      if (!user) return reply;
      const result = await removeMedia(req.body.ids);
      audit(user.id, "media.delete", result);
      return result;
    },
  );

  // Delete everything matching a filter (no need to load and select thousands of files).
  // `expected` is the count the owner saw; if it changed meanwhile, nothing is deleted.
  app.post<{ Body: { filter: MediaQuery; expected: number } }>(
    "/api/admin/media/delete-matching",
    {
      schema: {
        body: {
          type: "object",
          required: ["filter", "expected"],
          properties: { filter: { type: "object" }, expected: { type: "integer", minimum: 1 } },
        },
      },
    },
    async (req, reply) => {
      const user = requireSudo(req, reply);
      if (!user) return reply;
      const filter = req.body.filter as MediaQuery;
      const { where, params } = mediaFilter(filter);
      const ids = all<{ id: string }>(`SELECT a.id ${MEDIA_FROM} WHERE ${where}`, ...params).map((r) => r.id);
      if (ids.length !== req.body.expected) {
        return reply
          .code(409)
          .send({ error: `The matching files changed (now ${ids.length}). Review the list and try again.` });
      }
      const result = await removeMedia(ids);
      const { sort: _sort, offset: _offset, ...appliedFilter } = filter;
      audit(user.id, "media.delete", { ...result, filter: appliedFilter });
      return result;
    },
  );

  // Thumbnails missing from older uploads; the owner's browser generates and uploads them.
  app.get("/api/admin/media/missing-thumbs", async (req, reply) => {
    if (!requireOwner(req, reply)) return reply;
    const items = all<{ id: string; filename: string; mime: string }>(
      "SELECT id, filename, mime FROM attachments WHERE removed_at IS NULL AND thumb_mime IS NULL ORDER BY created_at DESC LIMIT 5000",
    ).map((r) => ({ ...r, url: `/api/files/${r.id}/${encodeURIComponent(r.filename)}` }));
    return { items };
  });

  app.put<{ Params: { id: string } }>("/api/admin/media/:id/thumb", async (req, reply) => {
    if (!requireOwner(req, reply)) return reply;
    const exists = one("SELECT 1 FROM attachments WHERE id = ? AND removed_at IS NULL", req.params.id);
    if (!exists) return reply.code(404).send({ error: "Not found" });
    const part = await req.file({ limits: { fileSize: 200 * 1024, files: 1, fields: 0 } });
    const data = part && (await part.toBuffer().catch(() => null));
    if (!data || part.file.truncated || !(await storeThumbnail(req.params.id, data))) {
      return reply.code(400).send({ error: "Not a valid thumbnail" });
    }
    return { thumbUrl: `/api/thumbs/${req.params.id}` };
  });

  app.get("/api/admin/storage", async (req, reply) => {
    if (!requireOwner(req, reply)) return reply;
    const byUser = all(
      `SELECT u.id, COALESCE(u.display_name, u.username) AS name, COUNT(a.id) AS files, COALESCE(SUM(a.size), 0) AS bytes
       FROM users u LEFT JOIN attachments a ON a.user_id = u.id AND a.removed_at IS NULL
       GROUP BY u.id ORDER BY bytes DESC`,
    );
    const byChannel = all(
      `SELECT c.id, c.name, COUNT(a.id) AS files, COALESCE(SUM(a.size), 0) AS bytes
       FROM channels c LEFT JOIN messages m ON m.channel_id = c.id
       LEFT JOIN attachments a ON a.message_id = m.id AND a.removed_at IS NULL
       WHERE c.type = 'text' GROUP BY c.id ORDER BY bytes DESC`,
    );
    return { byUser, byChannel };
  });

  app.get("/api/admin/retention", async (req, reply) => {
    if (!requireOwner(req, reply)) return reply;
    const policy = getSetting<Retention>(RETENTION_KEY, { imageDays: null, videoDays: null });
    const expired = expiredMedia(policy);
    return { policy, preview: { files: expired.length, bytes: expired.reduce((n, e) => n + e.size, 0) } };
  });

  // Preview a policy before saving it.
  app.post<{ Body: Retention }>("/api/admin/retention/preview", async (req, reply) => {
    if (!requireOwner(req, reply)) return reply;
    if (!validDays(req.body.imageDays) || !validDays(req.body.videoDays)) return reply.code(400).send({ error: "Invalid days" });
    const expired = expiredMedia(req.body);
    return { files: expired.length, bytes: expired.reduce((n, e) => n + e.size, 0) };
  });

  app.put<{ Body: Retention }>(
    "/api/admin/retention",
    {
      schema: {
        body: {
          type: "object",
          required: ["imageDays", "videoDays"],
          properties: { imageDays: { type: ["integer", "null"] }, videoDays: { type: ["integer", "null"] } },
        },
      },
    },
    async (req, reply) => {
      const user = requireSudo(req, reply);
      if (!user) return reply;
      if (!validDays(req.body.imageDays) || !validDays(req.body.videoDays)) return reply.code(400).send({ error: "Days must be 1–3650" });
      const policy = { imageDays: req.body.imageDays, videoDays: req.body.videoDays };
      setSetting(RETENTION_KEY, policy);
      audit(user.id, "retention.update", policy);
      void runRetention(app); // apply right away rather than at the next hourly run
      return { policy };
    },
  );

  app.get("/api/admin/orphans", async (req, reply) => {
    if (!requireOwner(req, reply)) return reply;
    const { files, bytes } = await orphanAvatars();
    return { avatars: { files: files.length, bytes } };
  });

  app.delete("/api/admin/orphans", async (req, reply) => {
    const user = requireSudo(req, reply);
    if (!user) return reply;
    const { files, bytes } = await orphanAvatars();
    for (const f of files) await rm(join(avatarsDir, f), { force: true });
    audit(user.id, "orphans.delete", { files: files.length, bytes });
    return { files: files.length, bytes };
  });

  setInterval(() => void runRetention(app).catch((err) => app.log.error({ err }, "retention failed")), 60 * 60 * 1000).unref();
  setTimeout(() => void runRetention(app).catch((err) => app.log.error({ err }, "retention failed")), 30_000).unref();
}
