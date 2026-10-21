import { open, type FileHandle } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

// Minimal random-access zip reader: reads only the central directory and the
// entries we ask for, so multi-hundred-MB IPAs/APKs never load into memory.

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CDH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

// Refuse to inflate anything bigger than this (metadata files are tiny).
const MAX_ENTRY_SIZE = 64 * 1024 * 1024;

export class ZipReader {
  private constructor(
    private readonly fh: FileHandle,
    readonly entries: ZipEntry[],
  ) {}

  static async open(path: string): Promise<ZipReader> {
    const fh = await open(path, "r");
    try {
      const entries = await readCentralDirectory(fh);
      return new ZipReader(fh, entries);
    } catch (err) {
      await fh.close();
      throw err;
    }
  }

  find(predicate: (name: string) => boolean): ZipEntry | undefined {
    return this.entries.find((e) => predicate(e.name));
  }

  async read(entry: ZipEntry): Promise<Buffer> {
    if (entry.uncompressedSize > MAX_ENTRY_SIZE) {
      throw new Error(`Zip entry ${entry.name} is too large`);
    }
    const header = await readAt(this.fh, entry.localHeaderOffset, 30);
    if (header.readUInt32LE(0) !== LFH_SIG) throw new Error("Invalid local file header");
    const nameLen = header.readUInt16LE(26);
    const extraLen = header.readUInt16LE(28);
    const data = await readAt(
      this.fh,
      entry.localHeaderOffset + 30 + nameLen + extraLen,
      entry.compressedSize,
    );
    if (entry.method === 0) return data;
    if (entry.method === 8) return inflateRawSync(data, { maxOutputLength: MAX_ENTRY_SIZE });
    throw new Error(`Unsupported zip compression method ${entry.method}`);
  }

  close(): Promise<void> {
    return this.fh.close();
  }
}

async function readAt(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  if (bytesRead !== length) throw new Error("Unexpected end of zip file");
  return buf;
}

async function readCentralDirectory(fh: FileHandle): Promise<ZipEntry[]> {
  const { size } = await fh.stat();
  const tailLen = Math.min(size, 65557);
  const tail = await readAt(fh, size - tailLen, tailLen);

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a zip file");

  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);

  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || tail.readUInt32LE(loc) !== ZIP64_LOCATOR_SIG) {
      throw new Error("Invalid zip64 archive");
    }
    const z64 = await readAt(fh, Number(tail.readBigUInt64LE(loc + 8)), 56);
    if (z64.readUInt32LE(0) !== ZIP64_EOCD_SIG) throw new Error("Invalid zip64 archive");
    count = Number(z64.readBigUInt64LE(32));
    cdSize = Number(z64.readBigUInt64LE(40));
    cdOffset = Number(z64.readBigUInt64LE(48));
  }

  const cd = await readAt(fh, cdOffset, cdSize);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (cd.readUInt32LE(p) !== CDH_SIG) throw new Error("Invalid central directory");
    const method = cd.readUInt16LE(p + 10);
    let compressedSize = cd.readUInt32LE(p + 20);
    let uncompressedSize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let localHeaderOffset = cd.readUInt32LE(p + 42);
    const name = cd.toString("utf8", p + 46, p + 46 + nameLen);

    // zip64 extended information extra field
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = cd.readUInt16LE(e);
      const len = cd.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (uncompressedSize === 0xffffffff) {
          uncompressedSize = Number(cd.readBigUInt64LE(q));
          q += 8;
        }
        if (compressedSize === 0xffffffff) {
          compressedSize = Number(cd.readBigUInt64LE(q));
          q += 8;
        }
        if (localHeaderOffset === 0xffffffff) {
          localHeaderOffset = Number(cd.readBigUInt64LE(q));
        }
      }
      e += 4 + len;
    }

    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
