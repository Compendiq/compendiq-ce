import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Regression guard for #1456 / #1442 D: ADMIN-GUIDE must teach the live
 * Settings → AI Models path for hosted OpenAI + DeepSeek, keep chat-only
 * hosts off embedding / rerank / image_embedding, and label the legacy LLM
 * env table bootstrap-only — never revive `LLM_PROVIDER=openai` as the path.
 */

const guide = readFileSync(resolve(__dirname, '../../docs/ADMIN-GUIDE.md'), 'utf-8');

describe('ADMIN-GUIDE hosted OpenAI + DeepSeek (#1456)', () => {
  it('documents Settings → AI Models as the primary provider path', () => {
    expect(guide).toMatch(/### LLM providers \(primary\)/);
    expect(guide).toContain('Settings → AI → AI Models → LLM providers');
  });

  it('names OpenAI and DeepSeek recipes with their /v1 base URLs', () => {
    expect(guide).toContain('#### Recipe — hosted OpenAI');
    expect(guide).toContain('https://api.openai.com/v1');
    expect(guide).toContain('#### Recipe — hosted DeepSeek');
    expect(guide).toContain('https://api.deepseek.com/v1');
  });

  it('warns that a chat-only host must not cover embedding / rerank / image embedding', () => {
    expect(guide).toMatch(
      /Chat-only hosts must not cover embedding \/ rerank \/ image embedding/i,
    );
    expect(guide).toMatch(/\*\*Embedding\*\*/);
    expect(guide).toMatch(/\*\*Rerank\*\*/);
    expect(guide).toMatch(/\*\*Image embedding\*\*/);
    expect(guide).toMatch(/hosted DeepSeek/i);
  });

  it('labels the legacy LLM env table bootstrap-only and does not revive LLM_PROVIDER as live', () => {
    expect(guide).toMatch(/### Deprecated LLM env vars \(bootstrap-only\)/);
    expect(guide).toMatch(/\*\*Bootstrap-only\.\*\*/);
    expect(guide).toMatch(/Do \*\*not\*\* revive `LLM_PROVIDER=ollama\|openai`/);
    // The live primary section must not present LLM_PROVIDER as a working toggle.
    const primary = guide.slice(
      guide.indexOf('### LLM providers (primary)'),
      guide.indexOf('### Deprecated LLM env vars (bootstrap-only)'),
    );
    expect(primary).not.toMatch(/\|\s*`LLM_PROVIDER`\s*\|/);
  });

  it('documents hosted DeepSeek as a strict thinking host (D5)', () => {
    expect(guide).toMatch(/strict thinking host/i);
    expect(guide).toMatch(/`think` or\s*`chat_template_kwargs`/);
  });

  it('points connectivity checks at the provider-row Test control, not a modal-only button', () => {
    expect(guide).toContain('POST /admin/llm-providers/:id/test');
    expect(guide).toMatch(/\*\*Test\*\*.{0,40}row/s);
  });
});
