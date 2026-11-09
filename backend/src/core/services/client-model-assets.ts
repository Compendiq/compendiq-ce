/**
 * Same-origin client-model assets (#1418).
 *
 * Operators copy ONNX / Hunspell files onto the attachments volume.
 * The browser never talks to huggingface.co. Path join is resolve + prefix
 * check; anything off the closed allow-list is a 404, not a 500.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  CLIENT_ASSET_UPLOAD_CHUNK_BYTES,
  MAX_HUNSPELL_ASSET_BYTES,
  ClientAssetIdSchema,
  HUNSPELL_ASSET_IDS,
  HubLocalAssetIdSchema,
  LEGACY_CLIENT_MODEL_ID,
  MAX_CLIENT_ONNX_Q4_BYTES,
  clientAssetFiles,
  clientAssetKind,
  clientAssetRequiredFiles,
  localAssetIdToHfRepo,
  type ClientAssetId,
  type ClientAssetManifest,
} from '@compendiq/contracts';
import { CLIENT_MODEL_STORE_DIRNAME } from './attachment-store.js';
import { listPolicyClientAssets } from './client-model-asset-policy.js';

const ATTACHMENTS_BASE = process.env.ATTACHMENTS_DIR ?? 'data/attachments';

export function clientModelAssetsDir(): string {
  if (process.env.CLIENT_MODEL_ASSETS_DIR) {
    return path.resolve(process.env.CLIENT_MODEL_ASSETS_DIR);
  }
  const attachments = path.resolve(process.env.ATTACHMENTS_DIR ?? ATTACHMENTS_BASE);
  return path.join(path.dirname(attachments), CLIENT_MODEL_STORE_DIRNAME);
}

function isUnsafeFileToken(file: string): boolean {
  if (!file || file.includes('\0') || file.includes('\\')) return true;
  if (path.isAbsolute(file)) return true;
  const parts = file.split('/');
  return parts.some((part) => part.length === 0 || part === '.' || part === '..');
}

export type ResolvedClientAsset =
  | { ok: true; abs: string; modelId: ClientAssetId; file: string }
  | { ok: false };

export function resolveClientAssetPath(
  modelIdRaw: string,
  fileRaw: string,
  root = clientModelAssetsDir(),
): ResolvedClientAsset {
  const modelParsed = ClientAssetIdSchema.safeParse(modelIdRaw);
  if (!modelParsed.success) return { ok: false };
  const modelId = modelParsed.data;
  if (isUnsafeFileToken(fileRaw) || !clientAssetFiles(modelId).includes(fileRaw)) {
    return { ok: false };
  }
  const rootResolved = path.resolve(root);
  const abs = path.resolve(rootResolved, modelId, fileRaw);
  const prefix = rootResolved + path.sep;
  if (abs !== rootResolved && !abs.startsWith(prefix)) return { ok: false };
  return { ok: true, abs, modelId, file: fileRaw };
}

export type ByteRange = { start: number; end: number };

export function parseBytesRange(
  header: string | undefined,
  size: number,
): ByteRange | 'full' | 'unsatisfiable' {
  if (!header) return 'full';
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return 'unsatisfiable';
  const [, startRaw, endRaw] = match;
  if (startRaw === '' && endRaw === '') return 'unsatisfiable';
  if (startRaw === '') {
    const suffix = Number(endRaw);
    if (!Number.isInteger(suffix) || suffix <= 0) return 'unsatisfiable';
    if (size === 0) return 'unsatisfiable';
    const start = Math.max(0, size - suffix);
    return { start, end: size - 1 };
  }
  const start = Number(startRaw);
  const end = endRaw === '' ? size - 1 : Number(endRaw);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
    return 'unsatisfiable';
  }
  return { start, end: Math.min(end, size - 1) };
}

export async function listClientAssetManifest(
  slmEnabled: boolean,
  root = clientModelAssetsDir(),
): Promise<ClientAssetManifest> {
  const ids: ClientAssetId[] = [LEGACY_CLIENT_MODEL_ID, ...HUNSPELL_ASSET_IDS];
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const parsed = HubLocalAssetIdSchema.safeParse(ent.name);
      if (parsed.success && !ids.includes(parsed.data)) ids.push(parsed.data);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const models: ClientAssetManifest['models'] = [];
  for (const id of ids) {
    const kind = clientAssetKind(id);
    const available = kind === 'hunspell' || slmEnabled;
    const files: ClientAssetManifest['models'][number]['files'] = [];
    for (const name of clientAssetFiles(id)) {
      const resolved = resolveClientAssetPath(id, name, root);
      if (!resolved.ok) continue;
      try {
        const stat = await fs.stat(resolved.abs);
        if (!stat.isFile()) continue;
        files.push({ name, bytes: stat.size });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') continue;
      }
    }
    const present = new Set(files.map((f) => f.name));
    const installed = clientAssetRequiredFiles(id).every((name) => present.has(name));
    const repo = HubLocalAssetIdSchema.safeParse(id).success
      ? localAssetIdToHfRepo(id)
      : undefined;
    models.push({
      id,
      kind,
      bytes: files.reduce((sum, f) => sum + f.bytes, 0),
      installed,
      available,
      files,
      ...(repo ? { repo } : {}),
    });
  }

  for (const registered of await listPolicyClientAssets(slmEnabled)) {
    const index = models.findIndex((model) => model.id === registered.id);
    if (index === -1) models.push(registered);
    else models[index] = registered;
  }

  const installedOnnx = models.filter((m) => m.kind === 'onnx' && m.installed);
  const hubInstalled = installedOnnx.filter((m) => m.id !== LEGACY_CLIENT_MODEL_ID);
  const activeModelId = hubInstalled[0]?.id ?? installedOnnx[0]?.id ?? null;
  if (activeModelId) {
    const active = models.find((m) => m.id === activeModelId);
    if (active) active.active = true;
  }
  return { enabled: slmEnabled, activeModelId, models };
}

export function clientAssetEtag(mtimeMs: number, size: number): string {
  return `"${mtimeMs.toString(16)}-${size.toString(16)}"`;
}

export async function statClientAsset(
  modelId: string,
  file: string,
  root = clientModelAssetsDir(),
): Promise<{ abs: string; size: number; mtimeMs: number } | null> {
  const resolved = resolveClientAssetPath(modelId, file, root);
  if (!resolved.ok) return null;
  try {
    const stat = await fs.stat(resolved.abs);
    if (!stat.isFile()) return null;
    return { abs: resolved.abs, size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

function maxUploadBytes(modelId: string): number {
  return clientAssetKind(modelId) === 'hunspell'
    ? MAX_HUNSPELL_ASSET_BYTES
    : MAX_CLIENT_ONNX_Q4_BYTES;
}

export async function writeClientAssetChunk(opts: {
  modelId: string;
  file: string;
  body: Buffer;
  start?: number;
  total?: number;
  root?: string;
}): Promise<{ complete: boolean; bytes: number }> {
  const resolved = resolveClientAssetPath(opts.modelId, opts.file, opts.root);
  if (!resolved.ok) throw new Error('File is not allowed');
  if (opts.body.length > CLIENT_ASSET_UPLOAD_CHUNK_BYTES) {
    throw new Error('Chunk exceeds 8 MiB');
  }
  const start = opts.start ?? 0;
  const total = opts.total ?? (start + opts.body.length);
  if (!Number.isInteger(start) || start < 0 || start + opts.body.length > total) {
    throw new Error('Invalid chunk range');
  }
  if (total > maxUploadBytes(resolved.modelId)) {
    throw new Error(
      clientAssetKind(resolved.modelId) === 'hunspell'
        ? 'Upload exceeds 32 MiB'
        : 'Upload exceeds 1 GiB',
    );
  }
  await fs.mkdir(path.dirname(resolved.abs), { recursive: true });
  return serializeUpload(resolved.abs, () =>
    writeContiguousChunk(resolved.abs, opts.body, start, total));
}

// Concurrent PUTs for one file would interleave the `.part` bytes and its
// session record; uploads of the same target run one chunk at a time.
const uploadQueues = new Map<string, Promise<unknown>>();

async function serializeUpload<T>(key: string, run: () => Promise<T>): Promise<T> {
  const current = (uploadQueues.get(key) ?? Promise.resolve()).catch(() => {}).then(run);
  uploadQueues.set(key, current);
  try {
    return await current;
  } finally {
    if (uploadQueues.get(key) === current) uploadQueues.delete(key);
  }
}

/**
 * Bytes the current upload session has received contiguously from 0, or null
 * when there is no session for this `total` (#1784). The `.part` file only
 * ever grows by contiguous writes, so its size is the verified coverage.
 */
async function sessionCoverage(part: string, session: string, total: number): Promise<number | null> {
  try {
    const record = JSON.parse(await fs.readFile(session, 'utf8')) as { total?: unknown };
    if (record.total !== total) return null;
    return (await fs.stat(part)).size;
  } catch {
    return null;
  }
}

/**
 * Ranged uploads must arrive contiguously (#1784). A chunk at byte 0 starts a
 * fresh session, discarding any earlier `.part`; every later chunk must start
 * at or before the bytes already received for the same `total`. The installed
 * file is replaced only by renaming a fully covered `.part`, so a gap or an
 * interrupted upload can never publish zero-filled or inherited bytes.
 */
async function writeContiguousChunk(
  abs: string,
  body: Buffer,
  start: number,
  total: number,
): Promise<{ complete: boolean; bytes: number }> {
  const part = `${abs}.part`;
  const session = `${part}.json`;
  const end = start + body.length;
  let received: number;
  if (start === 0) {
    await fs.rm(session, { force: true });
    await fs.writeFile(part, body);
    received = end;
    if (received < total) await fs.writeFile(session, JSON.stringify({ total }));
  } else {
    const covered = await sessionCoverage(part, session, total);
    if (covered === null || start > covered) throw new Error('Upload range is not contiguous');
    const handle = await fs.open(part, 'r+');
    try {
      await handle.write(body, 0, body.length, start);
    } finally {
      await handle.close();
    }
    received = Math.max(covered, end);
  }
  if (received < total) return { complete: false, bytes: received };
  await fs.rename(part, abs);
  await fs.rm(session, { force: true });
  return { complete: true, bytes: total };
}
