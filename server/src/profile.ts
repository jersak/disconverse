// A user's own profile: display name and profile picture.
import { randomBytes } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { requireUser } from "./auth.ts";
import { one, run } from "./db.ts";
import { broadcast } from "./hub.ts";
import { uploadsDir } from "./uploads.ts";
import { DISPLAY_NAME_MAX, normalizeDisplayName, toUser, userColumns, type UserRow } from "./users.ts";

export const avatarsDir = join(uploadsDir, "avatars");
await mkdir(avatarsDir, { recursive: true });

// Clients crop and shrink pictures to 256×256 before uploading, so real uploads are tiny.
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const AVATAR_FILE = /^\d+-[A-Za-z0-9_-]{8,32}\.(webp|png|jpg)$/;

function sniffImage(data: Buffer): "webp" | "png" | "jpg" | null {
  if (data.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "png";
  if (data.subarray(0, 3).toString("hex") === "ffd8ff") return "jpg";
  if (data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

const MIME = { webp: "image/webp", png: "image/png", jpg: "image/jpeg" } as const;

const currentUser = (id: number) => toUser(one<UserRow>(`SELECT ${userColumns()} FROM users WHERE id = ?`, id)!);

async function removeAvatarFile(file: string | null) {
  if (file && AVATAR_FILE.test(file)) await rm(join(avatarsDir, file), { force: true });
}

export function registerProfileRoutes(app: FastifyInstance) {
  app.patch<{ Body: { displayName: string | null } }>(
    "/api/me",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        body: {
          type: "object",
          required: ["displayName"],
          properties: { displayName: { type: ["string", "null"], maxLength: 200 } },
        },
      },
    },
    async (req, reply) => {
      const user = requireUser(req, reply);
      if (!user) return reply;
      const displayName = req.body.displayName === null ? null : normalizeDisplayName(req.body.displayName);
      if (displayName === undefined) {
        return reply.code(400).send({ error: `Display names can be up to ${DISPLAY_NAME_MAX} characters` });
      }
      run("UPDATE users SET display_name = ? WHERE id = ?", displayName, user.id);
      broadcast({ type: "users-changed" });
      return { user: currentUser(user.id) };
    },
  );

  app.put(
    "/api/me/avatar",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const user = requireUser(req, reply);
      if (!user) return reply;
      const part = await req.file({ limits: { fileSize: MAX_AVATAR_BYTES, files: 1, fields: 0 } });
      if (!part) return reply.code(400).send({ error: "No image" });
      const data = await part.toBuffer().catch(() => null);
      if (!data || part.file.truncated) return reply.code(413).send({ error: "That image is too large" });
      const ext = sniffImage(data);
      if (!ext) return reply.code(415).send({ error: "Profile pictures must be PNG, JPEG or WebP" });

      // A new name each time, so the file can be cached forever and old copies never show up.
      const file = `${user.id}-${randomBytes(12).toString("base64url")}.${ext}`;
      await writeFile(join(avatarsDir, file), data);
      const previous = one<{ avatar: string | null }>("SELECT avatar FROM users WHERE id = ?", user.id)?.avatar ?? null;
      run("UPDATE users SET avatar = ? WHERE id = ?", file, user.id);
      await removeAvatarFile(previous);
      broadcast({ type: "users-changed" });
      return { user: currentUser(user.id) };
    },
  );

  app.delete("/api/me/avatar", async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return reply;
    const previous = one<{ avatar: string | null }>("SELECT avatar FROM users WHERE id = ?", user.id)?.avatar ?? null;
    run("UPDATE users SET avatar = NULL WHERE id = ?", user.id);
    await removeAvatarFile(previous);
    broadcast({ type: "users-changed" });
    return { user: currentUser(user.id) };
  });

  app.get<{ Params: { file: string } }>("/api/avatars/:file", async (req, reply) => {
    if (!requireUser(req, reply)) return reply;
    const { file } = req.params;
    const exists = AVATAR_FILE.test(file) && (await stat(join(avatarsDir, file)).catch(() => null))?.isFile();
    if (!exists) return reply.code(404).send({ error: "Not found" });
    const ext = file.split(".").pop() as keyof typeof MIME;
    reply
      .header("Content-Type", MIME[ext])
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "default-src 'none'; sandbox")
      .header("Cache-Control", "private, max-age=31536000, immutable");
    return reply.sendFile(file, avatarsDir, { contentType: false, cacheControl: false });
  });
}
