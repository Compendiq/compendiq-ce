/**
 * Same-origin client-model assets (#1418).
 *
 * Operators copy ONNX / Hunspell files onto the attachments volume.
 * The browser never talks to huggingface.co. Path join is resolve + prefix
 * check; anything off the closed allow-list is a 404, not a 500.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  CLIENT_ASSET_FILES,
  CLIENT_ASSET_KIND,
  CLIENT_ASSET_REQUIRED_FILES,
  ClientAssetIdSchema,
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

export function isAllowedClientAssetFile(modelId: ClientAssetId, file: string): boolean {
  return (CLIENT_ASSET_FILES[modelId] as readonly string[]).includes(file);
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
  if (isUnsafeFileToken(fileRaw) || !isAllowedClientAssetFile(modelId, fileRaw)) {
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

async function hashFile(abs: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(abs);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function listClientAssetManifest(
  slmEnabled: boolean,
  root = clientModelAssetsDir(),
): Promise<ClientAssetManifest> {
  const models: ClientAssetManifest['models'] = [];
  for (const id of ClientAssetIdSchema.options) {
    const kind = CLIENT_ASSET_KIND[id];
    const available = kind === 'hunspell' || slmEnabled;
    const files: ClientAssetManifest['models'][number]['files'] = [];
    for (const name of CLIENT_ASSET_FILES[id]) {
      const resolved = resolveClientAssetPath(id, name, root);
      if (!resolved.ok) continue;
      try {
        const stat = await fs.stat(resolved.abs);
        if (!stat.isFile()) continue;
        files.push({
          name,
          bytes: stat.size,
          sha256: await hashFile(resolved.abs),
        });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          // Unreadable is not a missing directory — skip this file, keep listing.
          continue;
        }
      }
    }
    const present = new Set(files.map((f) => f.name));
    const installed = CLIENT_ASSET_REQUIRED_FILES[id].every((name) => present.has(name));
    models.push({
      id,
      kind,
      bytes: files.reduce((sum, f) => sum + f.bytes, 0),
      installed,
      available,
      files,
    });
  }
  return { enabled: slmEnabled, models };
}

export async function statClientAsset(
  modelId: string,
  file: string,
  root = clientModelAssetsDir(),
): Promise<{ abs: string; size: number } | null> {
  const resolved = resolveClientAssetPath(modelId, file, root);
  if (!resolved.ok) return null;
  try {
    const stat = await fs.stat(resolved.abs);
    if (!stat.isFile()) return null;
    return { abs: resolved.abs, size: stat.size };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}
