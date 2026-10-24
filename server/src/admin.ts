// Server management: invites (admins) and roles (owner).
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { all, one, run } from "./db.ts";
import { audit } from "./audit.ts";
import { broadcast } from "./hub.ts";
import { requirePermission } from "./roles.ts";
import type { Role } from "./types.ts";

export function createInvite(createdBy: number | null): string {
  const code = randomBytes(9).toString("base64url");
  run("INSERT INTO invites (code, created_at, created_by) VALUES (?, ?, ?)", code, Date.now(), createdBy);
  return code;
}

export function registerAdminRoutes(app: FastifyInstance) {
  app.get("/api/invites", async (req, reply) => {
    if (!requirePermission(req, reply, "manageInvites")) return reply;
    const invites = all<{ code: string; createdAt: number; createdBy: string | null; usedBy: string | null }>(
      `SELECT i.code, i.created_at AS createdAt, c.username AS createdBy, u.username AS usedBy
       FROM invites i LEFT JOIN users c ON c.id = i.created_by LEFT JOIN users u ON u.id = i.used_by
       ORDER BY i.created_at DESC LIMIT 100`,
    );
    return { invites };
  });

  app.post("/api/invites", { config: { rateLimit: { max: 20, timeWindow: "1 hour" } } }, async (req, reply) => {
    const user = requirePermission(req, reply, "manageInvites");
    if (!user) return reply;
    return { code: createInvite(user.id) };
  });

  app.delete<{ Params: { code: string } }>("/api/invites/:code", async (req, reply) => {
    if (!requirePermission(req, reply, "manageInvites")) return reply;
    const removed = run("DELETE FROM invites WHERE code = ? AND used_by IS NULL", req.params.code).changes;
    if (!removed) return reply.code(404).send({ error: "No unused invite with that code" });
    return { ok: true };
  });

  app.put<{ Params: { id: string }; Body: { role: Role } }>(
    "/api/users/:id/role",
    {
      schema: {
        // Ownership can only be transferred from the server (cli.ts set-role).
        body: { type: "object", required: ["role"], properties: { role: { enum: ["admin", "member"] } } },
      },
    },
    async (req, reply) => {
      const actor = requirePermission(req, reply, "manageRoles");
      if (!actor) return reply;
      const target = one<{ id: number; role: Role; username: string }>(
        "SELECT id, role, username FROM users WHERE id = ?",
        Number(req.params.id),
      );
      if (!target) return reply.code(404).send({ error: "User not found" });
      if (target.role === "owner") return reply.code(400).send({ error: "The owner's role can't be changed here" });

      run("UPDATE users SET role = ? WHERE id = ?", req.body.role, target.id);
      audit(actor.id, "role.change", { user: target.username, from: target.role, to: req.body.role });
      broadcast({ type: "users-changed" });
      return { ok: true };
    },
  );
}
