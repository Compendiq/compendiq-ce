import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs/promises';
import { request } from 'undici';
import {
  syncImageAttachments,
  syncDrawioAttachments,
  fetchAndCacheAttachment,
  fetchAndCachePageImage,
  getMimeType,
  cacheAttachment,
  hasLocalAttachments,
  getExpectedAttachmentFilenames,
  getMissingAttachments,
  STREAM_THRESHOLD_BYTES,
  MAX_ATTACHMENT_BYTES,
} from './attachment-handler.js';
import type { ConfluenceClient, ConfluenceAttachment } from './confluence-client.js';
import { getLocalFilenameForImageSource } from './image-references.js';

vi.mock('undici', () => ({
  request: vi.fn(),
}));

vi.mock('../utils/ssrf-guard.js', () => ({
  validateUrl: vi.fn(),
}));

// Mock fs to avoid real filesystem operations.
// fs.access defaults to REJECT (ENOENT) so tests see a cold cache by default.
// Use (fs.access as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined)
// in individual tests that need to simulate an already-cached file.
vi.mock('fs/promises', () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(Buffer.from('test')),
    access: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
    rm: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
  },
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

function createMockClient(): ConfluenceClient {
  return {
    getPageAttachments: vi.fn(),
    findPageByTitle: vi.fn(),
    downloadAttachment: vi.fn().mockResolvedValue(Buffer.from('fake-image-data')),
    downloadAttachmentToFile: vi.fn().mockResolvedValue(undefined),
  } as unknown as ConfluenceClient;
}

function makeAttachments(items: Array<{ title: string; download: string; fileSize?: number }>): ConfluenceAttachment[] {
  return items.map((a) => ({
    id: `att-${a.title}`,
    title: a.title,
    mediaType: 'image/png',
    _links: { download: a.download },
    ...(a.fileSize !== undefined ? { extensions: { mediaType: 'image/png', fileSize: a.fileSize } } : {}),
  }));
}

const mockRequest = vi.mocked(request);

describe('attachment-handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: attachments are NOT cached (fs.access throws ENOENT).
    // Tests that need the "already cached" path override this per-test.
    vi.mocked(fs.access).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    // Restore other fs mocks to their working defaults after clearAllMocks
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(fs.readFile).mockResolvedValue(Buffer.from('test'));
    vi.mocked(fs.rm).mockResolvedValue(undefined);
    vi.mocked(fs.readdir as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    mockRequest.mockReset();
  });

  describe('getMimeType', () => {
    it('returns correct MIME type for SVG', () => {
      expect(getMimeType('diagram.svg')).toBe('image/svg+xml');
    });

    it('returns correct MIME type for PNG', () => {
      expect(getMimeType('image.png')).toBe('image/png');
    });

    it('returns correct MIME type for XML', () => {
      expect(getMimeType('diagram.xml')).toBe('application/xml');
    });

    it('returns octet-stream for unknown extensions', () => {
      expect(getMimeType('file.xyz')).toBe('application/octet-stream');
    });
  });

  describe('syncImageAttachments', () => {
    it('downloads image attachments referenced in XHTML body using pre-fetched attachments', async () => {
      const bodyStorage = `<h2>Screenshots</h2>
<ac:image ac:width="600"><ri:attachment ri:filename="dashboard.png" /></ac:image>
<p>Some text</p>
<ac:image><ri:attachment ri:filename="photo.jpg" /></ac:image>`;

      const client = createMockClient();
      const attachments = makeAttachments([
        { title: 'dashboard.png', download: '/download/dashboard.png' },
        { title: 'photo.jpg', download: '/download/photo.jpg' },
      ]);

      const result = await syncImageAttachments(client, 'user-1', 'page-1', bodyStorage, attachments);

      expect(result).toEqual(['dashboard.png', 'photo.jpg']);
      // Must NOT call getPageAttachments — uses pre-fetched data
      expect(client.getPageAttachments).not.toHaveBeenCalled();
      expect(client.downloadAttachment).toHaveBeenCalledTimes(2);
      expect(fs.mkdir).toHaveBeenCalled();
      expect(fs.writeFile).toHaveBeenCalledTimes(2);
    });

    it('skips non-image file extensions', async () => {
      const bodyStorage = `<ac:image><ri:attachment ri:filename="document.pdf" /></ac:image>
<ac:image><ri:attachment ri:filename="logo.png" /></ac:image>`;

      const client = createMockClient();
      const attachments = makeAttachments([
        { title: 'document.pdf', download: '/download/document.pdf' },
        { title: 'logo.png', download: '/download/logo.png' },
      ]);

      const result = await syncImageAttachments(client, 'user-1', 'page-1', bodyStorage, attachments);

      expect(result).toEqual(['logo.png']);
      expect(client.downloadAttachment).toHaveBeenCalledTimes(1);
    });

    it('returns empty array when no images in body', async () => {
      const bodyStorage = '<p>No images here</p>';
      const client = createMockClient();

      const result = await syncImageAttachments(client, 'user-1', 'page-1', bodyStorage, []);

      expect(result).toEqual([]);
      expect(client.getPageAttachments).not.toHaveBeenCalled();
    });

    it('skips images not found in pre-fetched attachments', async () => {
      const bodyStorage = `<ac:image><ri:attachment ri:filename="missing.png" /></ac:image>`;
      const client = createMockClient();

      const result = await syncImageAttachments(client, 'user-1', 'page-1', bodyStorage, []);

      expect(result).toEqual([]);
      expect(client.downloadAttachment).not.toHaveBeenCalled();
    });

    it('handles download errors gracefully', async () => {
      const bodyStorage = `<ac:image><ri:attachment ri:filename="broken.png" /></ac:image>`;
      const client = createMockClient();
      (client.downloadAttachment as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));

      const attachments = makeAttachments([
        { title: 'broken.png', download: '/download/broken.png' },
      ]);

      const result = await syncImageAttachments(client, 'user-1', 'page-1', bodyStorage, attachments);

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

      const client = createMockClient();
      const attachments = makeAttachments([
        { title: 'a.png', download: '/dl/a.png' },
        { title: 'b.jpg', download: '/dl/b.jpg' },
        { title: 'c.jpeg', download: '/dl/c.jpeg' },
        { title: 'd.gif', download: '/dl/d.gif' },
        { title: 'e.svg', download: '/dl/e.svg' },
        { title: 'f.webp', download: '/dl/f.webp' },
      ]);

      const result = await syncImageAttachments(client, 'user-1', 'page-1', bodyStorage, attachments);

      expect(result).toHaveLength(6);
    });

    it('downloads external URL images into local cache', async () => {
      const bodyStorage = `<ac:image><ri:url ri:value="https://example.com/img.png" /></ac:image>`;
      const client = createMockClient();
      mockRequest.mockResolvedValue({
        statusCode: 200,
        headers: { 'content-type': 'image/png' },
        body: (async function* () {
          yield Buffer.from('external-image');
        })(),
      } as never);

      const result = await syncImageAttachments(client, 'user-1', 'page-1', bodyStorage, []);

      expect(result).toEqual([
        getLocalFilenameForImageSource({ kind: 'external-url', url: 'https://example.com/img.png' }),
      ]);
      expect(client.getPageAttachments).not.toHaveBeenCalled();
      expect(fs.writeFile).toHaveBeenCalledOnce();
    });

    it('skips download when image is already cached (idempotent)', async () => {
      const bodyStorage = `<ac:image><ri:attachment ri:filename="logo.png" /></ac:image>`;
      const client = createMockClient();
      const attachments = makeAttachments([
        { title: 'logo.png', download: '/download/logo.png' },
      ]);

      // Simulate file already cached: fs.access resolves for this test
      (fs.access as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);

      const result = await syncImageAttachments(client, 'user-1', 'page-1', bodyStorage, attachments);

      expect(result).toEqual(['logo.png']);
      // No download should have occurred
      expect(client.downloadAttachment).not.toHaveBeenCalled();
      expect(fs.writeFile).not.toHaveBeenCalled();
    });

    it('downloads image when not yet cached', async () => {
      const bodyStorage = `<ac:image><ri:attachment ri:filename="new.png" /></ac:image>`;
      const client = createMockClient();
      const attachments = makeAttachments([
        { title: 'new.png', download: '/download/new.png' },
      ]);

      const result = await syncImageAttachments(client, 'user-1', 'page-1', bodyStorage, attachments);

      expect(result).toEqual(['new.png']);
      expect(client.downloadAttachment).toHaveBeenCalledOnce();
      expect(fs.writeFile).toHaveBeenCalledOnce();
    });

    it('downloads cross-page attachment images from the resolved owner page', async () => {
      const bodyStorage = `<ac:image><ri:attachment ri:filename="shared.png"><ri:page ri:content-title="Shared Assets" ri:space-key="OPS" /></ri:attachment></ac:image>`;
      const client = createMockClient();
      (client.findPageByTitle as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'page-shared' });
      (client.getPageAttachments as ReturnType<typeof vi.fn>).mockResolvedValue({
        results: makeAttachments([
          { title: 'shared.png', download: '/download/shared.png' },
        ]),
      });

      const result = await syncImageAttachments(client, 'user-1', 'page-1', bodyStorage, [], 'OPS');

      expect(result).toHaveLength(1);
      expect(result[0]).toMatch(/^shared\.xref-[a-f0-9]{12}\.png$/);
      expect(client.findPageByTitle).toHaveBeenCalledWith('OPS', 'Shared Assets');
      expect(client.getPageAttachments).toHaveBeenCalledWith('page-shared');
      expect(client.downloadAttachment).toHaveBeenCalledWith('/download/shared.png');
    });
  });

  describe('fetchAndCacheAttachment', () => {
    it('fetches attachment from Confluence, caches it, and returns the buffer', async () => {
      const imageData = Buffer.from('confluence-image-data');
      const client = createMockClient();
      (client.getPageAttachments as ReturnType<typeof vi.fn>).mockResolvedValue({
        results: makeAttachments([
          { title: 'logo.png', download: '/download/logo.png' },
        ]),
      });
      (client.downloadAttachment as ReturnType<typeof vi.fn>).mockResolvedValue(imageData);

      const result = await fetchAndCacheAttachment(client, 'user-1', 'page-1', 'logo.png');

      expect(result).toEqual(imageData);
      expect(client.getPageAttachments).toHaveBeenCalledWith('page-1');
      expect(client.downloadAttachment).toHaveBeenCalledWith('/download/logo.png');
      expect(fs.mkdir).toHaveBeenCalled();
      expect(fs.writeFile).toHaveBeenCalled();
    });

    it('returns null when attachment is not found in Confluence', async () => {
      const client = createMockClient();
      (client.getPageAttachments as ReturnType<typeof vi.fn>).mockResolvedValue({
        results: [],
      });

      const result = await fetchAndCacheAttachment(client, 'user-1', 'page-1', 'missing.png');

      expect(result).toBeNull();
      expect(client.downloadAttachment).not.toHaveBeenCalled();
    });

    it('returns null when attachment has no download link', async () => {
      const client = createMockClient();
      (client.getPageAttachments as ReturnType<typeof vi.fn>).mockResolvedValue({
        results: [{
          id: 'att-1',
          title: 'nolink.png',
          mediaType: 'image/png',
          // No _links.download
        }],
      });

      const result = await fetchAndCacheAttachment(client, 'user-1', 'page-1', 'nolink.png');

      expect(result).toBeNull();
      expect(client.downloadAttachment).not.toHaveBeenCalled();
    });

    it('sanitizes filename to prevent path traversal', async () => {
      const imageData = Buffer.from('safe-data');
      const client = createMockClient();
      (client.getPageAttachments as ReturnType<typeof vi.fn>).mockResolvedValue({
        results: makeAttachments([
          { title: 'safe.png', download: '/download/safe.png' },
        ]),
      });
      (client.downloadAttachment as ReturnType<typeof vi.fn>).mockResolvedValue(imageData);

      // path.basename('../../etc/passwd') returns 'passwd', which won't match 'safe.png'
      const result = await fetchAndCacheAttachment(client, 'user-1', 'page-1', '../../etc/passwd');

      expect(result).toBeNull();
    });

    it('propagates errors from Confluence API', async () => {
      const client = createMockClient();
      (client.getPageAttachments as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Confluence unreachable'),
      );

      await expect(
        fetchAndCacheAttachment(client, 'user-1', 'page-1', 'logo.png'),
      ).rejects.toThrow('Confluence unreachable');
    });
  });

  describe('fetchAndCachePageImage', () => {
    it('fetches a mirrored external image using its local filename', async () => {
      const client = createMockClient();
      mockRequest.mockResolvedValue({
        statusCode: 200,
        headers: { 'content-type': 'image/png' },
        body: (async function* () {
          yield Buffer.from('external-image');
        })(),
      } as never);
      (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(Buffer.from('external-image'));

      const result = await fetchAndCachePageImage(
        client,
        'user-1',
        'page-1',
        getLocalFilenameForImageSource({ kind: 'external-url', url: 'https://example.com/img.png' }),
        '<ac:image><ri:url ri:value="https://example.com/img.png" /></ac:image>',
      );

      expect(result).toEqual(Buffer.from('external-image'));
      expect(mockRequest).toHaveBeenCalled();
    });

    it('fetches a mirrored cross-page image using its local filename', async () => {
      const client = createMockClient();
      (client.findPageByTitle as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'shared-page' });
      (client.getPageAttachments as ReturnType<typeof vi.fn>).mockResolvedValue({
        results: makeAttachments([
          { title: 'shared.png', download: '/download/shared.png' },
        ]),
      });
      (client.downloadAttachment as ReturnType<typeof vi.fn>).mockResolvedValue(Buffer.from('shared-image'));

      const result = await fetchAndCachePageImage(
        client,
        'user-1',
        'page-1',
        getLocalFilenameForImageSource({
          kind: 'attachment',
          attachmentFilename: 'shared.png',
          sourcePageTitle: 'Shared Assets',
          sourceSpaceKey: 'OPS',
        }),
        '<ac:image><ri:attachment ri:filename="shared.png"><ri:page ri:content-title="Shared Assets" ri:space-key="OPS" /></ri:attachment></ac:image>',
        'OPS',
      );

      expect(result).toEqual(Buffer.from('test'));
      expect(client.findPageByTitle).toHaveBeenCalledWith('OPS', 'Shared Assets');
      expect(client.downloadAttachment).toHaveBeenCalledWith('/download/shared.png');
    });
  });

  describe('syncDrawioAttachments', () => {
    it('downloads draw.io diagram PNGs using pre-fetched attachments', async () => {
      const bodyStorage = `<ac:structured-macro ac:name="drawio"><ac:parameter ac:name="diagramName">topology</ac:parameter></ac:structured-macro>`;

      const client = createMockClient();
      const attachments = makeAttachments([
        { title: 'topology.png', download: '/download/topology.png' },
      ]);

      const result = await syncDrawioAttachments(client, 'user-1', 'page-1', bodyStorage, attachments);

      expect(result).toEqual(['topology.png']);
      // Must NOT call getPageAttachments — uses pre-fetched data
      expect(client.getPageAttachments).not.toHaveBeenCalled();
      expect(client.downloadAttachment).toHaveBeenCalledTimes(1);
    });

    it('returns empty array when no drawio macros', async () => {
      const bodyStorage = '<p>No diagrams</p>';
      const client = createMockClient();

      const result = await syncDrawioAttachments(client, 'user-1', 'page-1', bodyStorage, []);

      expect(result).toEqual([]);
    });

    it('extracts diagramName when preceded by other parameters (real Confluence DC format)', async () => {
      // Real Confluence DC 9.2 draw.io macros often include baseUrl, revision, and other params before diagramName
      const bodyStorage = `<ac:structured-macro ac:name="drawio" ac:schema-version="1" ac:macro-id="abc123">
  <ac:parameter ac:name="baseUrl">https://confluence.example.com</ac:parameter>
  <ac:parameter ac:name="diagramName">network-topology</ac:parameter>
  <ac:parameter ac:name="revision">3</ac:parameter>
  <ac:parameter ac:name="simple">0</ac:parameter>
</ac:structured-macro>`;

      const client = createMockClient();
      const attachments = makeAttachments([
        { title: 'network-topology.png', download: '/download/network-topology.png' },
      ]);

      const result = await syncDrawioAttachments(client, 'user-1', 'page-1', bodyStorage, attachments);

      expect(result).toEqual(['network-topology.png']);
      expect(client.downloadAttachment).toHaveBeenCalledTimes(1);
    });

    it('matches attachment by name without .png extension as fallback, cached as .png', async () => {
      const bodyStorage = `<ac:structured-macro ac:name="drawio"><ac:parameter ac:name="diagramName">arch-diagram</ac:parameter></ac:structured-macro>`;

      const client = createMockClient();
      // Some draw.io versions store the attachment without .png extension
      const attachments = makeAttachments([
        { title: 'arch-diagram', download: '/download/arch-diagram' },
      ]);

      const result = await syncDrawioAttachments(client, 'user-1', 'page-1', bodyStorage, attachments);

      // Should cache as arch-diagram.png so the URL matches
      expect(result).toEqual(['arch-diagram.png']);
      expect(client.downloadAttachment).toHaveBeenCalledWith('/download/arch-diagram');
    });

    it('handles multiple draw.io diagrams on one page', async () => {
      const bodyStorage = `
<ac:structured-macro ac:name="drawio"><ac:parameter ac:name="diagramName">diagram-a</ac:parameter></ac:structured-macro>
<p>Some text between diagrams</p>
<ac:structured-macro ac:name="drawio"><ac:parameter ac:name="diagramName">diagram-b</ac:parameter></ac:structured-macro>`;

      const client = createMockClient();
      const attachments = makeAttachments([
        { title: 'diagram-a.png', download: '/download/diagram-a.png' },
        { title: 'diagram-b.png', download: '/download/diagram-b.png' },
      ]);

      const result = await syncDrawioAttachments(client, 'user-1', 'page-1', bodyStorage, attachments);

      expect(result).toEqual(['diagram-a.png', 'diagram-b.png']);
      expect(client.downloadAttachment).toHaveBeenCalledTimes(2);
    });

    it('skips diagrams whose attachments are not found', async () => {
      const bodyStorage = `<ac:structured-macro ac:name="drawio"><ac:parameter ac:name="diagramName">missing-diagram</ac:parameter></ac:structured-macro>`;

      const client = createMockClient();
      // No matching attachment in the list
      const attachments = makeAttachments([
        { title: 'unrelated.png', download: '/download/unrelated.png' },
      ]);

      const result = await syncDrawioAttachments(client, 'user-1', 'page-1', bodyStorage, attachments);

      expect(result).toEqual([]);
      expect(client.downloadAttachment).not.toHaveBeenCalled();
    });

    it('handles download errors gracefully', async () => {
      const bodyStorage = `<ac:structured-macro ac:name="drawio"><ac:parameter ac:name="diagramName">broken</ac:parameter></ac:structured-macro>`;

      const client = createMockClient();
      (client.downloadAttachment as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Download failed'));
      const attachments = makeAttachments([
        { title: 'broken.png', download: '/download/broken.png' },
      ]);

      const result = await syncDrawioAttachments(client, 'user-1', 'page-1', bodyStorage, attachments);

      expect(result).toEqual([]);
    });

    it('falls back to .xml attachment when no PNG export exists, cached as .png', async () => {
      const bodyStorage = `<ac:structured-macro ac:name="drawio"><ac:parameter ac:name="diagramName">network</ac:parameter></ac:structured-macro>`;

      const client = createMockClient();
      // Only the XML source file is available — no PNG export
      const attachments = makeAttachments([
        { title: 'network.xml', download: '/download/network.xml' },
      ]);

      const result = await syncDrawioAttachments(client, 'user-1', 'page-1', bodyStorage, attachments);

      // Should cache as network.png so the URL (/api/attachments/{pageId}/network.png) matches
      expect(result).toEqual(['network.png']);
      expect(client.downloadAttachment).toHaveBeenCalledWith('/download/network.xml');
    });

    it('prefers PNG attachment over XML when both exist', async () => {
      const bodyStorage = `<ac:structured-macro ac:name="drawio"><ac:parameter ac:name="diagramName">flow</ac:parameter></ac:structured-macro>`;

      const client = createMockClient();
      // Both PNG and XML exist — PNG should win
      const attachments = makeAttachments([
        { title: 'flow.png', download: '/download/flow.png' },
        { title: 'flow.xml', download: '/download/flow.xml' },
      ]);

      const result = await syncDrawioAttachments(client, 'user-1', 'page-1', bodyStorage, attachments);

      expect(result).toEqual(['flow.png']);
      expect(client.downloadAttachment).toHaveBeenCalledWith('/download/flow.png');
      expect(client.downloadAttachment).toHaveBeenCalledTimes(1);
    });

    it('skips download when draw.io diagram is already cached (idempotent)', async () => {
      const bodyStorage = `<ac:structured-macro ac:name="drawio"><ac:parameter ac:name="diagramName">cached-diagram</ac:parameter></ac:structured-macro>`;
      const client = createMockClient();
      const attachments = makeAttachments([
        { title: 'cached-diagram.png', download: '/download/cached-diagram.png' },
      ]);

      // Simulate file already cached: fs.access resolves for this test
      (fs.access as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);

      const result = await syncDrawioAttachments(client, 'user-1', 'page-1', bodyStorage, attachments);

      expect(result).toEqual(['cached-diagram.png']);
      // No download should have occurred
      expect(client.downloadAttachment).not.toHaveBeenCalled();
      expect(fs.writeFile).not.toHaveBeenCalled();
    });

    it('downloads draw.io PNG when not yet cached', async () => {
      const bodyStorage = `<ac:structured-macro ac:name="drawio"><ac:parameter ac:name="diagramName">new-diagram</ac:parameter></ac:structured-macro>`;
      const client = createMockClient();
      const attachments = makeAttachments([
        { title: 'new-diagram.png', download: '/download/new-diagram.png' },
      ]);

      const result = await syncDrawioAttachments(client, 'user-1', 'page-1', bodyStorage, attachments);

      expect(result).toEqual(['new-diagram.png']);
      expect(client.downloadAttachment).toHaveBeenCalledOnce();
      expect(fs.writeFile).toHaveBeenCalledOnce();
    });
  });

  describe('syncImageAttachments with non-standard attribute ordering', () => {
    it('handles ri:filename not being the first attribute', async () => {
      const bodyStorage = `<ac:image><ri:attachment ri:version-at-save="1" ri:filename="report.png" /></ac:image>`;
      const client = createMockClient();
      const attachments = makeAttachments([
        { title: 'report.png', download: '/download/report.png' },
      ]);

      const result = await syncImageAttachments(client, 'user-1', 'page-1', bodyStorage, attachments);

      expect(result).toEqual(['report.png']);
      expect(client.downloadAttachment).toHaveBeenCalledTimes(1);
    });

    it('handles multiple attributes on ri:attachment', async () => {
      const bodyStorage = `<ac:image ac:width="800" ac:height="600"><ri:attachment ri:version-at-save="2" ri:filename="screenshot.jpg" ri:content-type="image/jpeg" /></ac:image>`;
      const client = createMockClient();
      const attachments = makeAttachments([
        { title: 'screenshot.jpg', download: '/download/screenshot.jpg' },
      ]);

      const result = await syncImageAttachments(client, 'user-1', 'page-1', bodyStorage, attachments);

      expect(result).toEqual(['screenshot.jpg']);
    });
  });

  describe('fetchAndCacheAttachment draw.io fallback', () => {
    it('finds .xml attachment when .png is requested', async () => {
      const imageData = Buffer.from('drawio-xml');
      const client = createMockClient();
      (client.getPageAttachments as ReturnType<typeof vi.fn>).mockResolvedValue({
        results: makeAttachments([
          { title: 'diagram.xml', download: '/download/diagram.xml' },
        ]),
      });
      (client.downloadAttachment as ReturnType<typeof vi.fn>).mockResolvedValue(imageData);

      const result = await fetchAndCacheAttachment(client, 'user-1', 'page-1', 'diagram.png');

      expect(result).toEqual(imageData);
      expect(client.downloadAttachment).toHaveBeenCalledWith('/download/diagram.xml');
    });

    it('finds bare-name attachment when .png is requested', async () => {
      const imageData = Buffer.from('drawio-data');
      const client = createMockClient();
      (client.getPageAttachments as ReturnType<typeof vi.fn>).mockResolvedValue({
        results: makeAttachments([
          { title: 'mydiagram', download: '/download/mydiagram' },
        ]),
      });
      (client.downloadAttachment as ReturnType<typeof vi.fn>).mockResolvedValue(imageData);

      const result = await fetchAndCacheAttachment(client, 'user-1', 'page-1', 'mydiagram.png');

      expect(result).toEqual(imageData);
      expect(client.downloadAttachment).toHaveBeenCalledWith('/download/mydiagram');
    });

    it('returns null when no fallback matches either', async () => {
      const client = createMockClient();
      (client.getPageAttachments as ReturnType<typeof vi.fn>).mockResolvedValue({
        results: makeAttachments([
          { title: 'unrelated.pdf', download: '/download/unrelated.pdf' },
        ]),
      });

      const result = await fetchAndCacheAttachment(client, 'user-1', 'page-1', 'missing.png');

      expect(result).toBeNull();
    });
  });

  describe('hasLocalAttachments', () => {
    it('returns true when directory has files', async () => {
      vi.mocked(fs.readdir as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(['file1.png', 'file2.jpg']);

      const result = await hasLocalAttachments('user-1', 'page-1');
      expect(result).toBe(true);
    });

    it('returns false when directory is empty', async () => {
      vi.mocked(fs.readdir as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

      const result = await hasLocalAttachments('user-1', 'page-1');
      expect(result).toBe(false);
    });

    it('returns false when directory does not exist', async () => {
      vi.mocked(fs.readdir as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );

      const result = await hasLocalAttachments('user-1', 'page-1');
      expect(result).toBe(false);
    });
  });

  describe('getExpectedAttachmentFilenames', () => {
    it('returns image filenames from XHTML', () => {
      const body = `<ac:image><ri:attachment ri:filename="photo.png" /></ac:image>
<ac:image><ri:attachment ri:filename="logo.jpg" /></ac:image>`;
      expect(getExpectedAttachmentFilenames(body)).toEqual(['photo.png', 'logo.jpg']);
    });

    it('returns draw.io diagram PNG filenames', () => {
      const body = `<ac:structured-macro ac:name="drawio"><ac:parameter ac:name="diagramName">topology</ac:parameter></ac:structured-macro>`;
      expect(getExpectedAttachmentFilenames(body)).toEqual(['topology.png']);
    });

    it('combines images and draw.io diagrams', () => {
      const body = `<ac:image><ri:attachment ri:filename="screenshot.png" /></ac:image>
<ac:structured-macro ac:name="drawio"><ac:parameter ac:name="diagramName">arch</ac:parameter></ac:structured-macro>`;
      expect(getExpectedAttachmentFilenames(body)).toEqual(['screenshot.png', 'arch.png']);
    });

    it('includes deterministic filenames for cross-page and external images', () => {
      const body = `<ac:image><ri:attachment ri:filename="shared.png"><ri:page ri:content-title="Shared Assets" ri:space-key="OPS" /></ri:attachment></ac:image>
<ac:image><ri:url ri:value="https://example.com/img.png" /></ac:image>`;
      expect(getExpectedAttachmentFilenames(body, 'OPS')).toEqual([
        getLocalFilenameForImageSource({
          kind: 'attachment',
          attachmentFilename: 'shared.png',
          sourcePageTitle: 'Shared Assets',
          sourceSpaceKey: 'OPS',
        }),
        getLocalFilenameForImageSource({ kind: 'external-url', url: 'https://example.com/img.png' }),
      ]);
    });

    it('filters out non-image extensions', () => {
      const body = `<ac:image><ri:attachment ri:filename="doc.pdf" /></ac:image>
<ac:image><ri:attachment ri:filename="valid.png" /></ac:image>`;
      expect(getExpectedAttachmentFilenames(body)).toEqual(['valid.png']);
    });

    it('returns empty array for content with no attachments', () => {
      expect(getExpectedAttachmentFilenames('<p>No images</p>')).toEqual([]);
    });
  });

  describe('getMissingAttachments', () => {
    it('returns all filenames when none are cached', async () => {
      const body = `<ac:image><ri:attachment ri:filename="a.png" /></ac:image>
<ac:image><ri:attachment ri:filename="b.jpg" /></ac:image>`;

      // fs.access rejects by default (ENOENT) — all files missing
      const missing = await getMissingAttachments('user-1', 'page-1', body);
      expect(missing).toEqual(['a.png', 'b.jpg']);
    });

    it('returns empty when all files are cached', async () => {
      const body = `<ac:image><ri:attachment ri:filename="a.png" /></ac:image>`;

      // Simulate file exists
      vi.mocked(fs.access).mockResolvedValueOnce(undefined);

      const missing = await getMissingAttachments('user-1', 'page-1', body);
      expect(missing).toEqual([]);
    });

    it('returns only the uncached files', async () => {
      const body = `<ac:image><ri:attachment ri:filename="cached.png" /></ac:image>
<ac:image><ri:attachment ri:filename="missing.png" /></ac:image>`;

      // First call: cached.png exists; second call: missing.png does not
      vi.mocked(fs.access)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const missing = await getMissingAttachments('user-1', 'page-1', body);
      expect(missing).toEqual(['missing.png']);
    });

    it('returns empty for content with no expected attachments', async () => {
      const missing = await getMissingAttachments('user-1', 'page-1', '<p>No images</p>');
      expect(missing).toEqual([]);
    });
  });

  describe('case-insensitive filename matching', () => {
    it('syncImageAttachments matches attachment with different casing', async () => {
      const bodyStorage = `<ac:image><ri:attachment ri:filename="Screenshot.PNG" /></ac:image>`;
      const client = createMockClient();
      // Confluence returns lowercase title
      const attachments = makeAttachments([
        { title: 'screenshot.png', download: '/download/screenshot.png' },
      ]);

      const result = await syncImageAttachments(client, 'user-1', 'page-1', bodyStorage, attachments);

      // Result uses the XHTML filename (not the Confluence title)
      expect(result).toEqual(['Screenshot.PNG']);
      expect(client.downloadAttachment).toHaveBeenCalledTimes(1);
    });

    it('fetchAndCacheAttachment matches attachment with different casing', async () => {
      const imageData = Buffer.from('case-data');
      const client = createMockClient();
      (client.getPageAttachments as ReturnType<typeof vi.fn>).mockResolvedValue({
        results: makeAttachments([
          { title: 'LOGO.PNG', download: '/download/LOGO.PNG' },
        ]),
      });
      (client.downloadAttachment as ReturnType<typeof vi.fn>).mockResolvedValue(imageData);

      const result = await fetchAndCacheAttachment(client, 'user-1', 'page-1', 'logo.png');

      expect(result).toEqual(imageData);
      expect(client.downloadAttachment).toHaveBeenCalledWith('/download/LOGO.PNG');
    });

    it('syncImageAttachments prefers exact match over case-insensitive', async () => {
      const bodyStorage = `<ac:image><ri:attachment ri:filename="Logo.png" /></ac:image>`;
      const client = createMockClient();
      const attachments = makeAttachments([
        { title: 'logo.png', download: '/download/lower.png' },
        { title: 'Logo.png', download: '/download/exact.png' },
      ]);

      await syncImageAttachments(client, 'user-1', 'page-1', bodyStorage, attachments);

      // Should use exact match
      expect(client.downloadAttachment).toHaveBeenCalledWith('/download/exact.png');
    });
  });

  describe('streaming large attachments', () => {
    describe('cacheAttachment', () => {
      it('uses in-memory download for small files (no fileSizeHint)', async () => {
        const client = createMockClient();

        await cacheAttachment(client, 'user-1', 'page-1', '/download/small.png', 'small.png');

        expect(client.downloadAttachment).toHaveBeenCalledWith('/download/small.png');
        expect(client.downloadAttachmentToFile).not.toHaveBeenCalled();
        expect(fs.writeFile).toHaveBeenCalled();
      });

      it('uses in-memory download when fileSizeHint is below threshold', async () => {
        const client = createMockClient();
        const smallSize = STREAM_THRESHOLD_BYTES - 1;

        await cacheAttachment(client, 'user-1', 'page-1', '/download/small.png', 'small.png', smallSize);

        expect(client.downloadAttachment).toHaveBeenCalledWith('/download/small.png');
        expect(client.downloadAttachmentToFile).not.toHaveBeenCalled();
      });

      it('uses streaming download when fileSizeHint exceeds threshold', async () => {
        const client = createMockClient();
        const largeSize = STREAM_THRESHOLD_BYTES + 1;

        await cacheAttachment(client, 'user-1', 'page-1', '/download/large.pdf', 'large.pdf', largeSize);

        expect(client.downloadAttachmentToFile).toHaveBeenCalledTimes(1);
        expect(client.downloadAttachmentToFile).toHaveBeenCalledWith(
          '/download/large.pdf',
          expect.stringContaining('large.pdf'),
          MAX_ATTACHMENT_BYTES,
        );
        // Should NOT use the in-memory path
        expect(client.downloadAttachment).not.toHaveBeenCalled();
        expect(fs.writeFile).not.toHaveBeenCalled();
      });

      it('uses in-memory download when fileSizeHint is exactly at threshold', async () => {
        const client = createMockClient();

        await cacheAttachment(client, 'user-1', 'page-1', '/download/exact.png', 'exact.png', STREAM_THRESHOLD_BYTES);

        // At threshold = not above threshold, so in-memory
        expect(client.downloadAttachment).toHaveBeenCalled();
        expect(client.downloadAttachmentToFile).not.toHaveBeenCalled();
      });
    });

    describe('syncImageAttachments with large files', () => {
      it('uses streaming for large image attachments', async () => {
        const bodyStorage = `<ac:image><ri:attachment ri:filename="huge-photo.png" /></ac:image>`;
        const client = createMockClient();
        const largeSize = STREAM_THRESHOLD_BYTES + 1000;
        const attachments = makeAttachments([
          { title: 'huge-photo.png', download: '/download/huge-photo.png', fileSize: largeSize },
        ]);

        const result = await syncImageAttachments(client, 'user-1', 'page-1', bodyStorage, attachments);

        expect(result).toEqual(['huge-photo.png']);
        expect(client.downloadAttachmentToFile).toHaveBeenCalledTimes(1);
        expect(client.downloadAttachment).not.toHaveBeenCalled();
      });

      it('uses in-memory download for small image attachments', async () => {
        const bodyStorage = `<ac:image><ri:attachment ri:filename="small-icon.png" /></ac:image>`;
        const client = createMockClient();
        const smallSize = 1024;
        const attachments = makeAttachments([
          { title: 'small-icon.png', download: '/download/small-icon.png', fileSize: smallSize },
        ]);

        const result = await syncImageAttachments(client, 'user-1', 'page-1', bodyStorage, attachments);

        expect(result).toEqual(['small-icon.png']);
        expect(client.downloadAttachment).toHaveBeenCalledTimes(1);
        expect(client.downloadAttachmentToFile).not.toHaveBeenCalled();
      });
    });

    describe('syncDrawioAttachments with large files', () => {
      it('uses streaming for large draw.io attachments', async () => {
        const bodyStorage = `<ac:structured-macro ac:name="drawio"><ac:parameter ac:name="diagramName">big-diagram</ac:parameter></ac:structured-macro>`;
        const client = createMockClient();
        const largeSize = STREAM_THRESHOLD_BYTES * 2;
        const attachments = makeAttachments([
          { title: 'big-diagram.png', download: '/download/big-diagram.png', fileSize: largeSize },
        ]);

        const result = await syncDrawioAttachments(client, 'user-1', 'page-1', bodyStorage, attachments);

        expect(result).toEqual(['big-diagram.png']);
        expect(client.downloadAttachmentToFile).toHaveBeenCalledTimes(1);
        expect(client.downloadAttachment).not.toHaveBeenCalled();
      });
    });

    describe('fetchAndCacheAttachment with large files', () => {
      it('uses streaming for large on-demand attachments', async () => {
        const largeSize = STREAM_THRESHOLD_BYTES + 5000;
        const client = createMockClient();
        (client.getPageAttachments as ReturnType<typeof vi.fn>).mockResolvedValue({
          results: [{
            id: 'att-1',
            title: 'large-report.pdf',
            mediaType: 'application/pdf',
            extensions: { mediaType: 'application/pdf', fileSize: largeSize },
            _links: { download: '/download/large-report.pdf' },
          }],
        });

        // Mock readFile for reading back after streaming
        (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(Buffer.from('streamed-data'));

        const result = await fetchAndCacheAttachment(client, 'user-1', 'page-1', 'large-report.pdf');

        expect(result).toEqual(Buffer.from('streamed-data'));
        expect(client.downloadAttachmentToFile).toHaveBeenCalledWith(
          '/download/large-report.pdf',
          expect.stringContaining('large-report.pdf'),
          MAX_ATTACHMENT_BYTES,
        );
        // Should NOT use the in-memory download
        expect(client.downloadAttachment).not.toHaveBeenCalled();
        // Should read back from the cached file
        expect(fs.readFile).toHaveBeenCalled();
      });

      it('uses in-memory download for small on-demand attachments', async () => {
        const smallData = Buffer.from('small-content');
        const client = createMockClient();
        (client.getPageAttachments as ReturnType<typeof vi.fn>).mockResolvedValue({
          results: [{
            id: 'att-1',
            title: 'tiny.png',
            mediaType: 'image/png',
            extensions: { mediaType: 'image/png', fileSize: 256 },
            _links: { download: '/download/tiny.png' },
          }],
        });
        (client.downloadAttachment as ReturnType<typeof vi.fn>).mockResolvedValue(smallData);

        const result = await fetchAndCacheAttachment(client, 'user-1', 'page-1', 'tiny.png');

        expect(result).toEqual(smallData);
        expect(client.downloadAttachment).toHaveBeenCalledWith('/download/tiny.png');
        expect(client.downloadAttachmentToFile).not.toHaveBeenCalled();
      });

      it('uses in-memory download when attachment has no fileSize metadata', async () => {
        const data = Buffer.from('no-size-info');
        const client = createMockClient();
        (client.getPageAttachments as ReturnType<typeof vi.fn>).mockResolvedValue({
          results: [{
            id: 'att-1',
            title: 'unknown-size.png',
            mediaType: 'image/png',
            // No extensions field
            _links: { download: '/download/unknown-size.png' },
          }],
        });
        (client.downloadAttachment as ReturnType<typeof vi.fn>).mockResolvedValue(data);

        const result = await fetchAndCacheAttachment(client, 'user-1', 'page-1', 'unknown-size.png');

        expect(result).toEqual(data);
        expect(client.downloadAttachment).toHaveBeenCalled();
        expect(client.downloadAttachmentToFile).not.toHaveBeenCalled();
      });
    });

    describe('constants', () => {
      it('STREAM_THRESHOLD_BYTES should be 5 MB', () => {
        expect(STREAM_THRESHOLD_BYTES).toBe(5 * 1024 * 1024);
      });

      it('MAX_ATTACHMENT_BYTES should be 50 MB', () => {
        expect(MAX_ATTACHMENT_BYTES).toBe(50 * 1024 * 1024);
      });
    });
  });
});
