import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.ts";
import { one, run, transaction } from "./db.ts";
import { broadcast } from "./hub.ts";
import { hashPassword, verifyPassword } from "./passwords.ts";
import { permissionsFor } from "./roles.ts";
import type { Role, User } from "./types.ts";
import { toUser, userColumns, type UserRow } from "./users.ts";

const SESSION_COOKIE = "session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const USERNAME_RE = /^[a-zA-Z0-9_.-]{2,32}$/;
const MIN_PASSWORD = 8;

// Used when the username doesn't exist, so login takes the same time either way.
const dummyHash = hashPassword(randomBytes(16).toString("hex"));

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

function createSession(userId: number): string {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  run(
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    hashToken(token),
    userId,
    now,
    now + SESSION_TTL_MS,
  );
  return token;
}

function setSessionCookie(reply: FastifyReply, token: string) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "strict",
    secure: config.secureCookies,
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function userFromRequest(req: FastifyRequest): User | null {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  const row = one<UserRow>(
    `SELECT ${userColumns("u.")} FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
    hashToken(token),
    Date.now(),
  );
  return row ? toUser(row) : null;
}

/** The hashed session token of this request (identifies the login session), if any. */
export function sessionHash(req: FastifyRequest): string | null {
  const token = req.cookies[SESSION_COOKIE];
  return token ? hashToken(token) : null;
}

/** Returns the logged-in user, or sends a 401 and returns null. */
export function requireUser(req: FastifyRequest, reply: FastifyReply): User | null {
  const user = userFromRequest(req);
  if (!user) reply.code(401).send({ error: "Not logged in" });
  return user;
}

type Credentials = { username: string; password: string };
type SignupBody = Credentials & { inviteCode: string };

const credentialProps = {
  username: { type: "string", maxLength: 64 },
  password: { type: "string", maxLength: 200 },
};

export function registerAuthRoutes(app: FastifyInstance) {
  run("DELETE FROM sessions WHERE expires_at <= ?", Date.now());

  app.post<{ Body: SignupBody }>(
    "/api/auth/signup",
    {
      config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
      schema: {
        body: {
          type: "object",
          required: ["inviteCode", "username", "password"],
          properties: { ...credentialProps, inviteCode: { type: "string", maxLength: 64 } },
        },
      },
    },
    async (req, reply) => {
      const inviteCode = req.body.inviteCode.trim();
      const username = req.body.username.trim();
      const { password } = req.body;
      if (!USERNAME_RE.test(username)) {
        return reply.code(400).send({ error: "Username must be 2–32 characters: letters, numbers, _ . -" });
      }
      if (password.length < MIN_PASSWORD) {
        return reply.code(400).send({ error: `Password must be at least ${MIN_PASSWORD} characters` });
      }

      const passwordHash = await hashPassword(password);
      const result = transaction((): { user: User } | { error: string } => {
        const invite = one<{ used_by: number | null }>("SELECT used_by FROM invites WHERE code = ?", inviteCode);
        if (!invite || invite.used_by !== null) return { error: "Invalid or already used invite code" };
        if (one("SELECT 1 FROM users WHERE username = ?", username)) return { error: "That username is taken" };
        const now = Date.now();
        // The first account on a fresh server becomes its owner.
        const role: Role = one("SELECT 1 FROM users LIMIT 1") ? "member" : "owner";
        const id = Number(
          run(
            "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
            username,
            passwordHash,
            role,
            now,
          ).lastInsertRowid,
        );
        run("UPDATE invites SET used_by = ?, used_at = ? WHERE code = ?", id, now, inviteCode);
        return { user: { id, username, role, displayName: null, avatarUrl: null } };
      });
      if ("error" in result) return reply.code(400).send(result);

      setSessionCookie(reply, createSession(result.user.id));
      broadcast({ type: "users-changed" });
      return { user: result.user, permissions: permissionsFor(result.user) };
    },
  );

  app.post<{ Body: Credentials }>(
    "/api/auth/login",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        body: { type: "object", required: ["username", "password"], properties: credentialProps },
      },
    },
    async (req, reply) => {
      const row = one<UserRow & { password_hash: string }>(
        `SELECT ${userColumns()}, password_hash FROM users WHERE username = ?`,
        req.body.username.trim(),
      );
      const ok = await verifyPassword(req.body.password, row?.password_hash ?? (await dummyHash));
      if (!row || !ok) return reply.code(401).send({ error: "Invalid username or password" });

      setSessionCookie(reply, createSession(row.id));
      const user = toUser(row);
      return { user, permissions: permissionsFor(user) };
    },
  );

  app.post("/api/auth/logout", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) run("DELETE FROM sessions WHERE token_hash = ?", hashToken(token));
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/me", async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return reply;
    return { user, permissions: permissionsFor(user) };
  });
}
