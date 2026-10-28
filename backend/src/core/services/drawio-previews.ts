import fs from 'node:fs/promises';
import { JSDOM } from 'jsdom';
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
