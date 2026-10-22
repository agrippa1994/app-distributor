#!/usr/bin/env bun
/**
 * appdist - upload .ipa/.apk builds to an app-distributor server.
 *
 *   appdist init                     store server URL and credentials
 *   appdist upload <file> [-n notes] upload a build
 *   appdist build <ios|android|all>  build an Expo project locally and upload it
 *
 * Credentials live in $XDG_CONFIG_HOME/app-distributor/config.json
 * (~/.config/... by default, mode 0600). APPDIST_URL, APPDIST_USER and
 * APPDIST_PASSWORD override the stored values, e.g. in CI.
 */
import { createReadStream } from "node:fs";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { parseArgs } from "node:util";
import { build } from "./build.ts";

interface Config {
  url: string;
  user: string;
  password: string;
}

const USAGE = `Usage: appdist <command> [options]

Commands:
  init                     Configure server URL and credentials
    --url <url>            Server URL, e.g. https://apps.example.com
    --user <name>          Username
    --password <password>  Password (prompted if omitted)
  upload <file>            Upload an .ipa or .apk
    -n, --notes <text>     Release notes
    --json                 Print the server response as JSON
  build <ios|android|all>  Build the Expo project in the current directory
                           (after \`expo prebuild\`) and upload the result
    -n, --notes <text>     Release notes
    --env-file <path>      Env file for the build (default .env.production.local)
    --export-method <m>    iOS: ad-hoc (default), development or enterprise
    --skip-upload          Only build
    --verbose              Show full xcodebuild/gradle output

Environment:
  APPDIST_URL, APPDIST_USER, APPDIST_PASSWORD override the stored config.
  APPDIST_CONFIG sets the config file path.
  APPDIST_ANDROID_KEYSTORE, APPDIST_ANDROID_KEYSTORE_PASSWORD,
  APPDIST_ANDROID_KEY_ALIAS, APPDIST_ANDROID_KEY_PASSWORD sign the release APK
  (also read from the env file). Without them the debug keystore is used.
`;

function configPath(): string {
  if (process.env.APPDIST_CONFIG) return process.env.APPDIST_CONFIG;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "app-distributor", "config.json");
}

async function readConfig(): Promise<Partial<Config>> {
  try {
    return JSON.parse(await readFile(configPath(), "utf8")) as Partial<Config>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Cannot read ${configPath()}: ${(err as Error).message}`);
  }
}

async function writeConfig(config: Config): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function loadConfig(): Promise<Config> {
  const stored = await readConfig();
  const config = {
    url: process.env.APPDIST_URL || stored.url,
    user: process.env.APPDIST_USER || stored.user,
    password: process.env.APPDIST_PASSWORD || stored.password,
  };
  if (!config.url || !config.user || !config.password) {
    throw new Error("Not configured. Run `appdist init` or set APPDIST_URL/USER/PASSWORD.");
  }
  return { ...config, url: normalizeUrl(config.url) } as Config;
}

function normalizeUrl(raw: string): string {
  const local = /^(localhost|127\.0\.0\.1)(:|\/|$)/i.test(raw);
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `${local ? "http" : "https"}://${raw}`;
  const url = new URL(withScheme);
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

function authHeader({ user, password }: Config): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

async function errorMessage(res: Response): Promise<string> {
  const text = await res.text();
  try {
    return (JSON.parse(text) as { error?: string }).error ?? text;
  } catch {
    return text || res.statusText;
  }
}

// --- prompts ----------------------------------------------------------------

/** Reads lines from stdin one at a time, so piped input works for several prompts. */
let lineReader: AsyncIterator<string> | undefined;
async function readLine(): Promise<string> {
  if (!lineReader) {
    const { createInterface } = await import("node:readline");
    lineReader = createInterface({ input: process.stdin, terminal: false })[Symbol.asyncIterator]();
  }
  const { value, done } = await lineReader.next();
  if (done) throw new Error("Unexpected end of input");
  return value;
}

async function prompt(question: string, fallback?: string): Promise<string> {
  process.stderr.write(fallback ? `${question} [${fallback}]: ` : `${question}: `);
  const answer = (await readLine()).trim();
  return answer || fallback || "";
}

async function promptSecret(question: string, hasFallback: boolean): Promise<string> {
  process.stderr.write(hasFallback ? `${question} [keep current]: ` : `${question}: `);
  const stdin = process.stdin;
  if (!stdin.isTTY) return readLine();

  return new Promise((resolve, reject) => {
    let value = "";
    const done = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (data: Buffer) => {
      for (const ch of data.toString("utf8")) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return done();
        if (ch === "\u0003") return done(new Error("Aborted"));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

// --- commands ---------------------------------------------------------------

async function init(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: "string" },
      user: { type: "string" },
      password: { type: "string" },
    },
  });
  const current = await readConfig();

  const url = normalizeUrl(values.url ?? (await prompt("Server URL", current.url)));
  const user = values.user ?? (await prompt("Username", current.user));
  if (!user) throw new Error("Username is required");
  const password =
    values.password ?? ((await promptSecret("Password", !!current.password)) || current.password);
  if (!password) throw new Error("Password is required");

  const config = { url, user, password };
  const res = await fetch(`${url}/api/me`, { headers: { authorization: authHeader(config) } });
  if (res.status === 401) throw new Error("Invalid username or password");
  if (!res.ok) throw new Error(`${url} responded ${res.status}: ${await errorMessage(res)}`);

  await writeConfig(config);
  log(`Logged in to ${url} as ${user}. Saved to ${configPath()}`);
}

async function upload(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      notes: { type: "string", short: "n" },
      json: { type: "boolean" },
    },
  });
  const [file] = positionals;
  if (!file || positionals.length > 1) throw new Error("Usage: appdist upload <file> [-n notes]");
  await uploadFile(file, values);
}

/** Uploads an .ipa/.apk and prints the result. */
async function uploadFile(
  file: string,
  values: { notes?: string; json?: boolean } = {},
): Promise<void> {
  const config = await loadConfig();
  const { size } = await stat(file);
  const filename = basename(file);

  const query = new URLSearchParams({ filename });
  if (values.notes) query.set("notes", values.notes);

  const showProgress = process.stderr.isTTY && !values.json;
  let sent = 0;
  let lastDraw = 0;
  const draw = (force = false) => {
    if (!showProgress || (!force && Date.now() - lastDraw < 100)) return;
    lastDraw = Date.now();
    const pct = size ? Math.floor((sent / size) * 100) : 100;
    process.stderr.write(
      `\rUploading ${filename}  ${formatBytes(sent)} / ${formatBytes(size)}  ${pct}%`,
    );
  };

  const stream = createReadStream(file);
  stream.on("data", (chunk) => {
    sent += chunk.length;
    draw();
  });

  const res = await fetch(`${config.url}/api/upload?${query}`, {
    method: "PUT",
    headers: {
      authorization: authHeader(config),
      "content-type": "application/octet-stream",
      "content-length": String(size),
    },
    body: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
    // Required by Node to stream a request body; ignored by Bun.
    duplex: "half",
  } as RequestInit);
  draw(true);
  if (showProgress) process.stderr.write("\n");

  if (!res.ok) {
    const message = await errorMessage(res);
    throw new Error(
      res.status === 401
        ? `Unauthorized - run \`appdist init\``
        : `Upload failed (${res.status}): ${message}`,
    );
  }

  const result = (await res.json()) as {
    duplicate: boolean;
    name: string;
    platform: string;
    bundleId: string;
    version: string;
    build: string;
    url: string;
  };
  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const label = `${result.name} ${result.version} (${result.build}) · ${result.platform} · ${result.bundleId}`;
  log(result.duplicate ? `Already uploaded: ${label}` : `Uploaded ${label}`);
  console.log(result.url);
}

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "init":
      return init(rest);
    case "upload":
      return upload(rest);
    case "build":
      return build(rest, uploadFile);
    case undefined:
    case "help":
    case "-h":
    case "--help":
      process.stdout.write(USAGE);
      return;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      process.exitCode = 1;
  }
}

main().then(
  // Close the stdin line reader so the process can exit.
  () => process.stdin.destroy(),
  (err: unknown) => {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
