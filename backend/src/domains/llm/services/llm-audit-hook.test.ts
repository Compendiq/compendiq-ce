import { describe, it, expect, vi, beforeEach } from 'vitest';
import { emitLlmAudit, setLlmAuditHook, estimateTokens, fingerprintPrompt, type LlmAuditEntry } from './llm-audit-hook.js';

describe('llm-audit-hook', () => {
  const mockEntry: LlmAuditEntry = {
    userId: 'user-1',
    action: 'ask',
    model: 'qwen3:4b',
    provider: 'ollama',
    inputTokens: 100,
    outputTokens: 200,
    inputMessages: [{ role: 'user', contentLength: 50 }],
    promptHash: fingerprintPrompt([{ role: 'user', content: 'private prompt' }]),
    retrievedChunkIds: [],
    durationMs: 1500,
    status: 'success',
  };

  beforeEach(() => {
    setLlmAuditHook(null as unknown as (entry: LlmAuditEntry) => Promise<void>);
  });

  it('emitLlmAudit is a no-op when no hook registered', () => {
    emitLlmAudit(mockEntry);
  });

  it('emitLlmAudit calls registered hook', async () => {
    const hook = vi.fn().mockResolvedValue(undefined);
    setLlmAuditHook(hook);
    emitLlmAudit(mockEntry);
    await new Promise((r) => setTimeout(r, 10));
    expect(hook).toHaveBeenCalledWith(mockEntry);
  });

  it('hook errors are silently caught', async () => {
    const hook = vi.fn().mockRejectedValue(new Error('DB write failed'));
    setLlmAuditHook(hook);
    emitLlmAudit(mockEntry);
    await new Promise((r) => setTimeout(r, 10));
    expect(hook).toHaveBeenCalled();
  });

  it('estimateTokens returns reasonable values', () => {
    expect(estimateTokens('Hello, world!')).toBe(4);
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a'.repeat(100))).toBe(25);
  });

  it('fingerprints framed content, roles, order and structured parts', () => {
    const a = [{ role: 'system', content: 'ab' }, { role: 'user', content: 'cd' }];
    const hash = fingerprintPrompt(a);
    expect(fingerprintPrompt(a)).toBe(hash);
    expect(fingerprintPrompt([{ role: 'system', content: 'ac' }, a[1]!])).not.toBe(hash);
    expect(fingerprintPrompt([{ role: 'system', content: 'a' }, { role: 'user', content: 'bcd' }])).not.toBe(hash);
    expect(fingerprintPrompt([a[1]!, a[0]!])).not.toBe(hash);
    expect(fingerprintPrompt([{ role: 'user', content: 'ab' }, a[1]!])).not.toBe(hash);
    expect(fingerprintPrompt([{ role: 'user', content: [{ type: 'text', text: 'x' }] }]))
      .not.toBe(fingerprintPrompt([{ role: 'user', content: 'x' }]));
    expect(fingerprintPrompt([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:a' } }] }]))
      .not.toBe(fingerprintPrompt([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:b' } }] }]));
    expect(JSON.stringify(mockEntry)).not.toContain('private prompt');
  });
});
