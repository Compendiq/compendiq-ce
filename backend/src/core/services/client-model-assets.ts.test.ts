import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clientAssetEtag,
  clientModelAssetsDir,
  listClientAssetManifest,
  parseBytesRange,
  resolveClientAssetPath,
  statClientAsset,
  writeClientAssetChunk,
} from './client-model-assets.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'client-models-'));
  process.env.CLIENT_MODEL_ASSETS_DIR = tmp;
});

afterEach(async () => {
  delete process.env.CLIENT_MODEL_ASSETS_DIR;
  await fs.rm(tmp, { recursive: true, force: true });
});

async function writeAsset(modelId: string, file: string, body: string): Promise<string> {
  const abs = path.join(tmp, modelId, file);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body);
  return abs;
}

describe('resolveClientAssetPath (#1418 SPEC-033)', () => {
  it('accepts an allow-listed nested onnx file', () => {
    const resolved = resolveClientAssetPath('qwen2.5-0.5b-instruct-q4', 'onnx/model_q4.onnx', tmp);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.abs).toBe(path.join(tmp, 'qwen2.5-0.5b-instruct-q4', 'onnx', 'model_q4.onnx'));
    }
  });

  it('accepts a Hub local id for the q4 weight', () => {
    const resolved = resolveClientAssetPath(
      'onnx-community--Qwen2.5-0.5B-Instruct',
      'onnx/model_q4.onnx',
      tmp,
    );
    expect(resolved.ok).toBe(true);
  });

  it.each([
    ['qwen2.5-0.5b-instruct-q4', '../etc/passwd'],
    ['qwen2.5-0.5b-instruct-q4', '/etc/passwd'],
    ['qwen2.5-0.5b-instruct-q4', 'onnx\\model_q4.onnx'],
    ['qwen2.5-0.5b-instruct-q4', 'onnx/../../secret'],
    ['qwen2.5-0.5b-instruct-q4', ''],
    ['qwen2.5-0.5b-instruct-q4', 'not-on-the-list.bin'],
    ['local', 'x'],
    ['page-icons', 'mark.png'],
    ['client-models', 'x'],
  ])('rejects %s / %s', (modelId, file) => {
    expect(resolveClientAssetPath(modelId, file, tmp).ok).toBe(false);
  });
});

describe('listClientAssetManifest (#1418 SPEC-032)', () => {
  it('returns empty file lists when the directory is missing — never throws', async () => {
    const manifest = await listClientAssetManifest(false, path.join(tmp, 'absent'));
    expect(manifest.enabled).toBe(false);
    expect(manifest.models).toHaveLength(3);
    expect(manifest.models.every((m) => m.files.length === 0 && !m.installed)).toBe(true);
  });

  it('keeps hunspell available when the SLM flag is off and marks onnx unavailable', async () => {
    await writeAsset('hunspell-en_US', 'en_US.dic', 'DIC');
    await writeAsset('hunspell-en_US', 'en_US.aff', 'AFF');
    await writeAsset('qwen2.5-0.5b-instruct-q4', 'config.json', '{}');
    const manifest = await listClientAssetManifest(false, tmp);
    const hunspell = manifest.models.find((m) => m.id === 'hunspell-en_US');
    const onnx = manifest.models.find((m) => m.id === 'qwen2.5-0.5b-instruct-q4');
    expect(hunspell?.available).toBe(true);
    expect(hunspell?.installed).toBe(true);
    expect(onnx?.available).toBe(false);
  });

  it('lists size without hashing contents', async () => {
    const body = 'weights';
    await writeAsset('qwen2.5-0.5b-instruct-q4', 'config.json', body);
    const manifest = await listClientAssetManifest(true, tmp);
    const file = manifest.models
      .find((m) => m.id === 'qwen2.5-0.5b-instruct-q4')
      ?.files.find((f) => f.name === 'config.json');
    expect(file?.bytes).toBe(Buffer.byteLength(body));
    expect(file?.sha256).toBeUndefined();
  });

  it('lists a Hub install with repo and activeModelId', async () => {
    await writeAsset('onnx-community--Qwen2.5-0.5B-Instruct', 'config.json', '{}');
    await writeAsset('onnx-community--Qwen2.5-0.5B-Instruct', 'tokenizer.json', '{}');
    await writeAsset('onnx-community--Qwen2.5-0.5B-Instruct', 'onnx/model_q4.onnx', 'ONNX');
    const manifest = await listClientAssetManifest(true, tmp);
    const onnx = manifest.models.find((m) => m.id === 'onnx-community--Qwen2.5-0.5B-Instruct');
    expect(onnx).toMatchObject({
      kind: 'onnx',
      installed: true,
      available: true,
      repo: 'onnx-community/Qwen2.5-0.5B-Instruct',
      active: true,
    });
    expect(manifest.activeModelId).toBe('onnx-community--Qwen2.5-0.5B-Instruct');
  });
});

describe('clientAssetEtag', () => {
  it('is a quoted mtime-size pair so a replaced file is a new cache entry', () => {
    expect(clientAssetEtag(16, 255)).toBe('"10-ff"');
  });
});

describe('parseBytesRange', () => {
  it('parses a closed range', () => {
    expect(parseBytesRange('bytes=0-3', 10)).toEqual({ start: 0, end: 3 });
  });

  it('rejects an unsatisfiable range', () => {
    expect(parseBytesRange('bytes=50-60', 10)).toBe('unsatisfiable');
  });
});

describe('statClientAsset', () => {
  it('returns null for a missing allow-listed file', async () => {
    expect(await statClientAsset('hunspell-de_DE', 'de_DE.dic', tmp)).toBeNull();
  });

  it('stats a present file', async () => {
    await writeAsset('hunspell-de_DE', 'de_DE.dic', 'de');
    const found = await statClientAsset('hunspell-de_DE', 'de_DE.dic', tmp);
    expect(found?.size).toBe(2);
    expect(found?.mtimeMs).toBeGreaterThan(0);
  });
});

describe('clientModelAssetsDir', () => {
  it('uses CLIENT_MODEL_ASSETS_DIR when set', () => {
    expect(clientModelAssetsDir()).toBe(path.resolve(tmp));
  });
});

describe('writeClientAssetChunk', () => {
  it('writes a small Hunspell file in one shot', async () => {
    const result = await writeClientAssetChunk({
      modelId: 'hunspell-en_US',
      file: 'en_US.dic',
      body: Buffer.from('hello'),
      root: tmp,
    });
    expect(result.complete).toBe(true);
    expect(await fs.readFile(path.join(tmp, 'hunspell-en_US', 'en_US.dic'), 'utf8')).toBe('hello');
  });

  it('assembles q4 chunks then exposes the file on the manifest', async () => {
    const id = 'onnx-community--Qwen2.5-0.5B-Instruct';
    await writeClientAssetChunk({
      modelId: id, file: 'config.json', body: Buffer.from('{}'), root: tmp,
    });
    await writeClientAssetChunk({
      modelId: id, file: 'tokenizer.json', body: Buffer.from('{}'), root: tmp,
    });
    await writeClientAssetChunk({
      modelId: id, file: 'onnx/model_q4.onnx', body: Buffer.from('AB'), start: 0, total: 4, root: tmp,
    });
    await writeClientAssetChunk({
      modelId: id, file: 'onnx/model_q4.onnx', body: Buffer.from('CD'), start: 2, total: 4, root: tmp,
    });
    const manifest = await listClientAssetManifest(true, tmp);
    expect(manifest.activeModelId).toBe(id);
    expect(await fs.readFile(path.join(tmp, id, 'onnx', 'model_q4.onnx'), 'utf8')).toBe('ABCD');
  });

  it('rejects a traversal file name', async () => {
    await expect(writeClientAssetChunk({
      modelId: 'hunspell-en_US',
      file: '../secret',
      body: Buffer.from('x'),
      root: tmp,
    })).rejects.toThrow(/not allowed/i);
  });
});
