import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, open, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { requireUser } from "./auth.ts";
import { all, one, run, transaction } from "./db.ts";
import { broadcast } from "./hub.ts";
import type { Attachment } from "./types.ts";

/** Per-file size limits in MB, by kind. */
export const UPLOAD_LIMITS_MB = {
  image: Number(process.env.MAX_IMAGE_MB ?? 30),
  video: Number(process.env.MAX_VIDEO_MB ?? 300),
};
const MB = 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
const UNSENT_TTL_MS = 24 * 60 * 60 * 1000;

/** Where uploaded files live; can be a separate (bigger) drive from the database's DATA_DIR. */
export const uploadsDir = process.env.UPLOADS_DIR ?? join(process.env.DATA_DIR ?? "./data", "uploads");
export const thumbsDir = join(uploadsDir, "thumbs");

// With a dedicated drive, require a marker file so an unmounted drive is caught at startup
// instead of uploads silently landing on the empty mount point.
const STORAGE_MARKER = ".disconverse-storage";
if (process.env.REQUIRE_UPLOADS_MARKER === "true" && !existsSync(join(uploadsDir, STORAGE_MARKER))) {
  throw new Error(
    `Upload storage not available: ${join(uploadsDir, STORAGE_MARKER)} is missing. ` +
      "Is the drive mounted? (When setting up new storage, create this empty file once.)",
  );
}
await mkdir(thumbsDir, { recursive: true });

/** Thumbnails are made in the uploader's browser: small WebP/PNG/JPEG images only. */
const THUMB_MAX_BYTES = 200 * 1024;
const THUMB_TYPES = new Set(["image/webp", "image/png", "image/jpeg"]);

/** Validates and stores a thumbnail for an attachment. Returns its type, or null if it isn't acceptable. */
export async function storeThumbnail(id: string, data: Buffer): Promise<string | null> {
  if (data.length > THUMB_MAX_BYTES) return null;
  const mime = sniff(data.subarray(0, 32));
  if (!mime || !THUMB_TYPES.has(mime)) return null;
  await writeFile(join(thumbsDir, id), data);
  run("UPDATE attachments SET thumb_mime = ? WHERE id = ?", mime, id);
  return mime;
}

/** Reads a multipart file part into memory, giving up (and draining it) past `limit` bytes. */
async function readSmall(stream: AsyncIterable<Buffer> & { resume?: () => void }, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > limit) {
      chunks.length = 0; // keep draining so the rest of the request can be read, but drop the data
      continue;
    }
    chunks.push(chunk);
  }
  return total > limit ? null : Buffer.concat(chunks);
}

/** Deletes a stored upload and its thumbnail. */
async function removeStored(id: string) {
  await rm(join(uploadsDir, id), { force: true });
  await rm(join(thumbsDir, id), { force: true });
}

/**
 * Identifies the file type from its first bytes. The client's claimed type and filename are ignored,
 * so only real images/videos are stored and they're always served with the matching type.
 */
function sniff(head: Buffer): string | null {
  const hex = (offset: number, sig: string) => head.subarray(offset, offset + sig.length / 2).toString("hex") === sig;
  const text = (offset: number, sig: string) => head.subarray(offset, offset + sig.length).toString("latin1") === sig;

  if (hex(0, "89504e470d0a1a0a")) return "image/png";
  if (hex(0, "ffd8ff")) return "image/jpeg";
  if (text(0, "GIF87a") || text(0, "GIF89a")) return "image/gif";
  if (text(0, "RIFF") && text(8, "WEBP")) return "image/webp";
  if (hex(0, "1a45dfa3")) return "video/webm";
  if (text(4, "ftyp")) {
    const brand = head.subarray(8, 12).toString("latin1");
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (brand.startsWith("hei") || brand === "mif1" || brand === "msf1") return null; // HEIC: browsers can't show it
    if (brand === "qt  ") return "video/quicktime";
    return "video/mp4";
  }
  return null;
}

type AttachmentRow = {
  id: string;
  filename: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  message_id: number | null;
  removed_at?: number | null;
  thumb_mime?: string | null;
};

const toAttachment = (r: AttachmentRow): Attachment => ({
  id: r.id,
  filename: r.filename,
  mime: r.mime,
  size: r.size,
  width: r.width,
  height: r.height,
  url: r.removed_at ? "" : `/api/files/${r.id}/${encodeURIComponent(r.filename)}`,
  thumbUrl: r.thumb_mime && !r.removed_at ? `/api/thumbs/${r.id}` : null,
  ...(r.removed_at ? { removed: true } : {}),
});

/**
 * Deletes stored media files. Sent attachments stay in their messages as "removed" placeholders;
 * unsent uploads are dropped entirely. Returns what was freed.
 */
export async function removeMedia(ids: string[]): Promise<{ files: number; bytes: number }> {
  if (!ids.length) return { files: 0, bytes: 0 };
  const rows = all<{ id: string; size: number; message_id: number | null }>(
    `SELECT id, size, message_id FROM attachments WHERE removed_at IS NULL AND id IN (${ids.map(() => "?").join(",")})`,
    ...ids,
  );
  const now = Date.now();
  for (const r of rows) await removeStored(r.id);
  transaction(() => {
    for (const r of rows) {
      if (r.message_id === null) run("DELETE FROM attachments WHERE id = ?", r.id);
      else run("UPDATE attachments SET removed_at = ?, thumb_mime = NULL WHERE id = ?", now, r.id);
    }
  });
  const removed = rows.filter((r) => r.message_id !== null).map((r) => r.id);
  // Chunked, so deleting thousands of files doesn't push one huge message to every client.
  for (let i = 0; i < removed.length; i += 500) broadcast({ type: "attachments-removed", ids: removed.slice(i, i + 500) });
  return { files: rows.length, bytes: rows.reduce((sum, r) => sum + r.size, 0) };
}

/** Attachments for the given messages, keyed by message id. */
export function attachmentsFor(messageIds: number[]): Map<number, Attachment[]> {
  const byMessage = new Map<number, Attachment[]>();
  if (!messageIds.length) return byMessage;
  const rows = all<AttachmentRow>(
    `SELECT * FROM attachments WHERE message_id IN (${messageIds.map(() => "?").join(",")}) ORDER BY created_at`,
    ...messageIds,
  );
  for (const r of rows) {
    const list = byMessage.get(r.message_id!) ?? [];
    list.push(toAttachment(r));
    byMessage.set(r.message_id!, list);
  }
  return byMessage;
}

/** Of the given upload ids, those that belong to the user and aren't attached to a message yet. */
export function claimableUploads(userId: number, ids: string[]): string[] {
  if (!ids.length) return [];
  return all<{ id: string }>(
    `SELECT id FROM attachments WHERE user_id = ? AND message_id IS NULL AND id IN (${ids.map(() => "?").join(",")})`,
    userId,
    ...ids,
  ).map((r) => r.id);
}

/** Deletes stored files (their database rows are removed by the caller). */
export async function removeUploadFiles(ids: string[]) {
  for (const id of ids) await removeStored(id);
}

export function attachToMessage(messageId: number, ids: string[]) {
  for (const id of ids) run("UPDATE attachments SET message_id = ? WHERE id = ?", messageId, id);
}

const tooLarge = (kind: "image" | "video") =>
  `${kind === "image" ? "Images" : "Videos"} can be up to ${UPLOAD_LIMITS_MB[kind]} MB`;

function cleanFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f"]/g, "").trim().slice(0, 200);
  return cleaned || "file";
}

/** Deletes uploads that were never sent with a message. */
async function removeUnsentUploads(app: FastifyInstance) {
  const stale = all<{ id: string }>(
    "SELECT id FROM attachments WHERE message_id IS NULL AND created_at < ?",
    Date.now() - UNSENT_TTL_MS,
  );
  for (const { id } of stale) {
    await removeStored(id);
    run("DELETE FROM attachments WHERE id = ?", id);
  }
  if (stale.length) app.log.info(`removed ${stale.length} unsent upload(s)`);
}

export function registerUploadRoutes(app: FastifyInstance) {
  app.post(
    "/api/uploads",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const user = requireUser(req, reply);
      if (!user) return reply;

      // The kind is only known once the file's first bytes are in, so stream up to the larger limit
      // and apply the kind-specific one after sniffing.
      const streamLimit = Math.max(UPLOAD_LIMITS_MB.image, UPLOAD_LIMITS_MB.video) * MB;
      const id = randomBytes(16).toString("base64url");
      const path = join(uploadsDir, id);
      // Fields first, then an optional small "thumb" (made by the browser), then the "file" itself.
      const fields: Record<string, string> = {};
      let thumb: Buffer | null = null;
      let file: { filename: string; mimetype: string; truncated: boolean } | null = null;
      for await (const part of req.parts({ limits: { fileSize: streamLimit, files: 2, fields: 4 } })) {
        if (part.type === "field") {
          fields[part.fieldname] = String(part.value);
        } else if (part.fieldname === "thumb" && !thumb) {
          thumb = await readSmall(part.file, THUMB_MAX_BYTES);
        } else if (part.fieldname === "file" && !file) {
          await pipeline(part.file, createWriteStream(path));
          file = { filename: part.filename, mimetype: part.mimetype, truncated: part.file.truncated };
        } else {
          part.file.resume(); // unexpected part: discard
        }
      }
      if (!file) return reply.code(400).send({ error: "No file" });
      if (file.truncated) {
        await rm(path, { force: true });
        return reply.code(413).send({ error: tooLarge(file.mimetype.startsWith("image/") ? "image" : "video") });
      }

      const head = Buffer.alloc(32);
      const handle = await open(path);
      await handle.read(head, 0, head.length, 0);
      await handle.close();
      const mime = sniff(head);
      if (!mime) {
        await rm(path, { force: true });
        return reply
          .code(415)
          .send({ error: "Only images (PNG, JPEG, GIF, WebP, AVIF) and videos (MP4, WebM, MOV) are supported" });
      }

      const kind = mime.startsWith("image/") ? "image" : "video";
      const size = (await stat(path)).size;
      if (size > UPLOAD_LIMITS_MB[kind] * MB) {
        await rm(path, { force: true });
        return reply.code(413).send({ error: tooLarge(kind) });
      }

      // Dimensions are measured by the client so chat can reserve space before media loads.
      const dimension = (name: string) => {
        const value = Number(fields[name]);
        return Number.isFinite(value) && value > 0 && value < 100_000 ? Math.round(value) : null;
      };

      const row: AttachmentRow = {
        id,
        filename: cleanFilename(file.filename),
        mime,
        size,
        width: dimension("width"),
        height: dimension("height"),
        message_id: null,
      };
      run(
        `INSERT INTO attachments (id, user_id, filename, mime, size, width, height, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        row.id,
        user.id,
        row.filename,
        row.mime,
        row.size,
        row.width,
        row.height,
        Date.now(),
      );
      // A bad thumbnail never fails the upload; the file just has no preview.
      if (thumb) row.thumb_mime = await storeThumbnail(id, thumb);
      return { attachment: toAttachment(row) };
    },
  );

  // Lets the client reject oversized files before uploading them.
  app.get("/api/uploads/limits", async (req, reply) => {
    if (!requireUser(req, reply)) return reply;
    return { limitsMb: UPLOAD_LIMITS_MB };
  });

  app.get<{ Params: { id: string } }>("/api/thumbs/:id", async (req, reply) => {
    if (!requireUser(req, reply)) return reply;
    const row = one<{ thumb_mime: string | null }>(
      "SELECT thumb_mime FROM attachments WHERE id = ? AND removed_at IS NULL",
      req.params.id,
    );
    if (!row?.thumb_mime) return reply.code(404).send({ error: "Not found" });
    reply
      .header("Content-Type", row.thumb_mime)
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "default-src 'none'; sandbox")
      .header("Cache-Control", "private, max-age=31536000, immutable");
    return reply.sendFile(req.params.id, thumbsDir, { contentType: false, cacheControl: false });
  });

  app.get<{ Params: { id: string; name: string } }>("/api/files/:id/:name", async (req, reply) => {
    if (!requireUser(req, reply)) return reply;
    const row = one<{ mime: string; filename: string }>(
      "SELECT mime, filename FROM attachments WHERE id = ? AND removed_at IS NULL",
      req.params.id,
    );
    if (!row) return reply.code(404).send({ error: "Not found" });

    reply
      .header("Content-Type", row.mime)
      .header("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(row.filename)}`)
      .header("X-Content-Type-Options", "nosniff")
      // Even if a file were crafted to look like a page, it can't run anything.
      .header("Content-Security-Policy", "default-src 'none'; sandbox")
      .header("Cache-Control", "private, max-age=31536000, immutable");
    return reply.sendFile(req.params.id, uploadsDir, { contentType: false, cacheControl: false });
  });

  void removeUnsentUploads(app);
  setInterval(() => void removeUnsentUploads(app), 60 * 60 * 1000).unref();
}
