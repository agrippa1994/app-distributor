import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import {
  type Grant,
  MIN_PASSWORD_LENGTH,
  USERNAME_PATTERN,
  isValidGrantTarget,
} from "#/lib/permissions";
import { db, write } from "./db";

export interface Account {
  id: number;
  username: string;
  admin: boolean;
  grants: Grant[];
  mustChangePassword: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AccountInput {
  username: string;
  /** Required on create; on update an empty/undefined password keeps the current one. */
  password?: string;
  admin: boolean;
  grants: Grant[];
}

export class AccountError extends Error {}

interface AccountRow {
  id: number;
  username: string;
  password_hash: string;
  is_admin: number;
  session_gen: number;
  must_change_password: number;
  created_at: string;
  updated_at: string;
}

interface GrantRow {
  account_id: number;
  app: string;
  can_read: number;
  can_upload: number;
}

function grantsFor(accountId: number): Grant[] {
  const rows = db()
    .prepare("SELECT * FROM grants WHERE account_id = ? ORDER BY app = '*' DESC, app")
    .all(accountId) as unknown as GrantRow[];
  return rows.map(toGrant);
}

function toGrant(row: GrantRow): Grant {
  return { app: row.app, read: row.can_read === 1, upload: row.can_upload === 1 };
}

function toAccount(row: AccountRow, grants: Grant[]): Account {
  return {
    id: row.id,
    username: row.username,
    admin: row.is_admin === 1,
    grants,
    mustChangePassword: row.must_change_password === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function findRow(username: string): AccountRow | undefined {
  return db().prepare("SELECT * FROM accounts WHERE username = ?").get(username) as
    | AccountRow
    | undefined;
}

export interface StoredAccount extends Account {
  passwordHash: string;
  sessionGen: number;
}

export function findAccount(username: string): StoredAccount | null {
  const row = findRow(username);
  if (!row) return null;
  return {
    ...toAccount(row, grantsFor(row.id)),
    passwordHash: row.password_hash,
    sessionGen: row.session_gen,
  };
}

export function listAccounts(): Account[] {
  const rows = db()
    .prepare("SELECT * FROM accounts ORDER BY username COLLATE NOCASE")
    .all() as unknown as AccountRow[];
  const grantRows = db()
    .prepare("SELECT * FROM grants ORDER BY app = '*' DESC, app")
    .all() as unknown as GrantRow[];
  const byAccount = new Map<number, Grant[]>();
  for (const g of grantRows) {
    const list = byAccount.get(g.account_id) ?? [];
    list.push(toGrant(g));
    byAccount.set(g.account_id, list);
  }
  return rows.map((row) => toAccount(row, byAccount.get(row.id) ?? []));
}

/** Validate and normalise grants: one entry per app, entries without any permission dropped. */
export function normalizeGrants(grants: Grant[]): Grant[] {
  const merged = new Map<string, Grant>();
  for (const g of grants) {
    const app = String(g.app ?? "").trim();
    if (!isValidGrantTarget(app)) throw new AccountError(`Invalid app "${app}"`);
    const prev = merged.get(app);
    merged.set(app, {
      app,
      read: Boolean(g.read) || Boolean(prev?.read),
      upload: Boolean(g.upload) || Boolean(prev?.upload),
    });
  }
  return [...merged.values()].filter((g) => g.read || g.upload);
}

function validatePassword(password: string) {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new AccountError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
}

const hashPassword = (password: string) => bcrypt.hash(password, 12);

export async function createAccount(input: AccountInput): Promise<Account> {
  const username = input.username.trim();
  if (!USERNAME_PATTERN.test(username)) {
    throw new AccountError("Username may only contain letters, digits and . _ @ -");
  }
  validatePassword(input.password ?? "");
  const grants = normalizeGrants(input.grants);
  const passwordHash = await hashPassword(input.password ?? "");

  const id = write((database) => {
    if (findRow(username)) throw new AccountError(`Account "${username}" already exists`);
    const now = new Date().toISOString();
    const { lastInsertRowid } = database
      .prepare(
        "INSERT INTO accounts (username, password_hash, is_admin, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(username, passwordHash, input.admin ? 1 : 0, now, now);
    insertGrants(Number(lastInsertRowid), grants);
    return Number(lastInsertRowid);
  });
  return getAccount(id);
}

export async function updateAccount(id: number, input: Omit<AccountInput, "username">) {
  const grants = normalizeGrants(input.grants);
  const password = input.password || undefined;
  if (password !== undefined) validatePassword(password);
  const passwordHash = password === undefined ? undefined : await hashPassword(password);

  write((database) => {
    if (!database.prepare("SELECT 1 FROM accounts WHERE id = ?").get(id)) {
      throw new AccountError("Account not found");
    }
    const now = new Date().toISOString();
    database
      .prepare("UPDATE accounts SET is_admin = ?, updated_at = ? WHERE id = ?")
      .run(input.admin ? 1 : 0, now, id);
    if (passwordHash !== undefined) {
      database
        .prepare(
          "UPDATE accounts SET password_hash = ?, session_gen = session_gen + 1 WHERE id = ?",
        )
        .run(passwordHash, id);
    }
    database.prepare("DELETE FROM grants WHERE account_id = ?").run(id);
    insertGrants(id, grants);
  });
  return getAccount(id);
}

export function deleteAccount(id: number): boolean {
  return write((database) => {
    return database.prepare("DELETE FROM accounts WHERE id = ?").run(id).changes > 0;
  });
}

export function getAccount(id: number): Account {
  const row = db().prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow | undefined;
  if (!row) throw new AccountError("Account not found");
  return toAccount(row, grantsFor(row.id));
}

function insertGrants(accountId: number, grants: Grant[]) {
  const insert = db().prepare(
    "INSERT INTO grants (account_id, app, can_read, can_upload) VALUES (?, ?, ?, ?)",
  );
  for (const g of grants) insert.run(accountId, g.app, g.read ? 1 : 0, g.upload ? 1 : 0);
}

/** Change the password of the signed-in user after checking the current one. */
export async function changeOwnPassword(
  username: string,
  currentPassword: string,
  newPassword: string,
): Promise<StoredAccount> {
  const account = findAccount(username);
  if (!account || !(await bcrypt.compare(currentPassword, account.passwordHash))) {
    throw new AccountError("Current password is wrong");
  }
  validatePassword(newPassword);
  if (newPassword === currentPassword) {
    throw new AccountError("The new password must differ from the current one");
  }
  const passwordHash = await hashPassword(newPassword);
  write((database) => {
    database
      .prepare(
        `UPDATE accounts SET password_hash = ?, session_gen = session_gen + 1,
           must_change_password = 0, updated_at = ? WHERE id = ?`,
      )
      .run(passwordHash, new Date().toISOString(), account.id);
  });
  return findAccount(account.username)!;
}

export const BOOTSTRAP_ADMIN = "admin";

/**
 * Called on server start. Without any account, creates the admin account
 * `admin` with a random password, which must be changed at the first sign-in.
 * With `reset`, does the same for an existing `admin` account (lost password).
 * Returns the generated password, or null when nothing was done.
 */
export function bootstrapAdmin({ reset = false } = {}): string | null {
  const hasAccounts = db().prepare("SELECT 1 FROM accounts LIMIT 1").get() !== undefined;
  if (hasAccounts && !reset) return null;

  const password = randomBytes(12).toString("base64url");
  const passwordHash = bcrypt.hashSync(password, 12);
  const now = new Date().toISOString();
  write((database) => {
    const existing = findRow(BOOTSTRAP_ADMIN);
    if (existing) {
      database
        .prepare(
          `UPDATE accounts SET password_hash = ?, is_admin = 1, must_change_password = 1,
             session_gen = session_gen + 1, updated_at = ? WHERE id = ?`,
        )
        .run(passwordHash, now, existing.id);
    } else {
      database
        .prepare(
          `INSERT INTO accounts (username, password_hash, is_admin, must_change_password, created_at, updated_at)
           VALUES (?, ?, 1, 1, ?, ?)`,
        )
        .run(BOOTSTRAP_ADMIN, passwordHash, now, now);
    }
  });
  return password;
}
