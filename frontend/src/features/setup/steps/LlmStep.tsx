import { useState } from 'react';
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

export function LlmStep({ onNext, onBack }: LlmStepProps) {
  const [baseUrl, setBaseUrl] = useState('http://host.docker.internal:1234/v1');
  const [apiKey, setApiKey] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<LlmTestResult | null>(null);

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const payload: Record<string, string> = { provider: 'openai' };
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
        Compendiq uses an OpenAI-compatible large language model API for AI features.
      </p>

      <div className="mt-6 space-y-4">
        {/* Base URL */}
        <div>
          <label htmlFor="llm-base-url" className="mb-1.5 block text-sm font-medium">
            OpenAI-Compatible Base URL
          </label>
          <input
            id="llm-base-url"
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            className="nm-input"
            placeholder="http://host.docker.internal:1234/v1"
            data-testid="llm-base-url"
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            For local servers (e.g. LM Studio, vLLM, LocalAI) running on your machine with Docker, use{' '}
            <code className="text-foreground">http://host.docker.internal:1234/v1</code>. For cloud providers, use{' '}
            <code className="text-foreground">https://api.openai.com/v1</code>.
          </p>
        </div>

        {/* API Key */}
        <div>
          <label htmlFor="llm-api-key" className="mb-1.5 block text-sm font-medium">
            API Key <span className="text-xs text-muted-foreground font-normal">(optional for local servers)</span>
          </label>
          <input
            id="llm-api-key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="nm-input"
            placeholder="sk-... or leave empty for LM Studio"
            data-testid="llm-api-key"
          />
        </div>

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

        {/* Test result indicator */}
        {testResult && (
          <m.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            className={`rounded-lg border p-4 ${
              testResult.success
                ? 'border-status-connected/30 bg-status-connected/10'
                : 'border-status-disconnected/30 bg-status-disconnected/10'
            }`}
            data-testid="llm-test-result"
          >
            <div
              className={`flex items-center gap-2 ${
                testResult.success ? 'text-status-connected' : 'text-status-disconnected'
              }`}
            >
              {testResult.success ? (
                <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
              ) : (
                <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                </svg>
              )}
              <span className="text-sm font-medium">
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
