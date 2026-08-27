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
    // OLLAMA_BASE_URL's sentinel rewrite is named; LLM_BEARER_TOKEN is not a fake Ollama auth seed.
    expect(guide).toMatch(/sentinel `http:\/\/localhost:11434\/v1`/);
    expect(guide).toMatch(/not\*\* read as an Ollama auth seed/i);
    // Troubleshooting must not claim the env never touches a saved row (sentinel rewrite).
    const troubleshooting = guide.slice(guide.indexOf('### LLM requests fail or time out'));
    expect(troubleshooting).not.toMatch(
      /only seeds an empty\s+table — it does not override a saved row/,
    );
    expect(troubleshooting).toMatch(/non-sentinel\s+saved URL is not overridden/);
  });

  it('documents hosted DeepSeek as a live strict thinking host (D5 / #1457)', () => {
    expect(guide).toMatch(
      /Hosted DeepSeek is a \*\*strict thinking host\*\*: Think never sends `think` or\s*`chat_template_kwargs`/,
    );
    expect(guide).toMatch(/`reasoning_content`/);
    // Must not keep the pre-merge hedge now that #1457 is on dev.
    expect(guide).not.toMatch(/do \*\*not\*\* assume Think-on against DeepSeek cannot 400/i);
    expect(guide).not.toMatch(/Until #1457 is on/);
  });

  it('documents live vendor presets (#1458) and Start re-embed for OpenAI embeddings', () => {
    expect(guide).toMatch(/Pick a \*\*preset\*\*/);
    expect(guide).toMatch(/\|\s*Preset\s*\|\s*\*\*OpenAI\*\*/);
    expect(guide).toMatch(/\|\s*Preset\s*\|\s*\*\*DeepSeek\*\*/);
    expect(guide).toContain('https://api.openai.com/v1');
    expect(guide).toContain('https://api.deepseek.com/v1');
    expect(guide).toMatch(/Start re-embed/);
    expect(guide).not.toMatch(/that triggers a re-embed/);
    expect(guide).not.toMatch(/blank form/i);
    expect(guide).not.toMatch(/until that\s+merges/i);
  });

  it('points connectivity checks at the provider-row Test control, not a modal-only button', () => {
    expect(guide).toContain('POST /admin/llm-providers/:id/test');
    expect(guide).toMatch(/\*\*Test\*\*.{0,40}row/s);
  });
});
