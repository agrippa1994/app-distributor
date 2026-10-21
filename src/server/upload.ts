import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { authenticate, unauthorized } from "./auth";
import { config } from "./config";
import { baseUrl } from "./links";
import { ensureDirs, storeUpload, tmpDir } from "./storage";

/**
 * Accepts an .ipa/.apk either as the raw request body
 *   curl -u user:pass -T app.ipa https://host/api/upload
 * or as multipart form data (field `file`)
 *   curl -u user:pass -F file=@app.ipa -F notes="..." https://host/api/upload
 * Release notes can be passed as `?notes=`, an `X-Notes` header or form field.
 */
export async function handleUpload(request: Request): Promise<Response> {
  const user = await authenticate(request);
  if (!user) return unauthorized();

  const url = new URL(request.url);
  let notes = url.searchParams.get("notes") ?? request.headers.get("x-notes") ?? undefined;
  let filename = url.searchParams.get("filename") ?? undefined;
  let body: ReadableStream<Uint8Array> | null;

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.startsWith("multipart/form-data")) {
    // Note: multipart bodies are buffered by the runtime; prefer `-T` for large files.
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return error(400, "Missing form field `file`");
    const formNotes = form.get("notes");
    if (typeof formNotes === "string") notes = formNotes;
    filename ??= file.name;
    body = file.stream();
  } else {
    body = request.body;
    // curl -T sends PUT /api/upload/<filename> when the URL ends with a slash
    filename ??= decodeURIComponent(url.pathname.split("/").slice(3).join("/")) || undefined;
  }
  if (!body) return error(400, "Empty request body");

  const limit = config().maxUploadBytes;
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > limit) return error(413, `File exceeds MAX_UPLOAD_MB (${limit / 1024 / 1024} MB)`);

  await ensureDirs();
  const tmpPath = join(tmpDir(), `${Date.now()}-${randomBytes(6).toString("hex")}.upload`);
  const hash = createHash("sha256");
  let size = 0;

  try {
    await pipeline(
      Readable.fromWeb(body as WebReadableStream<Uint8Array>),
      new Transform({
        transform(chunk: Buffer, _enc, cb) {
          size += chunk.length;
          if (size > limit) return cb(new UploadError(413, "File exceeds MAX_UPLOAD_MB"));
          hash.update(chunk);
          cb(null, chunk);
        },
      }),
      createWriteStream(tmpPath),
    );
    if (size === 0) throw new UploadError(400, "Empty request body");

    const { version, duplicate } = await storeUpload({
      tmpPath,
      size,
      sha256: hash.digest("hex"),
      uploadedBy: user,
      notes,
      originalFilename: filename,
    });

    return Response.json(
      {
        duplicate,
        app: version.appKey,
        id: version.id,
        platform: version.platform,
        bundleId: version.bundleId,
        name: version.name,
        version: version.version,
        build: version.build,
        url: `${baseUrl(request)}/apps/${version.appKey}`,
      },
      { status: duplicate ? 200 : 201 },
    );
  } catch (err) {
    await rm(tmpPath, { force: true });
    if (err instanceof UploadError) return error(err.status, err.message);
    return error(422, err instanceof Error ? err.message : "Upload failed");
  }
}

class UploadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function error(status: number, message: string) {
  return Response.json({ error: message }, { status });
}
