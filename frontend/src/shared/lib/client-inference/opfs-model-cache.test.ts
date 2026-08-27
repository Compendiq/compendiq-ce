import { describe, expect, it } from 'vitest';
import { parseClientAssetRequest } from './opfs-model-cache';

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
