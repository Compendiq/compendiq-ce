import { toast } from 'sonner';
import { apiFetch } from '../../lib/api';

export const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * Upload a pasted/dropped/chosen image file to the server.
 * Returns the served URL on success, or null on failure (shows a toast).
 */
export async function uploadPastedImage(file: File, pageId: string): Promise<string | null> {
  const ext = MIME_TO_EXT[file.type];
  if (!ext) {
    toast.error(`Unsupported image type: ${file.type}`);
    return null;
  }

  const hex = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  const filename = `paste-${Date.now()}-${hex}.${ext}`;

  const dataUri = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

  try {
    const result = await apiFetch<{ url: string }>(
      `/pages/${encodeURIComponent(pageId)}/images`,
      {
        method: 'POST',
        body: JSON.stringify({ dataUri, filename }),
      },
    );
    return result.url;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to upload image';
    toast.error(message);
    return null;
  }
}
