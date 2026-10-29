import { useAuthStore } from '../../stores/auth-store';
import { RefreshUnavailableError, refreshAccessTokenOnce } from './api';

// Match the attachment upload/source limits. Compressed pages share one budget.
const MAX_XML_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

function decodeXml(text: string): string {
  text = text.trim();
  // Packaged draw.io supports URI-encoded and double-encoded PNG metadata.
  for (let count = 0; count < 2 && text.startsWith('%'); count++) text = decodeURIComponent(text);
  return text;
}

async function inflateText(bytes: Uint8Array<ArrayBuffer>, budget: { remaining: number }): Promise<string> {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      budget.remaining -= value.byteLength;
      if (budget.remaining < 0) throw new Error('Diagram source exceeds the XML size limit');
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join('');
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function isGraph(element: Element | null): boolean {
  if (element?.tagName !== 'mxGraphModel') return false;
  if (element.children.length === 0) return !element.textContent?.trim();
  const root = element.firstElementChild;
  if (element.children.length !== 1 || root?.tagName !== 'root') return false;
  if (root.children.length === 0) return !root.textContent?.trim();
  return Array.from(root.children).every((cell) =>
    cell.tagName === 'mxCell' || Array.from(cell.children).some((child) => child.tagName === 'mxCell'));
}

/** Validate the document without flattening its pages or replacing an empty graph. */
async function diagramXml(text: string, budget = { remaining: MAX_XML_BYTES }): Promise<string> {
  const xml = decodeXml(text);
  if (!xml || new TextEncoder().encode(xml).byteLength > MAX_XML_BYTES) throw new Error('Invalid diagram source');
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  if (document.querySelector('parsererror')) throw new Error('Malformed diagram source');
  const root = document.documentElement;
  if (isGraph(root)) return xml;
  if (root.tagName !== 'mxfile') throw new Error('Not a draw.io diagram');
  const pages = Array.from(root.children).filter((child) => child.tagName === 'diagram');
  if (pages.length === 0) throw new Error('Diagram source has no pages');
  for (const page of pages) {
    if (page.children.length > 0) {
      if (page.children.length !== 1 || !isGraph(page.firstElementChild)) {
        throw new Error('Invalid diagram page');
      }
    } else {
      const encoded = page.textContent?.trim() ?? '';
      const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
      const graph = decodeXml(await inflateText(bytes, budget));
      const parsed = new DOMParser().parseFromString(graph, 'application/xml');
      if (parsed.querySelector('parsererror') || !isGraph(parsed.documentElement)) {
        throw new Error('Invalid compressed diagram page');
      }
    }
  }
  return xml;
}

async function diagramPng(blob: Blob): Promise<string> {
  if (blob.size === 0 || blob.size > MAX_ATTACHMENT_BYTES) throw new Error('Invalid diagram preview size');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((value, index) => bytes[index] === value)) throw new Error('Diagram preview is not PNG');
  const view = new DataView(bytes.buffer);
  const decoder = new TextDecoder();
  const budget = { remaining: MAX_XML_BYTES };
  let metadata: string | null = null;
  let imageData = false;
  let ended = false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = view.getUint32(offset);
    if (length > bytes.length - offset - 12) throw new Error('Truncated diagram PNG');
    const type = decoder.decode(bytes.subarray(offset + 4, offset + 8));
    if (offset === 8 && (type !== 'IHDR' || length !== 13)) throw new Error('Invalid diagram PNG header');
    if (!imageData && metadata === null && (type === 'tEXt' || type === 'zTXt')) {
      const data = bytes.subarray(offset + 8, offset + 8 + length);
      const separator = data.indexOf(0);
      const key = separator < 0 ? '' : decoder.decode(data.subarray(0, separator));
      if (key === 'mxfile' || key === 'mxGraphModel') {
        if (type === 'tEXt') metadata = decoder.decode(data.subarray(separator + 1));
        else if (data[separator + 1] === 0) {
          // Legacy draw.io zTXt uses raw DEFLATE and Java URL-encoded spaces.
          metadata = (await inflateText(data.slice(separator + 2), budget)).replace(/\+/g, ' ');
        }
      }
    }
    if (type === 'IDAT') imageData = true;
    offset += length + 12;
    if (type === 'IEND') {
      ended = length === 0 && offset === bytes.length;
      break;
    }
  }
  if (!ended || !imageData || metadata === null) throw new Error('PNG has no editable draw.io source');
  // Use the browser's raster decoder, not a second implementation of PNG validation.
  const image = await createImageBitmap(blob);
  image.close();
  return diagramXml(metadata, budget);
}

/** One read/edit-mode admission path: only parsed diagram XML reaches draw.io. */
export async function loadDrawioSource(options: { xml?: string | null; sourceUrl?: string | null; previewUrl?: string | null }): Promise<string> {
  if (options.xml) {
    try { return await diagramXml(options.xml); } catch { /* Try the persisted source instead. */ }
  }
  const candidates: Array<{ url: string; xml: boolean }> = [];
  if (options.sourceUrl?.startsWith('/api/attachments/') || options.sourceUrl?.startsWith('/api/local-attachments/')) {
    candidates.push({ url: options.sourceUrl, xml: true });
  }
  if (options.previewUrl) candidates.push({ url: options.previewUrl, xml: false });
  let attemptedRefresh = false;
  for (const candidate of candidates) {
    try {
      const headers: HeadersInit = {};
      const token = useAuthStore.getState().accessToken;
      if (token && candidate.url.startsWith('/api/')) headers.Authorization = `Bearer ${token}`;
      let response = await fetch(candidate.url, { headers, credentials: 'include', cache: 'no-store' });
      if (response.status === 401 && candidate.url.startsWith('/api/') && !attemptedRefresh) {
        attemptedRefresh = true;
        const refreshed = await refreshAccessTokenOnce();
        if (refreshed) {
          headers.Authorization = `Bearer ${refreshed}`;
          response = await fetch(candidate.url, { headers, credentials: 'include', cache: 'no-store' });
        }
      }
      if (response.ok) return candidate.xml ? await diagramXml(await response.text()) : await diagramPng(await response.blob());
    } catch (error) {
      // Rotation may have committed without its response/cookie reaching us.
      // Never replay that refresh through the next attachment candidate.
      if (error instanceof RefreshUnavailableError) throw error;
      // A missing/malformed source must not hide a usable legacy PNG+XML.
    }
  }
  throw new Error('Could not load an editable diagram source. Please try again.');
}
