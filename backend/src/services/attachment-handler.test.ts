import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs/promises';
import { syncImageAttachments, syncDrawioAttachments } from './attachment-handler.js';
import type { ConfluenceClient } from './confluence-client.js';

// Mock fs to avoid real filesystem operations
vi.mock('fs/promises', () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(Buffer.from('test')),
    access: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
  },
}));

function createMockClient(attachments: Array<{ title: string; download: string }>): ConfluenceClient {
  return {
    getPageAttachments: vi.fn().mockResolvedValue({
      results: attachments.map((a) => ({
        id: `att-${a.title}`,
        title: a.title,
        mediaType: 'image/png',
        _links: { download: a.download },
      })),
    }),
    downloadAttachment: vi.fn().mockResolvedValue(Buffer.from('fake-image-data')),
  } as unknown as ConfluenceClient;
}

describe('attachment-handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('syncImageAttachments', () => {
    it('downloads image attachments referenced in XHTML body', async () => {
      const bodyStorage = `<h2>Screenshots</h2>
<ac:image ac:width="600"><ri:attachment ri:filename="dashboard.png" /></ac:image>
<p>Some text</p>
<ac:image><ri:attachment ri:filename="photo.jpg" /></ac:image>`;

      const client = createMockClient([
        { title: 'dashboard.png', download: '/download/dashboard.png' },
        { title: 'photo.jpg', download: '/download/photo.jpg' },
      ]);

      const result = await syncImageAttachments(client, 'user-1', 'page-1', bodyStorage);

      expect(result).toEqual(['dashboard.png', 'photo.jpg']);
      expect(client.getPageAttachments).toHaveBeenCalledWith('page-1');
      expect(client.downloadAttachment).toHaveBeenCalledTimes(2);
      expect(fs.mkdir).toHaveBeenCalled();
      expect(fs.writeFile).toHaveBeenCalledTimes(2);
    });

    it('skips non-image file extensions', async () => {
      const bodyStorage = `<ac:image><ri:attachment ri:filename="document.pdf" /></ac:image>
<ac:image><ri:attachment ri:filename="logo.png" /></ac:image>`;

      const client = createMockClient([
        { title: 'document.pdf', download: '/download/document.pdf' },
        { title: 'logo.png', download: '/download/logo.png' },
      ]);

      const result = await syncImageAttachments(client, 'user-1', 'page-1', bodyStorage);

      expect(result).toEqual(['logo.png']);
      expect(client.downloadAttachment).toHaveBeenCalledTimes(1);
    });

    it('returns empty array when no images in body', async () => {
      const bodyStorage = '<p>No images here</p>';
      const client = createMockClient([]);

      const result = await syncImageAttachments(client, 'user-1', 'page-1', bodyStorage);

      expect(result).toEqual([]);
      expect(client.getPageAttachments).not.toHaveBeenCalled();
    });

    it('skips images not found in Confluence attachments', async () => {
      const bodyStorage = `<ac:image><ri:attachment ri:filename="missing.png" /></ac:image>`;
      const client = createMockClient([]); // No attachments on this page

      const result = await syncImageAttachments(client, 'user-1', 'page-1', bodyStorage);

      expect(result).toEqual([]);
      expect(client.downloadAttachment).not.toHaveBeenCalled();
    });

    it('handles download errors gracefully', async () => {
      const bodyStorage = `<ac:image><ri:attachment ri:filename="broken.png" /></ac:image>`;
      const client = createMockClient([
        { title: 'broken.png', download: '/download/broken.png' },
      ]);
      (client.downloadAttachment as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));

      const result = await syncImageAttachments(client, 'user-1', 'page-1', bodyStorage);

      expect(result).toEqual([]);
    });

    it('handles all supported image extensions', async () => {
      const bodyStorage = `
<ac:image><ri:attachment ri:filename="a.png" /></ac:image>
<ac:image><ri:attachment ri:filename="b.jpg" /></ac:image>
<ac:image><ri:attachment ri:filename="c.jpeg" /></ac:image>
<ac:image><ri:attachment ri:filename="d.gif" /></ac:image>
<ac:image><ri:attachment ri:filename="e.svg" /></ac:image>
<ac:image><ri:attachment ri:filename="f.webp" /></ac:image>`;

      const client = createMockClient([
        { title: 'a.png', download: '/dl/a.png' },
        { title: 'b.jpg', download: '/dl/b.jpg' },
        { title: 'c.jpeg', download: '/dl/c.jpeg' },
        { title: 'd.gif', download: '/dl/d.gif' },
        { title: 'e.svg', download: '/dl/e.svg' },
        { title: 'f.webp', download: '/dl/f.webp' },
      ]);

      const result = await syncImageAttachments(client, 'user-1', 'page-1', bodyStorage);

      expect(result).toHaveLength(6);
    });

    it('ignores URL-based images (only syncs attachment-based)', async () => {
      const bodyStorage = `<ac:image><ri:url ri:value="https://example.com/img.png" /></ac:image>`;
      const client = createMockClient([]);

      const result = await syncImageAttachments(client, 'user-1', 'page-1', bodyStorage);

      expect(result).toEqual([]);
      expect(client.getPageAttachments).not.toHaveBeenCalled();
    });
  });

  describe('syncDrawioAttachments', () => {
    it('downloads draw.io diagram PNGs', async () => {
      const bodyStorage = `<ac:structured-macro ac:name="drawio"><ac:parameter ac:name="diagramName">topology</ac:parameter></ac:structured-macro>`;

      const client = createMockClient([
        { title: 'topology.png', download: '/download/topology.png' },
      ]);

      const result = await syncDrawioAttachments(client, 'user-1', 'page-1', bodyStorage);

      expect(result).toEqual(['topology.png']);
      expect(client.downloadAttachment).toHaveBeenCalledTimes(1);
    });

    it('returns empty array when no drawio macros', async () => {
      const bodyStorage = '<p>No diagrams</p>';
      const client = createMockClient([]);

      const result = await syncDrawioAttachments(client, 'user-1', 'page-1', bodyStorage);

      expect(result).toEqual([]);
    });
  });
});
