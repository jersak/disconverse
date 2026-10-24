// Admin commands. Locally: `npm run cli -w server -- <command>`.
// On the server: `docker compose exec backend node src/cli.ts <command>`.
import { randomBytes } from "node:crypto";
import { all, one, run } from "./db.ts";
import { hashPassword, randomPassword } from "./passwords.ts";

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "invite": {
    const count = Math.max(1, Number(args[0]) || 1);
    for (let i = 0; i < count; i++) {
      const code = randomBytes(9).toString("base64url");
      run("INSERT INTO invites (code, created_at) VALUES (?, ?)", code, Date.now());
      console.log(code);
    }
    break;
  }
  case "invites": {
    const rows = all<{ code: string; username: string | null }>(
      "SELECT i.code, u.username FROM invites i LEFT JOIN users u ON u.id = i.used_by ORDER BY i.created_at",
    );
    for (const r of rows) console.log(`${r.code}  ${r.username ? `used by ${r.username}` : "unused"}`);
    break;
  }
  case "users": {
    const rows = all<{ id: number; username: string; display_name: string | null; role: string; created_at: number }>(
      "SELECT id, username, display_name, role, created_at FROM users ORDER BY id",
    );
    for (const r of rows) {
      const name = r.display_name ? `${r.username} ("${r.display_name}")` : r.username;
      console.log(`${r.id}\t${name}\t${r.role}\t${new Date(r.created_at).toISOString()}`);
    }
    break;
  }
  case "reset-password": {
    const user = one<{ id: number }>("SELECT id FROM users WHERE username = ?", args[0] ?? "");
    if (!user) {
      console.error(`No user named "${args[0] ?? ""}"`);
      process.exit(1);
    }
    const password = randomPassword();
    run("UPDATE users SET password_hash = ? WHERE id = ?", await hashPassword(password), user.id);
    run("DELETE FROM sessions WHERE user_id = ?", user.id);
    console.log(`New password for ${args[0]}: ${password}`);
    break;
  }
  case "set-role": {
    const [username = "", role = ""] = args;
    if (!["owner", "admin", "member"].includes(role)) {
      console.error("Role must be owner, admin or member");
      process.exit(1);
    }
    const changed = run("UPDATE users SET role = ? WHERE username = ?", role, username).changes;
    if (!changed) {
      console.error(`No user named "${username}"`);
      process.exit(1);
    }
    console.log(`${username} is now ${role}. (Open apps pick this up on reload.)`);
    break;
  }
  default:
    console.log(`Usage: cli.ts <command>
  invite [count]            create invite code(s)
  invites                   list invite codes and who used them
  users                     list users
  reset-password <username> set a new random password and log the user out
  set-role <username> <owner|admin|member>`);
}
