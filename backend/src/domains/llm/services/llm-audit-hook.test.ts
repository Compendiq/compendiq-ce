import { describe, it, expect, vi, beforeEach } from 'vitest';
import { emitLlmAudit, setLlmAuditHook, estimateTokens, type LlmAuditEntry } from './llm-audit-hook.js';

describe('llm-audit-hook', () => {
  const mockEntry: LlmAuditEntry = {
    userId: 'user-1',
    action: 'ask',
    model: 'qwen3:4b',
    provider: 'ollama',
    inputTokens: 100,
    outputTokens: 200,
    inputMessages: [{ role: 'user', contentLength: 50 }],
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
});
