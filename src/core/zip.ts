/**
 * A minimal ZIP writer (stored entries, no compression), enough to hand several exported
 * files to the user as one download. Follows the PKWARE APPNOTE layout: local file
 * headers, the central directory, and the end-of-central-directory record. File names are
 * written as UTF-8 (general purpose bit 11).
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/** DOS date and time fields of a ZIP header. */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export function zipStore(entries: ZipEntry[], modified = new Date()): Uint8Array {
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime(modified);
  const names = entries.map((e) => encoder.encode(e.name));
  const localSize = entries.reduce((s, e, i) => s + 30 + names[i]!.length + e.data.length, 0);
  const centralSize = entries.reduce((s, _, i) => s + 46 + names[i]!.length, 0);
  if (entries.length > 0xffff || localSize + centralSize > 0xffffffff) throw new Error("Too much data for a simple ZIP archive.");
  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  const offsets: number[] = [];
  const crcs: number[] = [];
  let pos = 0;
  entries.forEach((e, i) => {
    const name = names[i]!;
    const crc = crc32(e.data);
    offsets.push(pos);
    crcs.push(crc);
    view.setUint32(pos, 0x04034b50, true); // local file header signature
    view.setUint16(pos + 4, 20, true); // version needed to extract
    view.setUint16(pos + 6, 0x0800, true); // flags: UTF-8 names
    view.setUint16(pos + 8, 0, true); // method: stored
    view.setUint16(pos + 10, time, true);
    view.setUint16(pos + 12, date, true);
    view.setUint32(pos + 14, crc, true);
    view.setUint32(pos + 18, e.data.length, true);
    view.setUint32(pos + 22, e.data.length, true);
    view.setUint16(pos + 26, name.length, true);
    view.setUint16(pos + 28, 0, true);
    out.set(name, pos + 30);
    out.set(e.data, pos + 30 + name.length);
    pos += 30 + name.length + e.data.length;
  });
  const centralStart = pos;
  entries.forEach((e, i) => {
    const name = names[i]!;
    view.setUint32(pos, 0x02014b50, true); // central directory header signature
    view.setUint16(pos + 4, 20, true); // version made by
    view.setUint16(pos + 6, 20, true); // version needed
    view.setUint16(pos + 8, 0x0800, true);
    view.setUint16(pos + 10, 0, true);
    view.setUint16(pos + 12, time, true);
    view.setUint16(pos + 14, date, true);
    view.setUint32(pos + 16, crcs[i]!, true);
    view.setUint32(pos + 20, e.data.length, true);
    view.setUint32(pos + 24, e.data.length, true);
    view.setUint16(pos + 28, name.length, true);
    view.setUint16(pos + 30, 0, true); // extra field length
    view.setUint16(pos + 32, 0, true); // comment length
    view.setUint16(pos + 34, 0, true); // disk number
    view.setUint16(pos + 36, 0, true); // internal attributes
    view.setUint32(pos + 38, 0, true); // external attributes
    view.setUint32(pos + 42, offsets[i]!, true);
    out.set(name, pos + 46);
    pos += 46 + name.length;
  });
  view.setUint32(pos, 0x06054b50, true); // end of central directory
  view.setUint16(pos + 4, 0, true);
  view.setUint16(pos + 6, 0, true);
  view.setUint16(pos + 8, entries.length, true);
  view.setUint16(pos + 10, entries.length, true);
  view.setUint32(pos + 12, pos - centralStart, true);
  view.setUint32(pos + 16, centralStart, true);
  view.setUint16(pos + 20, 0, true);
  return out;
}
