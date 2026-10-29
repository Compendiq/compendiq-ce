import fs from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import type { PoolClient } from 'pg';
import { htmlToText } from './content-converter.js';
import { invalidateCollabDocAfterBodyWrite } from './collab-guard.js';
import { safeAttachmentPath } from './attachment-store.js';
import { isValidPngFile } from './valid-png.js';


/** Resolve converted diagrams against cached bytes before publishing HTML. */
export async function materializeDrawioPreviews(html: string, pageId: string): Promise<{ html: string; missing: string[]; missingSources: string[] }> {
  if (!html.includes('confluence-drawio')) return { html, missing: [], missingSources: [] };
  const document = new JSDOM(`<body>${html}</body>`).window.document;
  const missing: string[] = [];
  const missingSources: string[] = [];
  for (const diagram of document.querySelectorAll('.confluence-drawio')) {
    const name = diagram.getAttribute('data-diagram-name');
    if (!name) continue;
    const png = `${name}.png`;
    let validPng = false;
    try {
      validPng = await isValidPngFile(safeAttachmentPath(pageId, png));
    } catch {
      // Missing previews remain explicitly unavailable.
    }
    if (validPng) {
      diagram.querySelector('.drawio-preview-unavailable')?.remove();
      if (!diagram.querySelector('img')) {
        const image = document.createElement('img');
        image.src = `/api/attachments/${encodeURIComponent(pageId)}/${encodeURIComponent(png)}`;
        image.alt = `Draw.io diagram: ${name}`;
        diagram.prepend(image);
      }
    } else {
      diagram.querySelector('img')?.remove();
      if (!diagram.querySelector('.drawio-preview-unavailable')) {
        const message = document.createElement('span');
        message.className = 'drawio-preview-unavailable';
        message.textContent = `Draw.io preview unavailable: ${name}`;
        diagram.prepend(message);
      }
      missing.push(png);
    }
    try {
      await fs.access(safeAttachmentPath(pageId, `${name}.drawio`));
      diagram.setAttribute('data-drawio-source', `/api/attachments/${encodeURIComponent(pageId)}/${encodeURIComponent(`${name}.drawio`)}`);
    } catch {
      diagram.removeAttribute('data-drawio-source');
      missingSources.push(`${name}.drawio`);
    }
  }
  return { html: document.body.innerHTML, missing, missingSources };
}

/**
 * Publish only diagrams bound to files this admitted attachment mutation wrote.
 * Call after live-file promotion, on the mutation's locked transaction client.
 * Never reconvert storage here: it may predate locally authored HTML.
 */
export async function publishSavedDrawioPreviews(
  client: PoolClient,
  pageId: number,
  files: Array<{ filename: string; path: string; url: string }>,
): Promise<void> {
  const previews = files.filter((file) => file.filename.endsWith('.png'));
  if (previews.length === 0) return;
  const { rows } = await client.query<{ body_html: string | null }>(
    'SELECT body_html FROM pages WHERE id = $1 FOR UPDATE', [pageId],
  );
  const html = rows[0]?.body_html;
  if (!html?.includes('confluence-drawio')) return;
  const document = new JSDOM(`<body>${html}</body>`).window.document;
  let changed = false;
  for (const file of previews) {
    const sourceUrl = `${file.url.slice(0, -4)}.drawio`;
    const diagrams = [...document.querySelectorAll('.confluence-drawio')]
      .filter((diagram) => diagram.getAttribute('data-drawio-source') === sourceUrl
        && !diagram.querySelector('img'));
    if (diagrams.length === 0 || !await isValidPngFile(file.path)) continue;
    for (const diagram of diagrams) {
      diagram.querySelector('.drawio-preview-unavailable')?.remove();
      const image = document.createElement('img');
      image.src = file.url;
      image.alt = `Draw.io diagram: ${diagram.getAttribute('data-diagram-name') ?? file.filename.slice(0, -4)}`;
      diagram.prepend(image);
      changed = true;
    }
  }
  if (!changed) return;
  const rendered = document.body.innerHTML;
  await invalidateCollabDocAfterBodyWrite(pageId, client);
  await client.query(
    `UPDATE pages SET body_html = $2, body_text = $3, embedding_dirty = TRUE WHERE id = $1`,
    [pageId, rendered, htmlToText(rendered)],
  );
}
