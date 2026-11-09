import { BOOTSTRAP_ADMIN, bootstrapAdmin } from "./accounts";
import { databasePath } from "./db";

/**
 * Open the accounts database on server start (restoring it from the snapshot
 * if needed) and create the initial admin account. Its generated password is
 * printed once, here; it must be changed at the first sign-in.
 */
export function initAccounts() {
  const reset = process.env.RESET_ADMIN_PASSWORD === "true";
  const password = bootstrapAdmin({ reset });
  if (password === null) return;

  const lines = [
    reset
      ? `RESET_ADMIN_PASSWORD is set: the "${BOOTSTRAP_ADMIN}" account got a new password.`
      : `Created the admin account in ${databasePath()}.`,
    "",
    `  Username: ${BOOTSTRAP_ADMIN}`,
    `  Password: ${password}`,
    "",
    "Sign in and change the password; until then the account can do nothing else.",
    "This password is not shown again.",
  ];
  if (reset)
    lines.push("", "Remove RESET_ADMIN_PASSWORD, or the password is reset on every start.");
  const rule = "=".repeat(72);
  console.log([rule, ...lines, rule].join("\n"));
}
