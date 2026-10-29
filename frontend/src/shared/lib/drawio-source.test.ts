import { Blob as NativeBlob } from 'node:buffer';
import { crc32, deflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDrawioSource } from './drawio-source';
import { drawioPngBytes } from './drawio-source.test-fixtures';

const graph = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';

function pngWithMetadata(type: 'tEXt' | 'zTXt', payload: Buffer): Uint8Array<ArrayBuffer> {
  const original = Buffer.from(drawioPngBytes());
  const chunks: Buffer[] = [original.subarray(0, 8)];
  for (let offset = 8; offset < original.length;) {
    const size = original.readUInt32BE(offset) + 12;
    if (original.toString('ascii', offset + 4, offset + 8) === 'tEXt') {
      const chunk = Buffer.alloc(payload.length + 12);
      chunk.writeUInt32BE(payload.length);
      chunk.write(type, 4);
      payload.copy(chunk, 8);
      chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
      chunks.push(chunk);
    } else chunks.push(original.subarray(offset, offset + size));
    offset += size;
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function respondWithPng(bytes: Uint8Array<ArrayBuffer>) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true, blob: async () => new NativeBlob([bytes], { type: 'image/png' }),
  }));
  return loadDrawioSource({ previewUrl: '/api/attachments/1/flow.png' });
}

beforeEach(() => {
  vi.stubGlobal('Blob', NativeBlob);
  // jsdom has no raster decoder. Byte/metadata parsing is real; browser smoke
  // additionally exercises createImageBitmap against this packaged export.
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ close: vi.fn() }));
});
afterEach(() => vi.unstubAllGlobals());

describe('existing draw.io payload admission', () => {
  it('extracts the complete XML from an actual packaged draw.io PNG', async () => {
    const xml = await respondWithPng(drawioPngBytes());
    expect(xml).toContain('<mxfile');
    expect(xml).toContain('Standalone recovered preview');
    expect(createImageBitmap).toHaveBeenCalledOnce();
  });

  it.each([graph, '<mxGraphModel/>', `<mxfile><diagram id="empty">${graph}</diagram></mxfile>`])('accepts intentionally empty valid diagrams: %s', async (xml) => {
    expect(await loadDrawioSource({ xml })).toBe(xml);
  });

  it('preserves the complete multi-page file, including compressed and empty pages', async () => {
    const compressed = deflateRawSync(encodeURIComponent(graph)).toString('base64');
    const xml = `<mxfile><diagram id="one">${compressed}</diagram><diagram id="two"><mxGraphModel/></diagram></mxfile>`;
    expect(await loadDrawioSource({ xml })).toBe(xml);
  });

  it.each([1, 2])('accepts %s-level URI-encoded mxfile text chunks', async (levels) => {
    const xml = `<mxfile><diagram id="one">${graph}</diagram><diagram id="two"><mxGraphModel/></diagram></mxfile>`;
    let encoded = xml;
    for (let i = 0; i < levels; i++) encoded = encodeURIComponent(encoded);
    expect(await respondWithPng(pngWithMetadata('tEXt', Buffer.from(`mxfile\0${encoded}`)))).toBe(xml);
  });

  it('accepts the packaged legacy zTXt raw-deflate and Java URL-space encoding', async () => {
    const encoded = encodeURIComponent(graph).replace(/%20/g, '+');
    const payload = Buffer.concat([Buffer.from('mxGraphModel\0\0'), deflateRawSync(encoded)]);
    expect(await respondWithPng(pngWithMetadata('zTXt', payload))).toBe(graph);
  });

  it.each(['<html>login</html>', 'random bytes', '<mxfile/>', '<mxfile><diagram>garbage</diagram></mxfile>', '<mxGraphModel>', '<mxfile><diagram><html/></diagram></mxfile>', '<mxGraphModel><html/></mxGraphModel>', '<mxGraphModel><root><html/></root></mxGraphModel>'])(
    'refuses malformed/non-diagram XML: %s', async (xml) => {
      await expect(loadDrawioSource({ xml })).rejects.toThrow('editable diagram source');
    },
  );

  it('refuses an otherwise valid PNG with no editable diagram metadata', async () => {
    await expect(respondWithPng(pngWithMetadata('tEXt', Buffer.from('Comment\0ordinary image')))).rejects.toThrow('editable diagram source');
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it('refuses non-diagram XML inside a PNG', async () => {
    await expect(respondWithPng(pngWithMetadata('tEXt', Buffer.from('mxfile\0<html>login</html>')))).rejects.toThrow('editable diagram source');
  });

  it('refuses a PNG that the native raster decoder rejects', async () => {
    vi.mocked(createImageBitmap).mockRejectedValueOnce(new Error('Broken PNG'));
    await expect(respondWithPng(drawioPngBytes())).rejects.toThrow('editable diagram source');
  });

  it('bounds decompression of untrusted diagram pages', async () => {
    const oversized = deflateRawSync(Buffer.alloc(25 * 1024 * 1024 + 1, 65)).toString('base64');
    await expect(loadDrawioSource({ xml: `<mxfile><diagram>${oversized}</diagram></mxfile>` })).rejects.toThrow('editable diagram source');
  });

  it('falls back from a successful HTML source response to a genuine editable PNG', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, text: async () => '<html>login</html>' })
      .mockResolvedValueOnce({ ok: true, blob: async () => new NativeBlob([drawioPngBytes()], { type: 'image/png' }) }));
    const xml = await loadDrawioSource({ sourceUrl: '/api/attachments/1/flow.drawio', previewUrl: '/api/attachments/1/flow.png' });
    expect(xml).toContain('Standalone recovered preview');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
