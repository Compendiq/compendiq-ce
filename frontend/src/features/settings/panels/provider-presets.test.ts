import { describe, expect, it } from 'vitest';
import { PROVIDER_PRESETS, presetWouldOverwrite } from './provider-presets';

describe('PROVIDER_PRESETS', () => {
  it('is the closed D6 list with Custom last and no vendor enum', () => {
    expect(PROVIDER_PRESETS.map((p) => p.id)).toEqual([
      'openai',
      'deepseek',
      'groq',
      'mistral',
      'openrouter',
      'together',
      'fireworks',
      'azure-openai',
      'custom',
    ]);
    expect(PROVIDER_PRESETS.every((p) => !('vendor' in p))).toBe(true);
  });

  it('fills hosted OpenAI-compatible /v1 URLs and only suggests models where the id is known', () => {
    const byId = Object.fromEntries(PROVIDER_PRESETS.map((p) => [p.id, p]));
    expect(byId.openai.baseUrl).toBe('https://api.openai.com/v1');
    expect(byId.openai.suggestedModel).toBe('gpt-4.1-mini');
    expect(byId.deepseek.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(byId.deepseek.suggestedModel).toBe('deepseek-chat');
    expect(byId.groq.baseUrl).toBe('https://api.groq.com/openai/v1');
    expect(byId.mistral.baseUrl).toBe('https://api.mistral.ai/v1');
    expect(byId.openrouter.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(byId.together.baseUrl).toBe('https://api.together.xyz/v1');
    expect(byId.fireworks.baseUrl).toBe('https://api.fireworks.ai/inference/v1');
    expect(byId['azure-openai'].baseUrl).toBe('');
    expect(byId.custom.baseUrl).toBe('');
    for (const id of ['groq', 'mistral', 'openrouter', 'together', 'fireworks', 'azure-openai', 'custom'] as const) {
      expect(byId[id].suggestedModel).toBe('');
    }
    for (const p of PROVIDER_PRESETS) {
      expect(p.authType).toBe('bearer');
    }
  });

  it('keeps the DeepSeek preset host as api.deepseek.com for the STRICT_HOSTS drift gate', () => {
    const deepseek = PROVIDER_PRESETS.find((p) => p.id === 'deepseek');
    expect(new URL(deepseek!.baseUrl).hostname).toBe('api.deepseek.com');
  });
});

describe('presetWouldOverwrite', () => {
  const openai = PROVIDER_PRESETS.find((p) => p.id === 'openai')!;
  const emptyFilled = { baseUrl: '', defaultModel: '' };

  it('is false when filling empty fields', () => {
    expect(
      presetWouldOverwrite(openai, { baseUrl: '', defaultModel: '' }, emptyFilled),
    ).toBe(false);
  });

  it('is false when fields still match the last applied preset', () => {
    expect(
      presetWouldOverwrite(
        PROVIDER_PRESETS.find((p) => p.id === 'deepseek')!,
        { baseUrl: openai.baseUrl, defaultModel: openai.suggestedModel },
        { baseUrl: openai.baseUrl, defaultModel: openai.suggestedModel },
      ),
    ).toBe(false);
  });

  it('is true when the operator typed a URL that is not the last fill', () => {
    expect(
      presetWouldOverwrite(
        openai,
        { baseUrl: 'http://localhost:11434/v1', defaultModel: '' },
        emptyFilled,
      ),
    ).toBe(true);
  });

  it('is true when the operator typed a model that is not the last fill', () => {
    expect(
      presetWouldOverwrite(openai, { baseUrl: '', defaultModel: 'qwen3:4b' }, emptyFilled),
    ).toBe(true);
  });

  it('is false when the typed URL already equals the incoming preset', () => {
    expect(
      presetWouldOverwrite(
        openai,
        { baseUrl: openai.baseUrl, defaultModel: '' },
        emptyFilled,
      ),
    ).toBe(false);
  });
});
