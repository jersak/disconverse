import type { FastifyReply, FastifyRequest } from "fastify";
import { requireUser } from "./auth.ts";
import type { Role, User } from "./types.ts";

export const ROLES: readonly Role[] = ["owner", "admin", "member"];

/**
 * What each role may do. Code checks permissions, never role names, so roles could become
 * configurable later without touching the checks.
 */
const PERMISSIONS = {
  manageChannels: ["owner", "admin"],
  manageInvites: ["owner", "admin"],
  manageRoles: ["owner"],
  /** The admin panel: storage, media, logs, users, maintenance. */
  manageServer: ["owner"],
} satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export const can = (user: Pick<User, "role">, permission: Permission) =>
  (PERMISSIONS[permission] as readonly Role[]).includes(user.role);

export const permissionsFor = (user: Pick<User, "role">) =>
  (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(user, p));

/** Returns the logged-in user if they have the permission; otherwise sends 401/403 and returns null. */
export function requirePermission(req: FastifyRequest, reply: FastifyReply, permission: Permission): User | null {
  const user = requireUser(req, reply);
  if (!user) return null;
  if (!can(user, permission)) {
    reply.code(403).send({ error: "You don't have permission to do that" });
    return null;
  }
  return user;
}
