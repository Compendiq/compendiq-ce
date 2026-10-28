import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'http';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { ConfluenceClient, type ConfluenceAttachment } from './confluence-client.js';
import { attachmentCacheDir, fetchAndCacheAttachment, MAX_ATTACHMENT_BYTES, STREAM_THRESHOLD_BYTES, syncDrawioAttachments } from './attachment-handler.js';
import { confluenceToHtml } from '../../../core/services/content-converter.js';
import { materializeDrawioPreviews } from '../../../core/services/drawio-previews.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const xml = Buffer.from('<mxfile><diagram id="1">editable</diagram></mxfile>');
const body = '<ac:structured-macro ac:name="drawio"><ac:parameter ac:name="baseUrl">ignored</ac:parameter><ac:parameter ac:name="diagramName">diagram</ac:parameter></ac:structured-macro>';
let files: Record<string, Buffer> = {};
let attachments: ConfluenceAttachment[] = [];
let requests: string[] = [];
let pageId: string;
let client: ConfluenceClient;
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://fixture');
  if (url.pathname.includes('/child/attachment')) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ results: attachments }));
    return;
  }
  requests.push(url.pathname);
  if (url.pathname === '/oversized') {
    res.writeHead(200, { 'content-length': MAX_ATTACHMENT_BYTES + 1 });
    res.end();
    return;
  }
  const data = files[url.pathname];
  if (!data) { res.writeHead(404); res.end(); return; }
  res.end(data);
});

function attachment(title: string, download: string, fileSize?: number): ConfluenceAttachment {
  return { id: title, title, mediaType: 'application/octet-stream', _links: { download }, ...(fileSize === undefined ? {} : { extensions: { fileSize, mediaType: 'application/octet-stream' } }) };
}
function cacheFile(name: string): string { return path.join(attachmentCacheDir(pageId), name); }
async function missing(name: string): Promise<void> {
  await expect(fs.access(cacheFile(name))).rejects.toMatchObject({ code: 'ENOENT' });
}

describe('draw.io attachment HTTP boundary', () => {
  beforeAll(async () => {
    const listening = Promise.withResolvers<void>();
    server.listen(0, '127.0.0.1', listening.resolve);
    await listening.promise;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    client = new ConfluenceClient(`http://127.0.0.1:${address.port}`, 'fixture');
  });
  afterAll(async () => {
    const closed = Promise.withResolvers<void>();
    server.close((err) => err ? closed.reject(err) : closed.resolve());
    await closed.promise;
  });
  beforeEach(() => { pageId = `drawio-${randomUUID()}`; files = {}; attachments = []; requests = []; });
  afterEach(async () => { await fs.rm(attachmentCacheDir(pageId), { recursive: true, force: true }); });

  it.each(['diagram.xml', 'diagram', 'diagram.drawio', 'diagram.png'])('keeps %s XML editable without inventing a preview', async (title) => {
    files['/source'] = xml;
    attachments = [attachment(title, '/source')];
    expect(await syncDrawioAttachments(client, 'user', pageId, body, attachments)).toEqual(['diagram.drawio']);
    expect(await fs.readFile(cacheFile('diagram.drawio'))).toEqual(xml);
    await missing('diagram.png');
    expect(await syncDrawioAttachments(client, 'user', pageId, body, attachments)).toEqual(['diagram.drawio']);
    expect(requests).toEqual(['/source']);
  });

  it('publishes source-only and real raster presentations from the same conversion', async () => {
    files = { '/source': xml, '/image': png };
    attachments = [attachment('diagram.xml', '/source')];
    await syncDrawioAttachments(client, 'user', pageId, body, attachments);
    const converted = confluenceToHtml(body, pageId);
    expect(converted).not.toContain('<img');
    const sourceOnly = await materializeDrawioPreviews(converted, pageId);
    expect(sourceOnly.html).toContain('Draw.io preview unavailable: diagram');
    expect(sourceOnly.html).toContain(`data-drawio-source="/api/attachments/${pageId}/diagram.drawio"`);
    expect(sourceOnly.html).not.toContain('<img');
    attachments.push(attachment('diagram.png', '/image'));
    await syncDrawioAttachments(client, 'user', pageId, body, attachments);
    const rendered = await materializeDrawioPreviews(converted, pageId);
    expect(rendered.html).toContain(`src="/api/attachments/${pageId}/diagram.png"`);
    expect(rendered.html).not.toContain('preview unavailable');
  });

  it.each([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    png.subarray(0, png.length - 4),
    Buffer.concat([png.subarray(0, 45), Buffer.from([0]), png.subarray(46)]),
  ])('does not publish an incomplete or corrupt PNG', async (invalid) => {
    files['/image'] = invalid;
    attachments = [attachment('diagram.png', '/image')];
    expect(await syncDrawioAttachments(client, 'user', pageId, body, attachments)).toEqual([]);
    await missing('diagram.png');
    const result = await materializeDrawioPreviews(confluenceToHtml(body, pageId), pageId);
    expect(result.html).not.toContain('<img');
    expect(result.html).toContain('preview unavailable');
  });

  it('accepts an interlaced raster split across IDAT chunks', async () => {
    const interlaced = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAADCAIAAAGuTRJ+AAAAA0lEQVR4nGOqZ4K+AAAAEElEQVQQUDBggGIkJpQLRAA1AQNh8iOwnAAAAABJRU5ErkJggg==', 'base64');
    files['/image'] = interlaced;
    attachments = [attachment('diagram.png', '/image')];
    expect(await syncDrawioAttachments(client, 'user', pageId, body, attachments)).toEqual(['diagram.png']);
    expect(await fs.readFile(cacheFile('diagram.png'))).toEqual(interlaced);
  });

  it.each(['diagram.png', 'diagram'])('caches real %s PNG and skips repeat downloads', async (title) => {
    files['/image'] = png;
    attachments = [attachment(title, '/image')];
    expect(await syncDrawioAttachments(client, 'user', pageId, body, attachments)).toEqual(['diagram.png']);
    expect(await fs.readFile(cacheFile('diagram.png'))).toEqual(png);
    await missing('diagram.drawio');
    await syncDrawioAttachments(client, 'user', pageId, body, attachments);
    expect(requests).toEqual(['/image']);
  });

  it('caches both PNG and XML, including streamed downloads', async () => {
    files = { '/image': png, '/source': xml };
    attachments = [attachment('diagram.png', '/image', STREAM_THRESHOLD_BYTES + 1), attachment('diagram.xml', '/source', STREAM_THRESHOLD_BYTES + 1)];
    expect(await syncDrawioAttachments(client, 'user', pageId, body, attachments)).toEqual(['diagram.png', 'diagram.drawio']);
    expect(await fs.readFile(cacheFile('diagram.png'))).toEqual(png);
    expect(await fs.readFile(cacheFile('diagram.drawio'))).toEqual(xml);
    await syncDrawioAttachments(client, 'user', pageId, body, attachments);
    expect(requests).toEqual(['/source', '/image']);
  });

  it('recovers a legacy XML-as-PNG even when the original attachment is gone', async () => {
    await fs.mkdir(path.dirname(cacheFile('diagram.png')), { recursive: true });
    await fs.writeFile(cacheFile('diagram.png'), xml);
    expect(await syncDrawioAttachments(client, 'user', pageId, body, [])).toEqual(['diagram.drawio']);
    expect(await fs.readFile(cacheFile('diagram.drawio'))).toEqual(xml);
    await missing('diagram.png');
  });

  it('replaces an invalid cached preview with a real PNG and rejects an invalid export', async () => {
    await fs.mkdir(path.dirname(cacheFile('diagram.png')), { recursive: true });
    await fs.writeFile(cacheFile('diagram.png'), Buffer.from('not an image'));
    files['/image'] = png;
    attachments = [attachment('diagram.png', '/image')];
    expect(await syncDrawioAttachments(client, 'user', pageId, body, attachments)).toEqual(['diagram.png']);
    expect(await fs.readFile(cacheFile('diagram.png'))).toEqual(png);
    await fs.rm(cacheFile('diagram.png'));
    files['/image'] = Buffer.from('not an image');
    expect(await syncDrawioAttachments(client, 'user', pageId, body, attachments)).toEqual([]);
    await missing('diagram.png');
  });

  it('examines a bare source even when an older PNG preview is cached', async () => {
    await fs.mkdir(path.dirname(cacheFile('diagram.png')), { recursive: true });
    await fs.writeFile(cacheFile('diagram.png'), png);
    files['/source'] = xml;
    attachments = [attachment('diagram', '/source')];
    expect(await syncDrawioAttachments(client, 'user', pageId, body, attachments)).toEqual(['diagram.png', 'diagram.drawio']);
    expect(await fs.readFile(cacheFile('diagram.png'))).toEqual(png);
    expect(await fs.readFile(cacheFile('diagram.drawio'))).toEqual(xml);
    await syncDrawioAttachments(client, 'user', pageId, body, attachments);
    expect(requests).toEqual(['/source']);
  });

  it('enforces the streaming size limit without publishing partial files', async () => {
    attachments = [attachment('diagram.png', '/oversized', MAX_ATTACHMENT_BYTES + 1)];
    expect(await syncDrawioAttachments(client, 'user', pageId, body, attachments)).toEqual([]);
    await missing('diagram.png');
    expect(await fs.readdir(attachmentCacheDir(pageId))).toEqual([]);
  });

  it.each(['diagram.xml', 'diagram', 'diagram.drawio', 'diagram.png'])('on-demand PNG lookup never returns %s XML as an image', async (title) => {
    files['/source'] = xml;
    attachments = [attachment(title, '/source')];
    expect(await fetchAndCacheAttachment(client, 'user', pageId, 'diagram.png')).toBeNull();
    expect(await fs.readFile(cacheFile('diagram.drawio'))).toEqual(xml);
    await missing('diagram.png');
  });

  it('on-demand PNG lookup accepts an extensionless real PNG', async () => {
    files['/image'] = png;
    attachments = [attachment('diagram', '/image')];
    expect(await fetchAndCacheAttachment(client, 'user', pageId, 'diagram.png')).toEqual(png);
    expect(await fs.readFile(cacheFile('diagram.png'))).toEqual(png);
  });
});
