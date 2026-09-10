/**
 * Closed Settings presets (#1454 / #1442 D6). These only *fill* `LlmProviderInput`.
 * They are not stored and must never become a `vendor` column or request fork.
 *
 * The DeepSeek hostname is the contract child A (#1453) pins in `STRICT_HOSTS`.
 */

export type ProviderPresetId =
  | 'openai'
  | 'deepseek'
  | 'groq'
  | 'mistral'
  | 'openrouter'
  | 'together'
  | 'fireworks'
  | 'azure-openai'
  | 'custom';

export interface ProviderPreset {
  id: ProviderPresetId;
  label: string;
  baseUrl: string;
  authType: 'bearer';
  suggestedModel: string;
  urlPlaceholder: string;
  urlHelper: string;
}

export const LOCAL_PROVIDER_PLACEHOLDER = 'http://host.docker.internal:1234/v1';

const LOCAL_URL_HELPER =
  'For local servers (LM Studio, vLLM) in Docker, use http://host.docker.internal:1234/v1. For a hosted API, pick a preset above.';

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    authType: 'bearer',
    suggestedModel: 'gpt-4.1-mini',
    urlPlaceholder: 'https://api.openai.com/v1',
    urlHelper: 'OpenAI-compatible /v1. The suggested model is editable.',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    authType: 'bearer',
    suggestedModel: 'deepseek-chat',
    urlPlaceholder: 'https://api.deepseek.com/v1',
    urlHelper: 'OpenAI-compatible /v1. The suggested model is editable.',
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    authType: 'bearer',
    suggestedModel: '',
    urlPlaceholder: 'https://api.groq.com/openai/v1',
    urlHelper: 'OpenAI-compatible /v1. Type a model id.',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    authType: 'bearer',
    suggestedModel: '',
    urlPlaceholder: 'https://api.mistral.ai/v1',
    urlHelper: 'OpenAI-compatible /v1. Type a model id.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    authType: 'bearer',
    suggestedModel: '',
    urlPlaceholder: 'https://openrouter.ai/api/v1',
    urlHelper: 'OpenAI-compatible /v1. Type a model id.',
  },
  {
    id: 'together',
    label: 'Together',
    baseUrl: 'https://api.together.xyz/v1',
    authType: 'bearer',
    suggestedModel: '',
    urlPlaceholder: 'https://api.together.xyz/v1',
    urlHelper: 'OpenAI-compatible /v1. Type a model id.',
  },
  {
    id: 'fireworks',
    label: 'Fireworks',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    authType: 'bearer',
    suggestedModel: '',
    urlPlaceholder: 'https://api.fireworks.ai/inference/v1',
    urlHelper: 'OpenAI-compatible /v1. Type a model id.',
  },
  {
    id: 'azure-openai',
    label: 'Azure OpenAI',
    baseUrl: '',
    authType: 'bearer',
    suggestedModel: '',
    urlPlaceholder: 'https://{resource}.openai.azure.com/openai/v1',
    urlHelper:
      'Paste the resource endpoint, e.g. https://{resource}.openai.azure.com/openai/v1. Leave the deployment as the default model.',
  },
  {
    id: 'custom',
    label: 'Custom',
    baseUrl: '',
    authType: 'bearer',
    suggestedModel: '',
    urlPlaceholder: LOCAL_PROVIDER_PLACEHOLDER,
    urlHelper: LOCAL_URL_HELPER,
  },
];

export function presetById(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}

function fieldDirty(current: string, lastFilled: string): boolean {
  return current.trim() !== '' && current !== lastFilled;
}

/** True when applying `preset` would replace a URL or model the operator typed. */
export function presetWouldOverwrite(
  preset: ProviderPreset,
  fields: { baseUrl: string; defaultModel: string },
  lastFilled: { baseUrl: string; defaultModel: string },
): boolean {
  const urlChange = fields.baseUrl !== preset.baseUrl;
  const modelChange = fields.defaultModel !== preset.suggestedModel;
  return (
    (urlChange && fieldDirty(fields.baseUrl, lastFilled.baseUrl)) ||
    (modelChange && fieldDirty(fields.defaultModel, lastFilled.defaultModel))
  );
}
