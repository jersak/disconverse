import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

export const dataDir = process.env.DATA_DIR ?? "./data";
mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(join(dataDir, "disconverse.db"));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
`);

/**
 * Schema changes, applied in order. The database's `user_version` records how many have run.
 * Never edit a migration that has shipped; add a new one instead.
 */
const MIGRATIONS: ((now: number) => string)[] = [
  // 1: initial schema (IF NOT EXISTS: databases created before versioning already have it).
  () => `
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY,
      username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT    NOT NULL,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS invites (
      code       TEXT    PRIMARY KEY,
      created_at INTEGER NOT NULL,
      used_by    INTEGER REFERENCES users(id),
      used_at    INTEGER
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT    PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id         INTEGER PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      content    TEXT    NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id         TEXT    PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
      filename   TEXT    NOT NULL,
      mime       TEXT    NOT NULL,
      size       INTEGER NOT NULL,
      width      INTEGER,
      height     INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS attachments_by_message ON attachments(message_id);
  `,

  // 2: roles and channels. Existing messages move to #general; the first account becomes owner.
  (now) => `
    ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member';
    UPDATE users SET role = 'owner' WHERE id = (SELECT MIN(id) FROM users);

    ALTER TABLE invites ADD COLUMN created_by INTEGER REFERENCES users(id);

    CREATE TABLE channels (
      id         INTEGER PRIMARY KEY,
      type       TEXT    NOT NULL CHECK (type IN ('text', 'voice')),
      name       TEXT    NOT NULL,
      position   INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    INSERT INTO channels (id, type, name, position, created_at) VALUES
      (1, 'text', 'general', 0, ${now}),
      (2, 'voice', 'General', 0, ${now});

    -- No REFERENCES: SQLite can't add a foreign key column with a non-null default.
    -- Channel deletion removes its messages explicitly (see channels.ts).
    ALTER TABLE messages ADD COLUMN channel_id INTEGER NOT NULL DEFAULT 1;
    CREATE INDEX messages_by_channel ON messages(channel_id, id);
  `,

  // 3: profiles (display name shown instead of the username; profile picture file name).
  () => `
    ALTER TABLE users ADD COLUMN display_name TEXT;
    ALTER TABLE users ADD COLUMN avatar TEXT;
  `,

  // 4: admin panel: audit log, runtime settings, password re-confirmation, removable media.
  () => `
    CREATE TABLE admin_audit (
      id         INTEGER PRIMARY KEY,
      user_id    INTEGER REFERENCES users(id),
      action     TEXT    NOT NULL,
      details    TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    ALTER TABLE sessions ADD COLUMN sudo_until INTEGER;
    ALTER TABLE attachments ADD COLUMN removed_at INTEGER;
    CREATE INDEX attachments_by_created ON attachments(created_at);
  `,

  // 5: small preview images made by the uploader's browser (stored under uploads/thumbs).
  () => `
    ALTER TABLE attachments ADD COLUMN thumb_mime TEXT;
  `,
];

function migrate() {
  const { user_version: current } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(MIGRATIONS[version]!(Date.now()));
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`Database migration ${version + 1} failed: ${(err as Error).message}`);
    }
  }
}
migrate();

const statements = new Map<string, StatementSync>();
function prepare(sql: string): StatementSync {
  let stmt = statements.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    statements.set(sql, stmt);
  }
  return stmt;
}

export function one<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
  return prepare(sql).get(...params) as T | undefined;
}

export function all<T>(sql: string, ...params: SQLInputValue[]): T[] {
  return prepare(sql).all(...params) as T[];
}

export function run(sql: string, ...params: SQLInputValue[]) {
  return prepare(sql).run(...params);
}

export function transaction<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
