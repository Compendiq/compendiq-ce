import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

// The module resolves its attachment root from process.env.ATTACHMENTS_DIR at
// load time, so we point it at a throwaway temp dir BEFORE importing the module
// under test (hence the dynamic import in beforeAll).
let tmpRoot: string;
let uploadLocalImagesToConfluence: typeof import('./pasted-image-uploader.js')['uploadLocalImagesToConfluence'];

// A tiny but valid 1x1 transparent PNG.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function makeLog() {
  // Stubbing the logger — not the subject under test.
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
}

// Write a file into the local attachment cache the way the editor would, i.e.
// at {ATTACHMENTS_DIR}/{pageId}/{filename}.
async function seedAttachment(pageId: string, filename: string, bytes: Buffer = PNG_BYTES) {
  // Test-only paths built from hardcoded literals under a mkdtemp root — no user input.
  // nosemgrep
  const dir = path.join(tmpRoot, pageId);
  await mkdir(dir, { recursive: true });
  // nosemgrep
  await writeFile(path.join(dir, filename), bytes);
}

beforeAll(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'pasted-img-'));
  process.env.ATTACHMENTS_DIR = tmpRoot;
  ({ uploadLocalImagesToConfluence } = await import('./pasted-image-uploader.js'));
});

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('uploadLocalImagesToConfluence', () => {
  it('returns the html unchanged when there are no local pasted images', async () => {
    const client = { updateAttachment: vi.fn() } as never as Parameters<typeof uploadLocalImagesToConfluence>[2];
    const html = '<p>hello <img src="https://cdn.example.com/remote.png"></p>';

    const result = await uploadLocalImagesToConfluence(html, '9999', client, makeLog());

    expect(result).toBe(html);
    expect((client as { updateAttachment: ReturnType<typeof vi.fn> }).updateAttachment).not.toHaveBeenCalled();
  });

  it('uploads a pasted image to Confluence and annotates the tag', async () => {
    await seedAttachment('local-1', 'pasted.png');
    const updateAttachment = vi.fn().mockResolvedValue(undefined);
    const client = { updateAttachment } as never as Parameters<typeof uploadLocalImagesToConfluence>[2];
    const html = '<p><img src="/api/attachments/local-1/pasted.png"></p>';

    const result = await uploadLocalImagesToConfluence(html, '9999', client, makeLog());

    // Uploads under the *target* Confluence page id (arg 2), reading the file
    // from the *source* page id parsed out of the src attribute.
    expect(updateAttachment).toHaveBeenCalledWith('9999', 'pasted.png', PNG_BYTES, 'image/png');
    expect(result).toContain('data-confluence-filename="pasted.png"');
    expect(result).toContain('data-confluence-image-source="attachment"');
  });

  it('derives the mime type from the file extension', async () => {
    await seedAttachment('local-1', 'photo.jpg');
    const updateAttachment = vi.fn().mockResolvedValue(undefined);
    const client = { updateAttachment } as never as Parameters<typeof uploadLocalImagesToConfluence>[2];
    const html = '<p><img src="/api/attachments/local-1/photo.jpg"></p>';

    await uploadLocalImagesToConfluence(html, '9999', client, makeLog());

    expect(updateAttachment).toHaveBeenCalledWith('9999', 'photo.jpg', expect.any(Buffer), 'image/jpeg');
  });

  it('skips images already marked with a confluence filename', async () => {
    const updateAttachment = vi.fn();
    const client = { updateAttachment } as never as Parameters<typeof uploadLocalImagesToConfluence>[2];
    const html =
      '<p><img src="/api/attachments/local-1/synced.png" data-confluence-filename="synced.png"></p>';

    const result = await uploadLocalImagesToConfluence(html, '9999', client, makeLog());

    expect(updateAttachment).not.toHaveBeenCalled();
    expect(result).toBe(html);
  });

  it('skips and warns when the local file is missing', async () => {
    const updateAttachment = vi.fn();
    const client = { updateAttachment } as never as Parameters<typeof uploadLocalImagesToConfluence>[2];
    const log = makeLog();
    const html = '<p><img src="/api/attachments/local-1/missing.png"></p>';

    const result = await uploadLocalImagesToConfluence(html, '9999', client, log);

    expect(updateAttachment).not.toHaveBeenCalled();
    expect((log as unknown as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalled();
    expect(result).toBe(html);
  });

  it('logs and continues (no annotation) when the Confluence upload fails', async () => {
    await seedAttachment('local-1', 'boom.png');
    const updateAttachment = vi.fn().mockRejectedValue(new Error('confluence exploded'));
    const client = { updateAttachment } as never as Parameters<typeof uploadLocalImagesToConfluence>[2];
    const log = makeLog();
    const html = '<p><img src="/api/attachments/local-1/boom.png"></p>';

    const result = await uploadLocalImagesToConfluence(html, '9999', client, log);

    expect((log as unknown as { error: ReturnType<typeof vi.fn> }).error).toHaveBeenCalled();
    expect(result).not.toContain('data-confluence-filename');
  });
});
