import fs from 'node:fs/promises';
import { createInflate } from 'node:zlib';
import { finished } from 'node:stream/promises';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crcUpdate(crc: number, data: Buffer): number {
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return crc >>> 0;
}

/** Validate PNG framing, checksums and raster stream without expanding it in memory. */
export async function isValidPngFile(path: string): Promise<boolean> {
  const file = await fs.open(path, 'r');
  const inflater = createInflate();
  let valid = true;
  let expected = 0;
  let decoded = 0;
  const rows: Array<{ count: number; bytes: number }> = [];
  let rowGroup = 0;
  let rowRemaining = 0;
  let rowBytesLeft = 0;
  inflater.on('data', (chunk: Buffer) => {
    decoded += chunk.length;
    if (decoded > expected) valid = false;
    let offset = 0;
    while (offset < chunk.length && valid) {
      if (rowBytesLeft === 0) {
        while (rowGroup < rows.length && rowRemaining === 0) {
          rowRemaining = rows[rowGroup]!.count;
          if (!rowRemaining) rowGroup++;
        }
        if (rowGroup >= rows.length || chunk[offset]! > 4) { valid = false; break; }
        offset++;
        rowBytesLeft = rows[rowGroup]!.bytes;
        rowRemaining--;
        if (rowRemaining === 0) rowGroup++;
      }
      const take = Math.min(rowBytesLeft, chunk.length - offset);
      rowBytesLeft -= take;
      offset += take;
    }
    if (!valid) inflater.destroy(new Error('Invalid PNG raster'));
  });
  const complete = finished(inflater).then(() => true, () => false);
  try {
    const stat = await file.stat();
    const head = Buffer.alloc(8);
    if ((await file.read(head, 0, 8, 0)).bytesRead !== 8 || !head.equals(SIGNATURE)) return false;
    let offset = 8;
    let ihdr = false;
    let idat = false;
    let idatEnded = false;
    let palette = false;
    let indexed = false;
    let iend = false;
    const header = Buffer.alloc(8);
    const block = Buffer.alloc(65536);
    const crcBytes = Buffer.alloc(4);
    while (offset + 12 <= stat.size) {
      if ((await file.read(header, 0, 8, offset)).bytesRead !== 8) return false;
      const length = header.readUInt32BE(0);
      const type = header.toString('ascii', 4, 8);
      if (length > stat.size - offset - 12 || (!ihdr && type !== 'IHDR')) return false;
      if (type === 'IHDR' && (ihdr || length !== 13)) return false;
      if (!/^[A-Za-z]{4}$/.test(type) || (type[0] === type[0]!.toUpperCase() && !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type))) return false;
      if (type === 'PLTE') {
        if (palette || idat || length === 0 || length > 768 || length % 3 !== 0) return false;
        palette = true;
      }
      if (type === 'IDAT' && indexed && !palette) return false;
      if (type === 'IDAT' && idatEnded) return false;
      if (idat && type !== 'IDAT') idatEnded = true;
      if (type === 'IEND' && (length !== 0 || !idat || offset + 12 !== stat.size)) return false;
      let crc = crcUpdate(0xffffffff, header.subarray(4));
      let pos = offset + 8;
      let remaining = length;
      while (remaining > 0) {
        const amount = Math.min(remaining, block.length);
        if ((await file.read(block, 0, amount, pos)).bytesRead !== amount) return false;
        const part = block.subarray(0, amount);
        crc = crcUpdate(crc, part);
        if (type === 'IHDR') {
          const width = part.readUInt32BE(0), height = part.readUInt32BE(4);
          const depth = part[8]!, color = part[9]!, interlace = part[12]!;
          indexed = color === 3;
          const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
          const legal: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
          if (!width || !height || !legal[color]?.includes(depth) || part[10] !== 0 || part[11] !== 0 || interlace > 1) return false;
          const bpp = channels[color]! * depth;
          const passes = interlace ? [[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]] : [[0,0,1,1]];
          for (const [x, y, dx, dy] of passes) {
            const columns = Math.max(0, Math.ceil((width - x!) / dx!));
            const count = columns ? Math.max(0, Math.ceil((height - y!) / dy!)) : 0;
            const bytes = Math.ceil(columns * bpp / 8);
            rows.push({ count, bytes });
            expected += count * (bytes + 1);
          }
          if (!Number.isSafeInteger(expected)) return false;
          ihdr = true;
        } else if (type === 'IDAT') {
          idat = true;
          // The backend targets an ES library older than Promise.withResolvers.
          const written = new Promise<boolean>((resolve, reject) => {
            inflater.write(part, (error) => error ? reject(error) : resolve(true));
          });
          if (!await Promise.race([written, complete.then(() => false)])) return false;
        }
        pos += amount;
        remaining -= amount;
      }
      if ((await file.read(crcBytes, 0, 4, pos)).bytesRead !== 4 || ((crc ^ 0xffffffff) >>> 0) !== crcBytes.readUInt32BE(0)) return false;
      offset = pos + 4;
      if (type === 'IEND') { iend = true; break; }
    }
    if (!ihdr || !idat || !iend) return false;
    inflater.end();
    return await complete && valid && decoded === expected && rowBytesLeft === 0;
  } catch {
    return false;
  } finally {
    inflater.destroy();
    await file.close();
  }
}
