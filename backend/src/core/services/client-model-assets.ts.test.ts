import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clientModelAssetsDir,
  listClientAssetManifest,
  parseBytesRange,
  resolveClientAssetPath,
  statClientAsset,
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

  it('hashes present files', async () => {
    const body = 'weights';
    await writeAsset('qwen2.5-0.5b-instruct-q4', 'config.json', body);
    const manifest = await listClientAssetManifest(true, tmp);
    const file = manifest.models
      .find((m) => m.id === 'qwen2.5-0.5b-instruct-q4')
      ?.files.find((f) => f.name === 'config.json');
    expect(file?.sha256).toBe(createHash('sha256').update(body).digest('hex'));
    expect(file?.bytes).toBe(Buffer.byteLength(body));
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
  });
});

describe('clientModelAssetsDir', () => {
  it('uses CLIENT_MODEL_ASSETS_DIR when set', () => {
    expect(clientModelAssetsDir()).toBe(path.resolve(tmp));
  });
});
