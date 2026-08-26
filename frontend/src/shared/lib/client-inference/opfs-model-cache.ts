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
    for (const name of required) {
      await dir.getFileHandle(name);
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
