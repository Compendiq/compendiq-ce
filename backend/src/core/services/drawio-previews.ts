import fs from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { safeAttachmentPath } from './attachment-store.js';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Resolve converted diagrams against cached bytes before publishing HTML. */
export async function materializeDrawioPreviews(html: string, pageId: string): Promise<{ html: string; missing: string[] }> {
  if (!html.includes('confluence-drawio')) return { html, missing: [] };
  const document = new JSDOM(`<body>${html}</body>`).window.document;
  const missing: string[] = [];
  for (const diagram of document.querySelectorAll('.confluence-drawio')) {
    const name = diagram.getAttribute('data-diagram-name');
    if (!name) continue;
    const png = `${name}.png`;
    let validPng = false;
    try {
      const file = await fs.open(safeAttachmentPath(pageId, png), 'r');
      try {
        const signature = Buffer.alloc(PNG_SIGNATURE.length);
        const { bytesRead } = await file.read(signature, 0, signature.length, 0);
        validPng = bytesRead === signature.length && signature.equals(PNG_SIGNATURE);
      } finally {
        await file.close();
      }
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
    }
  }
  return { html: document.body.innerHTML, missing };
}
