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
  ClientAssetIdSchema,
  HUNSPELL_ASSET_IDS,
  HubLocalAssetIdSchema,
  LEGACY_CLIENT_MODEL_ID,
  clientAssetFiles,
  clientAssetKind,
  clientAssetRequiredFiles,
  localAssetIdToHfRepo,
  type ClientAssetId,
  type ClientAssetManifest,
} from '@compendiq/contracts';
import { CLIENT_MODEL_STORE_DIRNAME } from './attachment-store.js';

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

export const CLIENT_ASSET_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

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
  await fs.mkdir(path.dirname(resolved.abs), { recursive: true });
  if (start === 0 && start + opts.body.length === total) {
    await fs.writeFile(resolved.abs, opts.body);
    return { complete: true, bytes: total };
  }
  const part = `${resolved.abs}.part`;
  const handle = await fs.open(part, 'a+');
  try {
    await handle.truncate(total);
    await handle.write(opts.body, 0, opts.body.length, start);
  } finally {
    await handle.close();
  }
  const complete = start + opts.body.length === total;
  if (complete) await fs.rename(part, resolved.abs);
  return { complete, bytes: start + opts.body.length };
}
