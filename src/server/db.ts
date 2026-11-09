import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config";

// Accounts live in a SQLite database: $DATA_DIR/accounts.db.
//
// A file-level backup of a running container (e.g. a Docker volume archive)
// can catch the live database in the middle of a write. So after every change
// the database is also written to $DATA_DIR/accounts.snapshot.db with
// `VACUUM INTO` and an atomic rename. The snapshot is always a complete,
// consistent database, and backing up the data volume picks it up without
// stopping the container.
//
// On startup, a missing or corrupt accounts.db is restored from the snapshot.

const SCHEMA_VERSION = 2;

const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE accounts (
      id            INTEGER PRIMARY KEY,
      username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      is_admin      INTEGER NOT NULL DEFAULT 0,
      -- Bumped on password change; sessions signed with an older value are rejected.
      session_gen   INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );
    CREATE TABLE grants (
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      -- App key (<platform>-<bundleId>) or '*' for every app.
      app        TEXT NOT NULL,
      can_read   INTEGER NOT NULL DEFAULT 0,
      can_upload INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (account_id, app)
    );
  `,
  2: `
    -- Set for the generated admin account; cleared when its password is changed.
    ALTER TABLE accounts ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
  `,
};

export const databasePath = () => join(config().dataDir, "accounts.db");
export const snapshotPath = () => join(config().dataDir, "accounts.snapshot.db");

let instance: DatabaseSync | undefined;

export function db(): DatabaseSync {
  instance ??= open();
  return instance;
}

/** Close the database (tests). The next db() call opens it again. */
export function closeDb() {
  instance?.close();
  instance = undefined;
}

function open(): DatabaseSync {
  const path = databasePath();
  const snapshot = snapshotPath();
  mkdirSync(config().dataDir, { recursive: true });

  if (!existsSync(path) && existsSync(snapshot)) {
    console.warn(`[app-distributor] ${path} is missing; restoring it from ${snapshot}.`);
    copyFileSync(snapshot, path);
  }

  let database: DatabaseSync;
  try {
    database = connect(path);
  } catch (err) {
    if (!existsSync(snapshot)) throw err;
    const aside = `${path}.corrupt-${Date.now()}`;
    console.error(
      `[app-distributor] ${path} is unreadable (${err instanceof Error ? err.message : String(err)}); ` +
        `moving it to ${aside} and restoring from ${snapshot}.`,
    );
    renameSync(path, aside);
    for (const suffix of ["-journal", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
    copyFileSync(snapshot, path);
    database = connect(path);
  }

  migrate(database);
  writeSnapshot(database);
  return database;
}

function connect(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    const result = database.prepare("PRAGMA quick_check").get() as { quick_check: string };
    if (result.quick_check !== "ok")
      throw new Error(`integrity check failed: ${result.quick_check}`);
    return database;
  } catch (err) {
    database.close();
    throw err;
  }
}

function migrate(database: DatabaseSync) {
  const { user_version: current } = database.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `accounts.db has schema version ${current}, but this build only knows ${SCHEMA_VERSION}. ` +
        "Upgrade app-distributor.",
    );
  }
  for (let version = current + 1; version <= SCHEMA_VERSION; version++) {
    transaction(database, () => {
      database.exec(MIGRATIONS[version]);
      database.exec(`PRAGMA user_version = ${version}`);
    });
  }
}

export function transaction<T>(database: DatabaseSync, fn: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    database.exec("COMMIT");
    return result;
  } catch (err) {
    database.exec("ROLLBACK");
    throw err;
  }
}

/** Write a consistent copy of the database to accounts.snapshot.db (atomically replaced). */
export function writeSnapshot(database: DatabaseSync = db()) {
  const target = snapshotPath();
  const tmp = `${target}.tmp`;
  rmSync(tmp, { force: true });
  database.prepare("VACUUM INTO ?").run(tmp);
  renameSync(tmp, target);
}

/** Run a write in a transaction, then refresh the snapshot. */
export function write<T>(fn: (database: DatabaseSync) => T): T {
  const database = db();
  const result = transaction(database, () => fn(database));
  writeSnapshot(database);
  return result;
}
