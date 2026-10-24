// User mentions. In the message box they're written "@username"; when sent they're stored as
// "<@id>" (like Discord), so they always show the person's current display name.
import type { User } from "./api.ts";
import { displayName } from "./users.tsx";

/** A stored mention inside message content. */
export const MENTION_TOKEN = /<@(\d+)>/g;

export const mentions = (content: string, userId: number) => content.includes(`<@${userId}>`);

/** The "@query" being typed right before the caret, if any. */
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|\s)@([\p{L}\p{N}_.-]{0,32})$/u.exec(text.slice(0, caret));
  return m ? { start: caret - m[2]!.length - 1, query: m[2]! } : null;
}

/** People matching a partial name, best first (name starts with it, then contains it). */
export function suggestUsers(users: User[], query: string, limit = 8): User[] {
  const q = query.toLowerCase();
  const rank = (u: User) => {
    const names = [u.username.toLowerCase(), displayName(u).toLowerCase()];
    if (names.some((n) => n.startsWith(q))) return 0;
    if (names.some((n) => n.split(/\s+/).some((word) => word.startsWith(q)))) return 1;
    if (names.some((n) => n.includes(q))) return 2;
    return -1;
  };
  return users
    .map((u) => ({ u, r: rank(u) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || displayName(a.u).localeCompare(displayName(b.u)))
    .slice(0, limit)
    .map((x) => x.u);
}

/** Turns "@username" into "<@id>" for known users (case-insensitive); leaves everything else alone. */
export function encodeMentions(content: string, users: User[]): string {
  const byName = new Map(users.map((u) => [u.username.toLowerCase(), u.id]));
  // Not after a word character, so "me@example.com" isn't a mention.
  return content.replace(/(?<![\w@])@([A-Za-z0-9_.-]{2,32})/g, (match, raw: string) => {
    let name = raw;
    // "@luis." at the end of a sentence: the dot isn't part of the name.
    while (name && !byName.has(name.toLowerCase()) && /[.-]$/.test(name)) name = name.slice(0, -1);
    const id = byName.get(name.toLowerCase());
    return id === undefined ? match : `<@${id}>${raw.slice(name.length)}`;
  });
}

/** Back to "@username" form, e.g. for a draft restored into the message box. */
export function decodeMentions(content: string, users: Map<number, User>): string {
  return content.replace(MENTION_TOKEN, (match, id: string) => {
    const user = users.get(Number(id));
    return user ? `@${user.username}` : match;
  });
}
