import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  CLIENT_ONNX_INSTALL_FILES,
  CLIENT_ONNX_REQUIRED_FILES,
  ClientAssetIdSchema,
  ClientAssetInspectSchema,
  ClientAssetSearchResponseSchema,
  HfRepoIdSchema,
  HUNSPELL_ASSET_IDS,
  HunspellAssetIdSchema,
  MAX_CLIENT_ONNX_Q4_BYTES,
  RECOMMENDED_CLIENT_MODELS,
  hfRepoToLocalAssetId,
  type ClientAssetInspect,
  type ClientAssetInstallStatus,
  type ClientAssetSearchResponse,
  type HunspellAssetId,
} from '@compendiq/contracts';
import { clientModelAssetsDir } from './client-model-assets.js';

const HUB_URL = 'https://huggingface.co';

export type HubFetch = typeof fetch;

const REQUIRED_ONNX = new Set<string>(CLIENT_ONNX_REQUIRED_FILES);

let installStatus: ClientAssetInstallStatus = {
  status: 'idle',
  loaded: 0,
  total: 0,
  error: null,
};

export function getClientModelInstallStatus(): ClientAssetInstallStatus {
  return installStatus;
}

export function resetClientModelInstallForTests(): void {
  installStatus = { status: 'idle', loaded: 0, total: 0, error: null };
}

export async function searchClientModels(
  query: string,
  opts: { fetch?: HubFetch } = {},
): Promise<ClientAssetSearchResponse> {
  const q = query.trim();
  if (!q) {
    return ClientAssetSearchResponseSchema.parse({
      models: RECOMMENDED_CLIENT_MODELS.map((m) => ({
        repo: m.repo,
        downloads: 0,
        likes: 0,
        recommended: true,
      })),
    });
  }

  const url = new URL(`${HUB_URL}/api/models`);
  url.searchParams.set('search', q);
  url.searchParams.set('pipeline_tag', 'text-generation');
  url.searchParams.append('filter', 'transformers.js');
  url.searchParams.set('sort', 'downloads');
  url.searchParams.set('limit', '20');

  const res = await (opts.fetch ?? fetch)(url);
  if (!res.ok) {
    throw new Error(`Hugging Face search failed (${res.status})`);
  }
  const raw = await res.json() as Array<{ id?: string; downloads?: number; likes?: number }>;
  const models = [];
  for (const item of raw) {
    const parsed = HfRepoIdSchema.safeParse(item.id);
    if (!parsed.success) continue;
    models.push({
      repo: parsed.data,
      downloads: Math.max(0, Math.trunc(item.downloads ?? 0)),
      likes: Math.max(0, Math.trunc(item.likes ?? 0)),
      recommended: RECOMMENDED_CLIENT_MODELS.some((m) => m.repo === parsed.data),
    });
  }
  return ClientAssetSearchResponseSchema.parse({ models });
}

type HubTreeEntry = {
  path?: string;
  type?: string;
  size?: number;
  lfs?: { size?: number; oid?: string };
};

async function loadOnnxTree(
  repo: string,
  fetchImpl: HubFetch,
): Promise<{ entries: HubTreeEntry[]; error?: string }> {
  const url = `${HUB_URL}/api/models/${repo}/tree/main/onnx`;
  const res = await fetchImpl(url);
  if (!res.ok) {
    return {
      entries: [],
      error: res.status === 404 ? 'Repository has no onnx/ tree' : `Hugging Face inspect failed (${res.status})`,
    };
  }
  const entries = await res.json() as HubTreeEntry[];
  return { entries: Array.isArray(entries) ? entries : [] };
}

export async function inspectClientModel(
  repo: string,
  opts: { fetch?: HubFetch } = {},
): Promise<ClientAssetInspect> {
  const parsedRepo = HfRepoIdSchema.parse(repo);
  const { entries, error } = await loadOnnxTree(parsedRepo, opts.fetch ?? fetch);
  if (error) {
    return ClientAssetInspectSchema.parse({
      repo: parsedRepo,
      hasQ4: false,
      bytes: 0,
      ok: false,
      reason: error,
    });
  }
  const q4 = entries.find((e) => e.path === 'onnx/model_q4.onnx' && e.type !== 'directory');
  const bytes = Math.max(0, Math.trunc(q4?.lfs?.size ?? q4?.size ?? 0));
  const hasQ4 = Boolean(q4);
  const ok = hasQ4 && bytes <= MAX_CLIENT_ONNX_Q4_BYTES;
  return ClientAssetInspectSchema.parse({
    repo: parsedRepo,
    hasQ4,
    bytes,
    ok,
    ...(!ok ? {
      reason: !hasQ4
        ? 'No onnx/model_q4.onnx in this repo'
        : 'q4 weights exceed 1 GiB',
    } : {}),
  });
}

export async function installClientModel(
  repo: string,
  opts: { fetch?: HubFetch; root?: string } = {},
): Promise<void> {
  if (installStatus.status === 'running') {
    throw new Error('An install is already running');
  }
  const parsedRepo = HfRepoIdSchema.parse(repo);
  const fetchImpl = opts.fetch ?? fetch;
  const root = opts.root ?? clientModelAssetsDir();
  const localId = hfRepoToLocalAssetId(parsedRepo);
  installStatus = { status: 'running', repo: parsedRepo, loaded: 0, total: 0, error: null };

  const { entries, error } = await loadOnnxTree(parsedRepo, fetchImpl);
  const q4 = entries.find((e) => e.path === 'onnx/model_q4.onnx' && e.type !== 'directory');
  const bytes = Math.max(0, Math.trunc(q4?.lfs?.size ?? q4?.size ?? 0));
  if (error || !q4 || bytes > MAX_CLIENT_ONNX_Q4_BYTES) {
    const reason = error
      ?? (!q4 ? 'No onnx/model_q4.onnx in this repo' : 'q4 weights exceed 1 GiB');
    installStatus = { status: 'failed', repo: parsedRepo, loaded: 0, total: 0, error: reason };
    throw new Error(reason);
  }

  const expectedSha = q4.lfs?.oid?.toLowerCase();
  installStatus = {
    status: 'running',
    repo: parsedRepo,
    loaded: 0,
    total: bytes,
    error: null,
  };

  const partial = path.join(root, `.partial-${localId}`);
  await fs.rm(partial, { recursive: true, force: true });
  await fs.mkdir(partial, { recursive: true });

  try {
    for (const file of CLIENT_ONNX_INSTALL_FILES) {
      const url = `${HUB_URL}/${parsedRepo}/resolve/main/${file}`;
      const res = await fetchImpl(url);
      if (res.status === 404) {
        if (REQUIRED_ONNX.has(file)) throw new Error(`Missing required file ${file}`);
        continue;
      }
      if (!res.ok || !res.body) throw new Error(`Download failed for ${file} (${res.status})`);
      const abs = path.join(partial, file);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      if (file === 'onnx/model_q4.onnx') {
        const hash = createHash('sha256');
        let loaded = 0;
        const hasher = new Transform({
          transform(chunk, _enc, cb) {
            loaded += chunk.length;
            if (loaded > MAX_CLIENT_ONNX_Q4_BYTES) {
              cb(new Error('q4 weights exceed 1 GiB'));
              return;
            }
            hash.update(chunk);
            installStatus = { ...installStatus, loaded };
            cb(null, chunk);
          },
        });
        await pipeline(Readable.fromWeb(res.body as never), hasher, createWriteStream(abs));
        if (expectedSha && expectedSha.length === 64) {
          if (hash.digest('hex') !== expectedSha) {
            throw new Error(`sha256 mismatch for onnx/model_q4.onnx`);
          }
        }
      } else {
        await pipeline(Readable.fromWeb(res.body as never), createWriteStream(abs));
      }
    }

    const dest = path.join(root, localId);
    await fs.rm(dest, { recursive: true, force: true });
    await fs.rename(partial, dest);
    await removeOtherOnnxDirs(root, localId);
    installStatus = {
      status: 'complete',
      repo: parsedRepo,
      loaded: installStatus.loaded,
      total: installStatus.total,
      error: null,
    };
  } catch (err) {
    await fs.rm(partial, { recursive: true, force: true });
    const message = err instanceof Error ? err.message : 'Install failed';
    installStatus = {
      status: 'failed',
      repo: parsedRepo,
      loaded: installStatus.loaded,
      total: installStatus.total,
      error: message,
    };
    throw err instanceof Error ? err : new Error(message);
  }
}

async function removeOtherOnnxDirs(root: string, keepId: string): Promise<void> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  const hunspell: Record<string, true> = {
    'hunspell-en_US': true,
    'hunspell-de_DE': true,
  };
  for (const name of entries) {
    if (name === keepId || hunspell[name] || name.startsWith('.')) continue;
    const parsed = ClientAssetIdSchema.safeParse(name);
    if (!parsed.success) continue;
    if (HUNSPELL_ASSET_IDS.includes(name as typeof HUNSPELL_ASSET_IDS[number])) continue;
    await fs.rm(path.join(root, name), { recursive: true, force: true });
  }
}

export const HUNSPELL_SOURCES: Record<HunspellAssetId, {
  label: string;
  files: Array<{ name: string; url: string }>;
}> = {
  'hunspell-en_US': {
    label: 'English (US)',
    files: [
      {
        name: 'en_US.aff',
        url: 'https://raw.githubusercontent.com/wooorm/dictionaries/main/dictionaries/en/index.aff',
      },
      {
        name: 'en_US.dic',
        url: 'https://raw.githubusercontent.com/wooorm/dictionaries/main/dictionaries/en/index.dic',
      },
    ],
  },
  'hunspell-de_DE': {
    label: 'German (DE)',
    files: [
      {
        name: 'de_DE.aff',
        url: 'https://raw.githubusercontent.com/wooorm/dictionaries/main/dictionaries/de/index.aff',
      },
      {
        name: 'de_DE.dic',
        url: 'https://raw.githubusercontent.com/wooorm/dictionaries/main/dictionaries/de/index.dic',
      },
    ],
  },
};

export async function installHunspellModel(
  id: HunspellAssetId,
  opts: { fetch?: HubFetch; root?: string } = {},
): Promise<void> {
  const parsedId = HunspellAssetIdSchema.parse(id);
  const source = HUNSPELL_SOURCES[parsedId];
  if (!source) throw new Error(`Unknown hunspell asset: ${id}`);
  const fetchImpl = opts.fetch ?? fetch;
  const root = opts.root ?? clientModelAssetsDir();
  const partial = path.join(root, `.partial-${parsedId}`);
  await fs.rm(partial, { recursive: true, force: true });
  await fs.mkdir(partial, { recursive: true });

  try {
    for (const file of source.files) {
      const res = await fetchImpl(file.url);
      if (!res.ok || !res.body) {
        throw new Error(`Download failed for ${file.name} (${res.status})`);
      }
      const abs = path.join(partial, file.name);
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(abs));
    }
    const dest = path.join(root, parsedId);
    await fs.rm(dest, { recursive: true, force: true });
    await fs.rename(partial, dest);
  } catch (err) {
    await fs.rm(partial, { recursive: true, force: true });
    throw err instanceof Error ? err : new Error(String(err));
  }
}
