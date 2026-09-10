import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearOpfsModel, hasOpfsModel, parseClientAssetRequest } from './opfs-model-cache';
describe('parseClientAssetRequest', () => {
  it('maps a transformers.js remote URL onto the OPFS file path', () => {
    expect(parseClientAssetRequest(
      'https://kb.example/api/models/client-assets/qwen2.5-0.5b-instruct-q4/onnx/model_q4.onnx',
    )).toEqual({
      modelId: 'qwen2.5-0.5b-instruct-q4',
      file: 'onnx/model_q4.onnx',
    });
  });

  it('rejects a path outside the asset prefix', () => {
    expect(parseClientAssetRequest('https://kb.example/api/attachments/1/x.bin')).toBeNull();
  });
});

describe('hasOpfsModel and clearOpfsModel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns false when navigator.storage is missing', async () => {
    vi.stubGlobal('navigator', {});
    expect(await hasOpfsModel('test-model')).toBe(false);
  });

  it('returns true when all required files are present in OPFS', async () => {
    const files = new Set(['config.json', 'tokenizer.json', 'onnx__model_q4.onnx']);
    const modelHandle = {
      getFileHandle: vi.fn(async (name: string) => {
        if (files.has(name)) return {} as FileSystemFileHandle;
        throw new Error('Not found');
      }),
    };
    const rootHandle = {
      getDirectoryHandle: vi.fn(async () => modelHandle),
    };
    const opfsHandle = {
      getDirectoryHandle: vi.fn(async () => rootHandle),
    };
    const storage = {
      getDirectory: vi.fn(async () => opfsHandle),
    };
    vi.stubGlobal('navigator', { storage });

    expect(await hasOpfsModel('test-model')).toBe(true);
    // Also supports file names containing slashes (e.g. onnx/model_q4.onnx)
    expect(await hasOpfsModel('test-model', ['config.json', 'tokenizer.json', 'onnx/model_q4.onnx'])).toBe(true);
  });

  it('returns false when a required file is missing from OPFS', async () => {
    const files = new Set(['config.json', 'tokenizer.json']);
    const modelHandle = {
      getFileHandle: vi.fn(async (name: string) => {
        if (files.has(name)) return {} as FileSystemFileHandle;
        throw new Error('Not found');
      }),
    };
    const rootHandle = {
      getDirectoryHandle: vi.fn(async () => modelHandle),
    };
    const opfsHandle = {
      getDirectoryHandle: vi.fn(async () => rootHandle),
    };
    const storage = {
      getDirectory: vi.fn(async () => opfsHandle),
    };
    vi.stubGlobal('navigator', { storage });

    expect(await hasOpfsModel('test-model')).toBe(false);
  });

  it('clears the model directory from OPFS', async () => {
    const removeEntry = vi.fn(async () => {});
    const rootHandle = {
      getDirectoryHandle: vi.fn(async () => ({})),
      removeEntry,
    };
    const opfsHandle = {
      getDirectoryHandle: vi.fn(async () => rootHandle),
    };
    const storage = {
      getDirectory: vi.fn(async () => opfsHandle),
    };
    vi.stubGlobal('navigator', { storage });

    await clearOpfsModel('test-model');
    expect(removeEntry).toHaveBeenCalledWith('test-model', { recursive: true });
  });
});
