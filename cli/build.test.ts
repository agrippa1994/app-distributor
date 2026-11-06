import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { build, parseEnv } from "./build.ts";

const STORE_PASSWORD = "store-s3cret";
const KEY_PASSWORD = "key-s3cret";
const SIGNING_PREFIX = "ORG_GRADLE_PROJECT_android.injected.signing";
const AAB = join("android", "app", "build", "outputs", "bundle", "release", "app-release.aab");
const APK = join("android", "app", "build", "outputs", "apk", "release", "app-release.apk");

// Records its arguments and environment, then acts like Gradle for the task it was given.
// The dash shebang guards build's use of bash: run directly, dash would drop the
// dotted signing variables just as it does for a real gradlew where sh is dash.
const FAKE_GRADLEW = `#!/bin/dash
printf '%s\\n' "$@" > args.txt
env > env.txt
[ -n "$FAKE_GRADLE_EXIT" ] && exit "$FAKE_GRADLE_EXIT"
[ -n "$FAKE_GRADLE_NO_OUTPUT" ] && exit 0
case "$1" in
  app:bundleRelease) dir=bundle/release; file=app-release.aab ;;
  app:assembleRelease) dir=apk/release; file=app-release.apk ;;
esac
mkdir -p "app/build/outputs/$dir"
touch "app/build/outputs/$dir/$file"
`;

let project: string;
let keystore: string;
let upload: ReturnType<typeof vi.fn<(file: string, options: { notes?: string }) => Promise<void>>>;
let stdout: string[];
let stderr: string[];
const startDir = process.cwd();
const startEnv = process.env;

function writeEnvFile(lines: string[], name = ".env.production.local"): void {
  writeFileSync(join(project, name), `${lines.join("\n")}\n`);
}

function signingLines(): string[] {
  return [
    `APPDIST_ANDROID_KEYSTORE=${keystore}`,
    `APPDIST_ANDROID_KEYSTORE_PASSWORD=${STORE_PASSWORD}`,
    "APPDIST_ANDROID_KEY_ALIAS=release",
    `APPDIST_ANDROID_KEY_PASSWORD=${KEY_PASSWORD}`,
  ];
}

const gradleRan = () => existsSync(join(project, "android", "args.txt"));
const gradleArgs = () => readFileSync(join(project, "android", "args.txt"), "utf8").split("\n");
const gradleEnv = () => readFileSync(join(project, "android", "env.txt"), "utf8");

/** Everything the passwords must never appear in. */
function expectNoPasswordsExposed(): void {
  const exposed = [stdout.join(""), stderr.join("")];
  if (gradleRan()) exposed.push(gradleArgs().join("\n"));
  for (const text of exposed) {
    expect(text).not.toContain(STORE_PASSWORD);
    expect(text).not.toContain(KEY_PASSWORD);
  }
}

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "appdist-build-"));
  keystore = join(project, "release.jks");
  writeFileSync(keystore, "");
  writeFileSync(join(project, "package.json"), "{}");
  mkdirSync(join(project, "android"));
  writeFileSync(join(project, "android", "gradlew"), FAKE_GRADLEW);
  chmodSync(join(project, "android", "gradlew"), 0o755);
  process.chdir(project);

  // A developer's own signing settings must not reach these tests.
  process.env = Object.fromEntries(
    Object.entries(startEnv).filter(([name]) => !name.startsWith("APPDIST_")),
  );
  upload = vi.fn(async () => {});
  stdout = [];
  stderr = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => void stdout.push(`${line}\n`));
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(startDir);
  process.env = startEnv;
  rmSync(project, { recursive: true, force: true });
});

describe("appdist build android --aab", () => {
  test("bundles with the release keystore, prints the path and does not upload", async () => {
    writeEnvFile(signingLines());
    await build(["android", "--aab"], upload);

    expect(gradleArgs()[0]).toBe("app:bundleRelease");
    expect(gradleEnv()).toContain(`${SIGNING_PREFIX}.store.file=${keystore}\n`);
    expect(gradleEnv()).toContain(`${SIGNING_PREFIX}.store.password=${STORE_PASSWORD}\n`);
    expect(gradleEnv()).toContain(`${SIGNING_PREFIX}.key.alias=release\n`);
    expect(gradleEnv()).toContain(`${SIGNING_PREFIX}.key.password=${KEY_PASSWORD}\n`);
    expect(stdout).toEqual([`${join(process.cwd(), AAB)}\n`]);
    expect(upload).not.toHaveBeenCalled();
    expectNoPasswordsExposed();
  });

  test("reads the keystore settings from --env-file", async () => {
    writeEnvFile(signingLines(), ".env.play");
    await build(["android", "--aab", "--env-file", ".env.play"], upload);

    expect(gradleEnv()).toContain(`${SIGNING_PREFIX}.store.password=${STORE_PASSWORD}\n`);
  });

  test("resolves a relative keystore path against the project", async () => {
    writeEnvFile([...signingLines(), "APPDIST_ANDROID_KEYSTORE=release.jks"]);
    await build(["android", "--aab"], upload);

    expect(gradleEnv()).toContain(
      `${SIGNING_PREFIX}.store.file=${join(process.cwd(), "release.jks")}\n`,
    );
  });

  test("keeps passwords out of verbose gradle arguments", async () => {
    writeEnvFile(signingLines());
    await build(["android", "--aab", "--verbose"], upload);

    expect(gradleArgs()).not.toContain("--quiet");
    expectNoPasswordsExposed();
  });

  test.each([
    "APPDIST_ANDROID_KEYSTORE",
    "APPDIST_ANDROID_KEYSTORE_PASSWORD",
    "APPDIST_ANDROID_KEY_ALIAS",
  ])("fails without building when %s is missing", async (name) => {
    writeEnvFile(signingLines().filter((line) => !line.startsWith(`${name}=`)));

    const error = await build(["android", "--aab"], upload).catch((err: Error) => err);
    expect((error as Error).message).toMatch(new RegExp(`^Missing ${name} `));
    expect((error as Error).message).toContain("debug keystore");
    expect((error as Error).message).not.toContain(STORE_PASSWORD);
    expect(gradleRan()).toBe(false);
  });

  test("fails without building when the keystore file does not exist", async () => {
    writeEnvFile(signingLines());
    rmSync(keystore);

    await expect(build(["android", "--aab"], upload)).rejects.toThrow(
      `Keystore not found: ${keystore}`,
    );
    expect(gradleRan()).toBe(false);
  });

  test("does not report a stale bundle from an earlier build", async () => {
    writeEnvFile(signingLines());
    await build(["android", "--aab"], upload);
    process.env.FAKE_GRADLE_NO_OUTPUT = "1";

    await expect(build(["android", "--aab"], upload)).rejects.toThrow("Gradle did not produce");
  });

  test("keeps passwords out of the error when gradle fails", async () => {
    writeEnvFile(signingLines());
    process.env.FAKE_GRADLE_EXIT = "1";

    const error = await build(["android", "--aab"], upload).catch((err: Error) => err);
    expect((error as Error).message).toBe("gradlew failed (exit code 1)");
    expectNoPasswordsExposed();
  });

  test.each(["ios", "all"])("is rejected for %s", async (target) => {
    writeEnvFile(signingLines());
    await expect(build([target, "--aab"], upload)).rejects.toThrow("--aab only applies");
  });
});

describe("appdist build android", () => {
  test("still builds and uploads a debug-signed APK without a keystore", async () => {
    writeEnvFile([]);
    await build(["android", "-n", "notes"], upload);

    expect(gradleArgs()[0]).toBe("app:assembleRelease");
    expect(gradleEnv()).not.toContain(SIGNING_PREFIX);
    expect(stderr.join("")).toContain("signed with the debug keystore");
    expect(upload).toHaveBeenCalledWith(join(process.cwd(), APK), { notes: "notes" });
  });

  test("signs the APK with the keystore, keeping passwords out of its arguments", async () => {
    writeEnvFile(signingLines());
    await build(["android"], upload);

    expect(gradleEnv()).toContain(`${SIGNING_PREFIX}.store.password=${STORE_PASSWORD}\n`);
    expectNoPasswordsExposed();
  });

  test("defaults the key password to the keystore password", async () => {
    writeEnvFile(signingLines().filter((line) => !line.includes("KEY_PASSWORD")));
    await build(["android"], upload);

    expect(gradleEnv()).toContain(`${SIGNING_PREFIX}.key.password=${STORE_PASSWORD}\n`);
  });
});

describe("parseEnv", () => {
  test("keeps special characters in a quoted password", () => {
    expect(parseEnv(`APPDIST_ANDROID_KEYSTORE_PASSWORD='p#ss w$rd'\n`)).toEqual({
      APPDIST_ANDROID_KEYSTORE_PASSWORD: "p#ss w$rd",
    });
  });
});
