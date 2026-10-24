// Server settings changed from the admin panel (stored in the database, JSON-encoded).
import { one, run } from "./db.ts";

export function getSetting<T>(key: string, fallback: T): T {
  const row = one<{ value: string }>("SELECT value FROM settings WHERE key = ?", key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function setSetting(key: string, value: unknown) {
  run(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    key,
    JSON.stringify(value),
  );
}
