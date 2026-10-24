// Shared directory of users, so every component shows people's current name and picture.
import { createContext, useContext } from "react";
import type { User } from "./api.ts";

const UsersContext = createContext<Map<number, User>>(new Map());

export const UsersProvider = UsersContext.Provider;

export const useUsers = () => useContext(UsersContext);

/** The name to show for a user: their display name, or their username. */
export const displayName = (user: Pick<User, "username" | "displayName">) => user.displayName || user.username;

export type Profile = { name: string; avatarUrl: string | null; username: string | null };

/** Current name/picture for a user id, falling back to a name from elsewhere (e.g. LiveKit). */
export function profileOf(users: Map<number, User>, userId: number, fallbackName: string): Profile {
  const user = users.get(userId);
  return user
    ? { name: displayName(user), avatarUrl: user.avatarUrl, username: user.username }
    : { name: fallbackName, avatarUrl: null, username: null };
}
