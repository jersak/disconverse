// Record of administrative actions. Append-only: nothing in the app deletes from it.
import { run } from "./db.ts";

/** `userId` null = done by the server itself (e.g. the retention job). */
export function audit(userId: number | null, action: string, details: Record<string, unknown> = {}) {
  run(
    "INSERT INTO admin_audit (user_id, action, details, created_at) VALUES (?, ?, ?, ?)",
    userId,
    action,
    JSON.stringify(details),
    Date.now(),
  );
}
