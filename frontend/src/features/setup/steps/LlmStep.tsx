import { useState, useEffect } from 'react';
import { m } from 'framer-motion';
import { toast } from 'sonner';
import { apiFetch } from '../../../shared/lib/api';

interface LlmModel {
  name: string;
  size: number;
}

interface LlmTestResult {
  success: boolean;
  error?: string;
  models: LlmModel[];
}

interface LlmStepProps {
  onNext: () => void;
  onBack: () => void;
}

// UX-only preset that picks sensible defaults for the test endpoint:
//   - 'local'  → Ollama-style local URL, no API key
//   - 'remote' → OpenAI-compatible cloud URL, API key required
// The deprecated `'ollama' | 'openai'` enum (LlmProviderTypeSchema in
// @compendiq/contracts) is mapped from this preset only at the API
// boundary below; nothing else in the wizard touches the legacy strings.
type LlmKindPreset = 'local' | 'remote';

const PRESET_DEFAULTS: Record<LlmKindPreset, { baseUrl: string }> = {
  local: { baseUrl: 'http://localhost:11434' },
  remote: { baseUrl: 'https://api.openai.com' },
};

// Boundary mapping to the legacy `provider` enum the backend test
// endpoint still accepts. Remove once `LlmTestSchema.provider` is dropped.
function presetToLegacyProvider(kind: LlmKindPreset): 'ollama' | 'openai' {
  return kind === 'local' ? 'ollama' : 'openai';
}

export function LlmStep({ onNext, onBack }: LlmStepProps) {
  const [kind, setKind] = useState<LlmKindPreset>('local');
  const [baseUrl, setBaseUrl] = useState(PRESET_DEFAULTS.local.baseUrl);
  const [apiKey, setApiKey] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<LlmTestResult | null>(null);
  const [autoDetecting, setAutoDetecting] = useState(true);

  // Auto-detect a local Ollama on mount
  useEffect(() => {
    let cancelled = false;
    async function autoDetect() {
      try {
        const result = await apiFetch<LlmTestResult>('/setup/llm-test', {
          method: 'POST',
          body: JSON.stringify({
            provider: presetToLegacyProvider('local'),
            baseUrl: PRESET_DEFAULTS.local.baseUrl,
          }),
        });
        if (!cancelled) {
          setTestResult(result);
          if (result.success) {
            toast.success(`Ollama detected with ${result.models.length} model${result.models.length === 1 ? '' : 's'}`);
          }
        }
      } catch {
        // Auto-detect failed silently — user can configure manually
      } finally {
        if (!cancelled) {
          setAutoDetecting(false);
        }
      }
    }
    autoDetect();
    return () => { cancelled = true; };
  }, []);

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const payload: Record<string, string> = { provider: presetToLegacyProvider(kind) };
      if (baseUrl) payload.baseUrl = baseUrl;
      if (apiKey) payload.apiKey = apiKey;

      const result = await apiFetch<LlmTestResult>('/setup/llm-test', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setTestResult(result);
      if (result.success) {
        toast.success('Connection successful');
      } else {
        toast.error(result.error ?? 'Connection failed');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Connection test failed');
    } finally {
      setTesting(false);
    }
  }

  function formatSize(bytes: number): string {
    const gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 1) return `${gb.toFixed(1)} GB`;
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(0)} MB`;
  }

  return (
    <m.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      transition={{ duration: 0.25 }}
    >
      <h2 className="text-xl font-semibold">Configure LLM Provider</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Compendiq uses a large language model for AI features. Configure your preferred provider below.
      </p>

      {autoDetecting && (
        <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          Auto-detecting Ollama...
        </div>
      )}

      <div className="mt-6 space-y-4">
        {/* Provider select */}
        <div>
          <label htmlFor="llm-provider" className="mb-1.5 block text-sm font-medium">
            Provider
          </label>
          <select
            id="llm-provider"
            value={kind}
            onChange={(e) => {
              const next = e.target.value as LlmKindPreset;
              setKind(next);
              setTestResult(null);
              setBaseUrl(PRESET_DEFAULTS[next].baseUrl);
            }}
            className="nm-input"
            data-testid="llm-provider-select"
          >
            <option value="local">Ollama (Local)</option>
            <option value="remote">OpenAI-Compatible API</option>
          </select>
        </div>

        {/* Base URL */}
        <div>
          <label htmlFor="llm-base-url" className="mb-1.5 block text-sm font-medium">
            Base URL
          </label>
          <input
            id="llm-base-url"
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            className="nm-input"
            placeholder={PRESET_DEFAULTS[kind].baseUrl}
            data-testid="llm-base-url"
          />
        </div>

        {/* API Key (remote provider only) */}
        {kind === 'remote' && (
          <div>
            <label htmlFor="llm-api-key" className="mb-1.5 block text-sm font-medium">
              API Key
            </label>
            <input
              id="llm-api-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="nm-input"
              placeholder="sk-..."
              data-testid="llm-api-key"
            />
          </div>
        )}

        {/* Test connection button */}
        <button
          type="button"
          onClick={handleTest}
          disabled={testing}
          className="nm-button-ghost px-4 py-2 text-sm"
          data-testid="test-llm-btn"
        >
          {testing ? 'Testing...' : 'Test Connection'}
        </button>

        {/* Test result */}
        {testResult && (
          <m.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            className={`rounded-lg border p-4 ${
              testResult.success
                ? 'border-emerald-500/30 bg-emerald-500/10'
                : 'border-red-500/30 bg-red-500/10'
            }`}
            data-testid="llm-test-result"
          >
            <div className="flex items-center gap-2">
              {testResult.success ? (
                <svg className="h-5 w-5 text-emerald-400" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
              ) : (
                <svg className="h-5 w-5 text-red-400" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                </svg>
              )}
              <span className={`text-sm font-medium ${testResult.success ? 'text-emerald-300' : 'text-red-300'}`}>
                {testResult.success ? 'Connected' : testResult.error ?? 'Connection failed'}
              </span>
            </div>

            {testResult.success && testResult.models.length > 0 && (
              <div className="mt-3">
                <p className="mb-2 text-xs font-medium text-muted-foreground">
                  Available Models ({testResult.models.length})
                </p>
                <div className="max-h-40 space-y-1 overflow-y-auto">
                  {testResult.models.map((model) => (
                    <div
                      key={model.name}
                      className="flex items-center justify-between rounded px-2 py-1 text-xs bg-foreground/5"
                    >
                      <span className="font-mono">{model.name}</span>
                      <span className="text-muted-foreground">{formatSize(model.size)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </m.div>
        )}
      </div>

      <div className="mt-6 flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="nm-icon-button px-4 py-2 text-sm"
          data-testid="llm-back-btn"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onNext}
          className="nm-button-primary px-6 py-2.5"
          data-testid="llm-next-btn"
        >
          Continue
        </button>
      </div>
    </m.div>
  );
}
