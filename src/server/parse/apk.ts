import type { BinaryInfo } from "#/lib/types";
import type { ZipReader } from "./zip";

// Parses the compiled (binary XML) AndroidManifest.xml and, if needed,
// resources.arsc to resolve the app label. Only the bits we need are decoded.

const RES_STRING_POOL = 0x0001;
const RES_TABLE = 0x0002;
const RES_XML = 0x0003;
const RES_XML_START_ELEMENT = 0x0102;
const RES_XML_RESOURCE_MAP = 0x0180;
const RES_TABLE_PACKAGE = 0x0200;
const RES_TABLE_TYPE = 0x0201;

const TYPE_REFERENCE = 0x01;
const TYPE_STRING = 0x03;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_HEX = 0x11;

// android:* attribute resource ids (names may be stripped by obfuscators)
const ATTR_IDS: Record<number, string> = {
  0x01010001: "label",
  0x0101021b: "versionCode",
  0x0101021c: "versionName",
  0x0101020c: "minSdkVersion",
  0x01010270: "targetSdkVersion",
};

type AttrValue = { type: number; data: number; raw?: string };

interface Element {
  name: string;
  attrs: Record<string, AttrValue>;
}

export async function parseApk(zip: ZipReader): Promise<BinaryInfo> {
  const manifestEntry = zip.find((n) => n === "AndroidManifest.xml");
  if (!manifestEntry) throw new Error("AndroidManifest.xml not found in APK");
  const elements = parseAxml(await zip.read(manifestEntry));

  const manifest = elements.find((e) => e.name === "manifest");
  if (!manifest) throw new Error("Invalid AndroidManifest.xml");
  const usesSdk = elements.find((e) => e.name === "uses-sdk");
  const application = elements.find((e) => e.name === "application");

  const bundleId = manifest.attrs.package?.raw;
  if (!bundleId) throw new Error("Package name missing from AndroidManifest.xml");

  let table: ResourceTable | undefined;
  const resolve = async (v: AttrValue | undefined): Promise<string | undefined> => {
    if (!v) return undefined;
    if (v.raw !== undefined) return v.raw;
    if (v.type === TYPE_INT_DEC || v.type === TYPE_INT_HEX) return String(v.data);
    if (v.type === TYPE_REFERENCE) {
      if (!table) {
        const arsc = zip.find((n) => n === "resources.arsc");
        table = arsc ? parseResourceTable(await zip.read(arsc)) : new Map();
      }
      return table.get(v.data);
    }
    return undefined;
  };

  const intAttr = (v: AttrValue | undefined) =>
    v && (v.type === TYPE_INT_DEC || v.type === TYPE_INT_HEX) ? v.data : undefined;

  return {
    platform: "android",
    bundleId,
    name: (await resolve(application?.attrs.label)) || bundleId,
    version: (await resolve(manifest.attrs.versionName)) || "0",
    build: (await resolve(manifest.attrs.versionCode)) || "0",
    android: {
      minSdkVersion: intAttr(usesSdk?.attrs.minSdkVersion),
      targetSdkVersion: intAttr(usesSdk?.attrs.targetSdkVersion),
    },
  };
}

function parseAxml(buf: Buffer): Element[] {
  if (buf.readUInt16LE(0) !== RES_XML) throw new Error("Not a binary XML file");
  let strings: string[] = [];
  let resourceMap: number[] = [];
  const elements: Element[] = [];

  let p = buf.readUInt16LE(2);
  while (p + 8 <= buf.length) {
    const type = buf.readUInt16LE(p);
    const headerSize = buf.readUInt16LE(p + 2);
    const size = buf.readUInt32LE(p + 4);
    if (size === 0) break;

    if (type === RES_STRING_POOL) {
      strings = parseStringPool(buf, p);
    } else if (type === RES_XML_RESOURCE_MAP) {
      const n = (size - headerSize) / 4;
      resourceMap = Array.from({ length: n }, (_, i) => buf.readUInt32LE(p + headerSize + i * 4));
    } else if (type === RES_XML_START_ELEMENT) {
      const ext = p + headerSize;
      const name = strings[buf.readUInt32LE(ext + 4)] ?? "";
      const attrStart = buf.readUInt16LE(ext + 8);
      const attrSize = buf.readUInt16LE(ext + 10);
      const attrCount = buf.readUInt16LE(ext + 12);
      const attrs: Record<string, AttrValue> = {};
      for (let i = 0; i < attrCount; i++) {
        const a = ext + attrStart + i * attrSize;
        const nameIdx = buf.readUInt32LE(a + 4);
        const rawIdx = buf.readUInt32LE(a + 8);
        const valueType = buf.readUInt8(a + 15);
        const data = buf.readUInt32LE(a + 16);
        const attrName = ATTR_IDS[resourceMap[nameIdx]] ?? strings[nameIdx] ?? "";
        attrs[attrName] = {
          type: valueType,
          data,
          raw:
            rawIdx !== 0xffffffff
              ? strings[rawIdx]
              : valueType === TYPE_STRING
                ? strings[data]
                : undefined,
        };
      }
      elements.push({ name, attrs });
    }
    p += size;
  }
  return elements;
}

function parseStringPool(buf: Buffer, p: number): string[] {
  const headerSize = buf.readUInt16LE(p + 2);
  const count = buf.readUInt32LE(p + 8);
  const flags = buf.readUInt32LE(p + 16);
  const stringsStart = buf.readUInt32LE(p + 20);
  const utf8 = (flags & 0x100) !== 0;
  const out: string[] = [];

  for (let i = 0; i < count; i++) {
    let s = p + stringsStart + buf.readUInt32LE(p + headerSize + i * 4);
    if (utf8) {
      // utf16 length (skipped), then utf8 byte length, each 1 or 2 bytes
      s += buf[s] & 0x80 ? 2 : 1;
      let len = buf[s];
      if (len & 0x80) {
        len = ((len & 0x7f) << 8) | buf[s + 1];
        s += 2;
      } else s += 1;
      out.push(buf.toString("utf8", s, s + len));
    } else {
      let len = buf.readUInt16LE(s);
      if (len & 0x8000) {
        len = ((len & 0x7fff) << 16) | buf.readUInt16LE(s + 2);
        s += 4;
      } else s += 2;
      out.push(buf.toString("utf16le", s, s + len * 2));
    }
  }
  return out;
}

/** Map of resource id -> string value (default configuration preferred). */
type ResourceTable = Map<number, string>;

function parseResourceTable(buf: Buffer): ResourceTable {
  const table: ResourceTable = new Map();
  if (buf.readUInt16LE(0) !== RES_TABLE) return table;
  const references = new Map<number, number>();
  let globalStrings: string[] = [];

  let p = buf.readUInt16LE(2);
  while (p + 8 <= buf.length) {
    const type = buf.readUInt16LE(p);
    const size = buf.readUInt32LE(p + 4);
    if (size === 0) break;
    if (type === RES_STRING_POOL) globalStrings = parseStringPool(buf, p);
    else if (type === RES_TABLE_PACKAGE) parsePackage(buf, p, globalStrings, table, references);
    p += size;
  }

  // Resolve one level of @string -> @string indirection.
  for (const [id, target] of references) {
    const v = table.get(target);
    if (v !== undefined && !table.has(id)) table.set(id, v);
  }
  return table;
}

function parsePackage(
  buf: Buffer,
  pkgStart: number,
  strings: string[],
  table: ResourceTable,
  references: Map<number, number>,
) {
  const headerSize = buf.readUInt16LE(pkgStart + 2);
  const pkgEnd = pkgStart + buf.readUInt32LE(pkgStart + 4);
  const pkgId = buf.readUInt32LE(pkgStart + 8);

  let p = pkgStart + headerSize;
  while (p + 8 <= pkgEnd) {
    const type = buf.readUInt16LE(p);
    const chunkHeaderSize = buf.readUInt16LE(p + 2);
    const size = buf.readUInt32LE(p + 4);
    if (size === 0) break;

    if (type === RES_TABLE_TYPE) {
      const typeId = buf.readUInt8(p + 8);
      const flags = buf.readUInt8(p + 9);
      const entryCount = buf.readUInt32LE(p + 12);
      const entriesStart = buf.readUInt32LE(p + 16);
      // ResTable_config: language (2 bytes at offset 8) / country (offset 10)
      const config = p + 20;
      const isDefault = buf.readUInt32LE(config + 8) === 0;
      const sparse = (flags & 0x01) !== 0;
      const offset16 = (flags & 0x02) !== 0;
      const offsets = p + chunkHeaderSize;

      for (let i = 0; i < entryCount; i++) {
        let entryIdx = i;
        let offset: number;
        if (sparse) {
          entryIdx = buf.readUInt16LE(offsets + i * 4);
          offset = buf.readUInt16LE(offsets + i * 4 + 2) * 4;
        } else if (offset16) {
          const o = buf.readUInt16LE(offsets + i * 2);
          if (o === 0xffff) continue;
          offset = o * 4;
        } else {
          offset = buf.readUInt32LE(offsets + i * 4);
          if (offset === 0xffffffff) continue;
        }

        const e = p + entriesStart + offset;
        const entryFlags = buf.readUInt16LE(e + 2);
        let valueType: number;
        let data: number;
        if (entryFlags & 0x0008) {
          // compact entry: key(2) flags(2) data(4), dataType in high byte of flags
          valueType = entryFlags >> 8;
          data = buf.readUInt32LE(e + 4);
        } else {
          if (entryFlags & 0x0001) continue; // complex (bag) entry
          const entrySize = buf.readUInt16LE(e);
          valueType = buf.readUInt8(e + entrySize + 3);
          data = buf.readUInt32LE(e + entrySize + 4);
        }

        const id = ((pkgId & 0xff) << 24) | (typeId << 16) | entryIdx;
        const resId = id >>> 0;
        if (valueType === TYPE_STRING) {
          if (isDefault || !table.has(resId)) table.set(resId, strings[data]);
        } else if (valueType === TYPE_REFERENCE) {
          references.set(resId, data);
        }
      }
    }
    p += size;
  }
}
