import { inflateRawSync } from "node:zlib";
import { SchemaError } from "../errors.ts";

export const MAX_INPUT_BYTES = 32 * 1024 * 1024;
export const MAX_ROWS = 20_000;
export const MAX_COLUMNS = 64;
const MAX_EXPANDED = 128 * 1024 * 1024;

export function checkInputBytes(bytes: Uint8Array | string): void {
  if ((typeof bytes === "string" ? Buffer.byteLength(bytes) : bytes.byteLength) > MAX_INPUT_BYTES)
    throw new SchemaError(`Report exceeds ${MAX_INPUT_BYTES} byte limit`);
}

/** Validate actual ZIP expansion with a bounded inflater before SheetJS opens XLSX. */
export function checkWorkbookExpansion(bytes: Uint8Array): void {
  checkInputBytes(bytes);
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (data.length < 4 || data.readUInt32LE(0) !== 0x04034b50) return; // BIFF/OLE XLS is not ZIP.
  try {
    let end = data.length - 22;
    const floor = Math.max(0, end - 65535);
    while (end >= floor && data.readUInt32LE(end) !== 0x06054b50) end--;
    if (end < floor || data.readUInt16LE(end + 4) !== 0 || data.readUInt16LE(end + 6) !== 0)
      throw new Error("ZIP directory");
    const count = data.readUInt16LE(end + 10);
    let cursor = data.readUInt32LE(end + 16);
    if (count > 1024 || cursor === 0xffffffff) throw new Error("ZIP limits");
    let expanded = 0;
    for (let i = 0; i < count; i++) {
      expanded += expandedEntry(data, cursor, end, MAX_EXPANDED - expanded);
      cursor +=
        46 +
        data.readUInt16LE(cursor + 28) +
        data.readUInt16LE(cursor + 30) +
        data.readUInt16LE(cursor + 32);
    }
  } catch (error) {
    throw new SchemaError("Workbook ZIP is unsupported, malformed, or exceeds expansion limits", {
      cause: error,
    });
  }
}

function expandedEntry(data: Buffer, cursor: number, end: number, remaining: number): number {
  if (cursor + 46 > end || data.readUInt32LE(cursor) !== 0x02014b50) throw new Error("ZIP entry");
  const flags = data.readUInt16LE(cursor + 8);
  const method = data.readUInt16LE(cursor + 10);
  const compressed = data.readUInt32LE(cursor + 20);
  const expected = data.readUInt32LE(cursor + 24);
  const local = data.readUInt32LE(cursor + 42);
  if (
    flags & 1 ||
    ![0, 8].includes(method) ||
    expected > remaining ||
    local + 30 > cursor ||
    data.readUInt32LE(local) !== 0x04034b50
  )
    throw new Error("ZIP limits");
  const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
  if (start + compressed > cursor || data.readUInt16LE(local + 8) !== method)
    throw new Error("ZIP entry bounds");
  const compressedBytes = data.subarray(start, start + compressed);
  const size =
    method === 0
      ? compressedBytes.length
      : inflateRawSync(compressedBytes, {
          maxOutputLength: Math.max(1, remaining),
        }).length;
  if (size !== expected) throw new Error("ZIP expansion mismatch");
  return size;
}
