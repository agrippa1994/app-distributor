import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { baseUrl, buildManifest, readDownloadToken } from "./links";
import { binaryFilename, binaryPath, getVersion } from "./storage";

const CONTENT_TYPES = {
  ios: "application/octet-stream",
  android: "application/vnd.android.package-archive",
};

/** GET /api/dl/<token>/<manifest.plist|app.ipa|app.apk> */
export async function handleDownload(
  request: Request,
  token: string,
  file: string,
): Promise<Response> {
  const ref = readDownloadToken(token);
  if (!ref) return new Response("Link expired or invalid", { status: 403 });
  const meta = await getVersion(ref.appKey, ref.id).catch(() => null);
  if (!meta) return new Response("Not found", { status: 404 });

  if (file === "manifest.plist" && meta.platform === "ios") {
    const ipaUrl = `${baseUrl(request)}/api/dl/${token}/${binaryFilename("ios")}`;
    return new Response(buildManifest(meta, ipaUrl), {
      headers: { "Content-Type": "text/xml; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  if (file !== binaryFilename(meta.platform)) return new Response("Not found", { status: 404 });

  const path = binaryPath(meta);
  const { size } = await stat(path);
  const safeName = `${meta.name}-${meta.version}-${meta.build}`.replace(/[^A-Za-z0-9._-]+/g, "_");
  const headers: Record<string, string> = {
    "Content-Type": CONTENT_TYPES[meta.platform],
    "Content-Disposition": `attachment; filename="${safeName}.${meta.platform === "ios" ? "ipa" : "apk"}"`,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=0",
  };

  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(end, size - 1);
    if (start > end) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    return new Response(stream(path, start, end), {
      status: 206,
      headers: {
        ...headers,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(end - start + 1),
      },
    });
  }

  if (request.method === "HEAD") {
    return new Response(null, { headers: { ...headers, "Content-Length": String(size) } });
  }
  return new Response(stream(path, 0, size - 1), {
    headers: { ...headers, "Content-Length": String(size) },
  });
}

function stream(path: string, start: number, end: number): ReadableStream {
  return Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream;
}
