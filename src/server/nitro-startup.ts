// Nitro runtime plugin: runs when the server starts. The app's own server
// code (TanStack Start) is only loaded on the first request, which is too late
// to print the generated admin password at startup.
import { definePlugin } from "nitro";
import { closeDb } from "./db";
import { initAccounts } from "./startup";

export default definePlugin(() => {
  initAccounts();
  // The plugin is bundled separately from the request handlers, so it has its
  // own connection; the handlers open theirs when needed.
  closeDb();
});
