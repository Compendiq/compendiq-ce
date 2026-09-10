import { CLIENT_INFERENCE_MODEL_ID } from './worker-protocol';

const ROOT = 'compendiq-client-models';

async function rootDir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const storage = navigator.storage;
    if (!storage?.getDirectory) return null;
    const opfs = await storage.getDirectory();
    return opfs.getDirectoryHandle(ROOT, { create: true });
  } catch {
    return null;
  }
}

async function modelDir(modelId: string): Promise<FileSystemDirectoryHandle | null> {
  const root = await rootDir();
  if (!root) return null;
  return root.getDirectoryHandle(modelId, { create: true });
}

export async function putOpfsFile(modelId: string, file: string, data: Blob | BufferSource): Promise<boolean> {
  try {
    const dir = await modelDir(modelId);
    if (!dir) return false;
    const handle = await dir.getFileHandle(file.replaceAll('/', '__'), { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
    return true;
  } catch {
    return false;
  }
}

export async function hasOpfsModel(
  modelId: string = CLIENT_INFERENCE_MODEL_ID,
  required: string[] = ['config.json', 'tokenizer.json', 'onnx__model_q4.onnx'],
): Promise<boolean> {
  try {
    const dir = await modelDir(modelId);
    if (!dir) return false;
    const filesToCheck = required.length > 0
      ? required
      : ['config.json', 'tokenizer.json', 'onnx__model_q4.onnx'];
    for (const name of filesToCheck) {
      await dir.getFileHandle(name.replaceAll('/', '__'));
    }
    return true;
  } catch {
    return false;
  }
}

export async function clearOpfsModel(modelId: string = CLIENT_INFERENCE_MODEL_ID): Promise<void> {
  try {
    const root = await rootDir();
    if (!root) return;
    await root.removeEntry(modelId, { recursive: true });
  } catch {
    // ignore
  }
}

const ASSET_PATH = /\/api\/models\/client-assets\/([^/]+)\/(.+)$/;

export function parseClientAssetRequest(request: string): { modelId: string; file: string } | null {
  try {
    const path = request.includes('://') ? new URL(request).pathname : request;
    const match = ASSET_PATH.exec(path);
    if (!match?.[1] || !match[2]) return null;
    return { modelId: decodeURIComponent(match[1]), file: decodeURIComponent(match[2]) };
  } catch {
    return null;
  }
}

export async function matchOpfsAsset(request: string): Promise<Response | undefined> {
  const parsed = parseClientAssetRequest(request);
  if (!parsed) return undefined;
  try {
    const dir = await modelDir(parsed.modelId);
    if (!dir) return undefined;
    const handle = await dir.getFileHandle(parsed.file.replaceAll('/', '__'));
    const file = await handle.getFile();
    return new Response(file, {
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(file.size) },
    });
  } catch {
    return undefined;
  }
}

export async function putOpfsAsset(request: string, response: Response): Promise<void> {
  const parsed = parseClientAssetRequest(request);
  if (!parsed) return;
  const buffer = await response.clone().arrayBuffer();
  await putOpfsFile(parsed.modelId, parsed.file, buffer);
}

export const opfsTransformersCache = {
  match: matchOpfsAsset,
  put: putOpfsAsset,
};

