// How users are read from the database and shown to clients.
import type { Role, User } from "./types.ts";

/** Columns to select (optionally table-prefixed) for `toUser`. */
export const userColumns = (prefix = "") =>
  ["id", "username", "role", "display_name", "avatar"].map((c) => `${prefix}${c}`).join(", ");

export type UserRow = {
  id: number;
  username: string;
  role: Role;
  display_name: string | null;
  avatar: string | null;
};

export const avatarUrl = (file: string | null) => (file ? `/api/avatars/${file}` : null);

export const toUser = (row: UserRow): User => ({
  id: row.id,
  username: row.username,
  role: row.role,
  displayName: row.display_name,
  avatarUrl: avatarUrl(row.avatar),
});

export const DISPLAY_NAME_MAX = 32;

/**
 * Trims and tidies a display name. Returns null to clear it (fall back to the username),
 * or undefined if it's not acceptable.
 */
export function normalizeDisplayName(raw: string): string | null | undefined {
  // Control characters and invisible formatting characters would allow blank or misleading names.
  const name = raw
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!name) return null;
  return [...name].length <= DISPLAY_NAME_MAX ? name : undefined;
}
