import { describe, expect, it } from 'vitest';
import { ClientModelIdSchema } from '@compendiq/contracts';

describe('client inference isolation (#1418 SPEC-039/011/016)', () => {
  it('admits the legacy slot and Hub local ids', () => {
    expect(ClientModelIdSchema.parse('qwen2.5-0.5b-instruct-q4')).toBe('qwen2.5-0.5b-instruct-q4');
    expect(ClientModelIdSchema.parse('onnx-community--Qwen2.5-0.5B-Instruct')).toBe(
      'onnx-community--Qwen2.5-0.5B-Instruct',
    );
    expect(() => ClientModelIdSchema.parse('gpt2')).toThrow();
  });
});
