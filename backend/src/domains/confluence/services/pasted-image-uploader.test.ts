import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { MAX_EFFECT_BYTES } from '../../../core/services/page-write-admission.js';
import {
  confluencePagePutDigest,
} from './page-put-intent-reconciler.js';
import { describeCollabCommit } from './collab-commit-intent-reconciler.js';
import {
  planLocalImagesForConfluence,
  preparePastedImagePlan,
  uploadLocalImagesToConfluence,
  uploadPreparedPastedImage,
} from './pasted-image-uploader.js';

const originalAttachmentsDir = process.env.ATTACHMENTS_DIR;
let tmpRoot: string;

// A tiny but valid 1x1 transparent PNG.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function makeLog() {
  // Stubbing the logger — not the subject under test.
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function attachmentAck(filename: string) {
  return {
    id: `attachment-${filename}`,
    title: filename,
    mediaType: filename.endsWith('.jpg') ? 'image/jpeg' : 'image/png',
    version: { number: 1, when: '2026-09-20T00:00:00Z' },
  };
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
});

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
  if (originalAttachmentsDir === undefined) delete process.env.ATTACHMENTS_DIR;
  else process.env.ATTACHMENTS_DIR = originalAttachmentsDir;
});

describe('uploadLocalImagesToConfluence', () => {
  it('returns the html unchanged when there are no local pasted images', async () => {
    const updateAttachment = vi.fn();
    const client = { updateAttachment } as never as Parameters<typeof uploadLocalImagesToConfluence>[2];
    const html = '<p>hello <img src="https://cdn.example.com/remote.png"></p>';

    const result = await uploadLocalImagesToConfluence(
      html,
      '9999',
      client,
      makeLog() as never,
    );

    expect(result).toBe(html);
    expect(updateAttachment).not.toHaveBeenCalled();
  });

  it('uploads a pasted image to Confluence and annotates the tag', async () => {
    await seedAttachment('local-1', 'pasted.png');
    const updateAttachment = vi.fn().mockResolvedValue(attachmentAck('pasted.png'));
    const client = { updateAttachment } as never as Parameters<typeof uploadLocalImagesToConfluence>[2];
    const html = '<p><img src="/api/attachments/local-1/pasted.png"></p>';

    const result = await uploadLocalImagesToConfluence(html, '9999', client, makeLog() as never);

    // Uploads under the *target* Confluence page id (arg 2), reading the file
    // from the *source* page id parsed out of the src attribute.
    expect(updateAttachment).toHaveBeenCalledWith('9999', 'pasted.png', PNG_BYTES, 'image/png');
    expect(result).toContain('data-confluence-filename="pasted.png"');
    expect(result).toContain('data-confluence-image-source="attachment"');
  });

  it('derives the mime type from the file extension', async () => {
    await seedAttachment('local-1', 'photo.jpg');
    const updateAttachment = vi.fn().mockResolvedValue(attachmentAck('photo.jpg'));
    const client = { updateAttachment } as never as Parameters<typeof uploadLocalImagesToConfluence>[2];
    const html = '<p><img src="/api/attachments/local-1/photo.jpg"></p>';

    await uploadLocalImagesToConfluence(html, '9999', client, makeLog() as never);

    expect(updateAttachment).toHaveBeenCalledWith('9999', 'photo.jpg', expect.any(Buffer), 'image/jpeg');
  });

  it('skips images already marked with a confluence filename', async () => {
    const updateAttachment = vi.fn();
    const client = { updateAttachment } as never as Parameters<typeof uploadLocalImagesToConfluence>[2];
    const html =
      '<p><img src="/api/attachments/local-1/synced.png" data-confluence-filename="synced.png"></p>';

    const result = await uploadLocalImagesToConfluence(html, '9999', client, makeLog() as never);

    expect(updateAttachment).not.toHaveBeenCalled();
    expect(result).toBe(html);
  });

  it('refuses a missing planned file instead of publishing a broken reference', async () => {
    const updateAttachment = vi.fn();
    const client = { updateAttachment } as never as Parameters<typeof uploadLocalImagesToConfluence>[2];
    const html = '<p><img src="/api/attachments/local-1/missing.png"></p>';

    await expect(
      uploadLocalImagesToConfluence(html, '9999', client, makeLog() as never),
    ).rejects.toMatchObject({
      statusCode: 409,
      reason: 'pasted_image_unavailable',
    });
    expect(updateAttachment).not.toHaveBeenCalled();
  });

  it('refuses attachment paths that escape the configured attachment root', async () => {
    const updateAttachment = vi.fn();
    const client = { updateAttachment } as never as Parameters<typeof uploadLocalImagesToConfluence>[2];

    await expect(uploadLocalImagesToConfluence(
      '<p><img src="/api/attachments/local-1/%2e%2e"></p>',
      '9999',
      client,
      makeLog() as never,
    )).rejects.toMatchObject({
      statusCode: 409,
      reason: 'pasted_image_unavailable',
    });
    expect(updateAttachment).not.toHaveBeenCalled();
  });

  it('refuses changed bytes when materializing a durable plan', async () => {
    await seedAttachment('local-1', 'changed.png', Buffer.from('first bytes'));
    const plan = await planLocalImagesForConfluence(
      '<p><img src="/api/attachments/local-1/changed.png"></p>',
    );
    expect(plan.bodyHtml).toContain('data-confluence-filename="changed.png"');
    expect(plan.images).toHaveLength(1);

    await seedAttachment('local-1', 'changed.png', Buffer.from('different bytes'));

    await expect(preparePastedImagePlan(plan)).rejects.toMatchObject({
      statusCode: 409,
      reason: 'pasted_image_unavailable',
    });
  });

  it('returns only bounded acknowledgment evidence from an unversioned 2xx attachment reply', async () => {
    await seedAttachment('local-1', 'compact.png');
    const plan = await planLocalImagesForConfluence(
      '<p><img src="/api/attachments/local-1/compact.png"></p>',
    );
    const [prepared] = await preparePastedImagePlan(plan);
    const updateAttachment = vi.fn().mockResolvedValue({
      id: 'provider-id-'.repeat(10_000),
      title: 'compact.png',
      mediaType: 'image/png',
    });
    const client = { updateAttachment } as never as Parameters<typeof uploadPreparedPastedImage>[2];

    await expect(uploadPreparedPastedImage(
      prepared!,
      '9999',
      client,
      makeLog() as never,
    )).resolves.toEqual({ accepted: true, filename: 'compact.png' });
  });

  it('refuses a bounded effect whose maximal terminal evidence cannot fit before upload', async () => {
    const confluenceId = '9'.repeat(20_000);
    const images = Array.from({ length: 48 }, (_, index) => ({
      filename: `image-${index}.png`,
      mimeType: 'image/png',
      size: PNG_BYTES.length,
      contentSha256: 'a'.repeat(64),
    }));
    const input = {
      actorId: '00000000-0000-4000-8000-000000000001',
      pageId: 1,
      confluenceId,
      title: 'Boundary commit',
      bodyStorage: '<p>bounded effect</p>',
      expectedRemoteVersion: 1,
      expectedLifecycleRevision: '1',
      images,
    };
    const intendedStateDigest = confluencePagePutDigest(input);
    const effect = {
      effectClass: 'remote',
      pageId: input.pageId,
      confluenceId,
      expectedRemoteVersion: '1',
      intendedStateDigest,
      images,
    };
    expect(Buffer.byteLength(JSON.stringify(effect), 'utf8')).toBeLessThanOrEqual(MAX_EFFECT_BYTES);

    const updateAttachment = vi.fn();
    const attempt = async () => {
      describeCollabCommit(input);
      const client = { updateAttachment } as never as Parameters<typeof uploadPreparedPastedImage>[2];
      for (const image of images) {
        await uploadPreparedPastedImage(
          { ...image, filePath: image.filename, bytes: PNG_BYTES },
          confluenceId,
          client,
          makeLog() as never,
        );
      }
    };

    await expect(attempt()).rejects.toMatchObject({
      statusCode: 400,
      reason: 'invalid_remote_terminal_result',
    });
    expect(updateAttachment).not.toHaveBeenCalled();
  });

  it('refuses duplicate durable-plan filenames before upload', async () => {
    const image = {
      filename: 'duplicate.png',
      mimeType: 'image/png',
      size: PNG_BYTES.length,
      contentSha256: 'a'.repeat(64),
    };
    const updateAttachment = vi.fn();
    const attempt = async () => {
      describeCollabCommit({
        actorId: '00000000-0000-4000-8000-000000000001',
        pageId: 1,
        confluenceId: '9999',
        title: 'Duplicate plan',
        bodyStorage: '<p>duplicate plan</p>',
        expectedRemoteVersion: 1,
        expectedLifecycleRevision: '1',
        images: [image, { ...image }],
      });
      const client = { updateAttachment } as never as Parameters<typeof uploadPreparedPastedImage>[2];
      await uploadPreparedPastedImage(
        { ...image, filePath: image.filename, bytes: PNG_BYTES },
        '9999',
        client,
        makeLog() as never,
      );
    };

    await expect(attempt()).rejects.toMatchObject({
      statusCode: 400,
      reason: 'invalid_collab_image_plan',
    });
    expect(updateAttachment).not.toHaveBeenCalled();
  });

  it('retains an unknown attachment outcome instead of continuing to page publication', async () => {
    await seedAttachment('local-1', 'boom.png');
    const updateAttachment = vi.fn().mockRejectedValue(new Error('confluence exploded'));
    const client = { updateAttachment } as never as Parameters<typeof uploadLocalImagesToConfluence>[2];
    const log = makeLog();
    const html = '<p><img src="/api/attachments/local-1/boom.png"></p>';

    await expect(
      uploadLocalImagesToConfluence(html, '9999', client, log as never),
    ).rejects.toThrow('confluence exploded');

    expect(log.error).toHaveBeenCalled();
  });
});
