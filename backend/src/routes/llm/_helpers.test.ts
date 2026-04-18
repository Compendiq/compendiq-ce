import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the admin-settings-service.getUsecaseLlmAssignment so the helper can be
// exercised without a DB. (Issue #217 — chat usecase resolver.)
const mockGet = vi.fn();
vi.mock('../../core/services/admin-settings-service.js', () => ({
  getUsecaseLlmAssignment: (...args: unknown[]) => mockGet(...args),
}));

// Import after the mock so the mocked getUsecaseLlmAssignment is used.
import { resolveChatAssignment } from './_helpers.js';

describe('resolveChatAssignment (issue #217)', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it('returns body model when no usecase override exists (source=shared)', async () => {
    mockGet.mockResolvedValue({
      provider: 'ollama',
      model: 'shared-model',
      source: { provider: 'shared', model: 'shared' },
    });

    const r = await resolveChatAssignment('body-model');

    expect(mockGet).toHaveBeenCalledWith('chat');
    expect(r.provider).toBe('ollama');
    expect(r.model).toBe('body-model');
    expect(r.hasUsecaseOverride).toBe(false);
    expect(r.assignment.source.provider).toBe('shared');
  });

  it('locks model when source.model === "usecase" (admin pinned both)', async () => {
    mockGet.mockResolvedValue({
      provider: 'openai',
      model: 'admin-pinned',
      source: { provider: 'usecase', model: 'usecase' },
    });

    const r = await resolveChatAssignment('body-model');

    expect(r.provider).toBe('openai');
    expect(r.model).toBe('admin-pinned'); // body ignored — admin locked model
    expect(r.hasUsecaseOverride).toBe(true);
  });

  it('allows body model when only provider is pinned (source.model !== "usecase")', async () => {
    mockGet.mockResolvedValue({
      provider: 'openai',
      model: 'shared-fallback',
      source: { provider: 'usecase', model: 'shared' },
    });

    const r = await resolveChatAssignment('user-picked');

    expect(r.provider).toBe('openai');
    expect(r.model).toBe('user-picked'); // body wins when model not pinned
    expect(r.hasUsecaseOverride).toBe(true);
  });

  it('falls back to resolver model when body model is empty and no usecase model', async () => {
    mockGet.mockResolvedValue({
      provider: 'ollama',
      model: 'shared-fallback',
      source: { provider: 'shared', model: 'shared' },
    });

    const r = await resolveChatAssignment('');

    expect(r.model).toBe('shared-fallback');
    expect(r.hasUsecaseOverride).toBe(false);
  });

  it('treats default source (no admin config at all) as no-override', async () => {
    mockGet.mockResolvedValue({
      provider: 'ollama',
      model: '',
      source: { provider: 'default', model: 'default' },
    });

    const r = await resolveChatAssignment('body-model');

    expect(r.hasUsecaseOverride).toBe(false);
    expect(r.model).toBe('body-model');
  });
});
