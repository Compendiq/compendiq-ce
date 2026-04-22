import { useState } from 'react';
import type { SettingsResponse } from '@compendiq/contracts';
import { apiFetch } from '../../../shared/lib/api';

export function ConfluenceTab({ settings, onSave }: { settings: SettingsResponse; onSave: (v: Record<string, unknown>) => void }) {
  const [url, setUrl] = useState(settings.confluenceUrl ?? '');
  const [pat, setPat] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  async function testConnection() {
    setTesting(true);
    try {
      const result = await apiFetch<{ success: boolean; message: string }>(
        '/settings/test-confluence',
        { method: 'POST', body: JSON.stringify({ url, pat: pat || undefined }) },
      );
      setTestResult(result);
    } catch (err) {
      setTestResult({ success: false, message: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setTesting(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSave({ confluenceUrl: url, ...(pat ? { confluencePat: pat } : {}) });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="mb-1.5 block text-sm font-medium">Confluence URL</label>
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="glass-input"
          placeholder="https://confluence.company.com"
        />
      </div>

      <div>
        <label className="mb-1.5 block text-sm font-medium">
          Personal Access Token
          {settings.hasConfluencePat && (
            <span className="ml-2 text-xs text-success">Configured</span>
          )}
        </label>
        <input
          type="password"
          value={pat}
          onChange={(e) => setPat(e.target.value)}
          className="glass-input"
          placeholder={settings.hasConfluencePat ? '••••••••••' : 'Enter PAT'}
        />
      </div>

      {testResult && (
        <div className={`rounded-md p-3 text-sm ${testResult.success ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive'}`}>
          {testResult.message}
        </div>
      )}

      <div className="flex gap-3">
        <button
          type="button"
          onClick={testConnection}
          disabled={testing || !url}
          className="glass-button-secondary"
        >
          {testing ? 'Testing...' : 'Test Connection'}
        </button>
        <button
          type="submit"
          className="glass-button-primary"
        >
          Save
        </button>
      </div>
    </form>
  );
}
