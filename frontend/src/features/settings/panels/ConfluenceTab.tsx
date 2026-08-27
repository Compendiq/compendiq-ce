import { useState } from 'react';
import { ExternalLink, ShieldCheck } from 'lucide-react';
import type { SettingsResponse } from '@compendiq/contracts';
import { apiFetch } from '../../../shared/lib/api';
import { PanelHeader } from '../PanelHeader';
import { confluenceTokenUrl } from './confluence-token-url';

export function ConfluenceTab({ settings, onSave }: { settings: SettingsResponse; onSave: (v: Record<string, unknown>) => void }) {
  const [url, setUrl] = useState(settings.confluenceUrl ?? '');
  const [pat, setPat] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  // The exact url+pat pair that last tested green. Save unlocks only while the
  // form still matches it, so editing a field after a successful test re-locks
  // Save rather than letting a stale green result vouch for new credentials.
  const [verified, setVerified] = useState<{ url: string; pat: string } | null>(null);

  const tokenUrl = confluenceTokenUrl(url);
  const isVerified = verified !== null && verified.url === url && verified.pat === pat;

  async function testConnection() {
    setTesting(true);
    try {
      const result = await apiFetch<{ success: boolean; message: string }>(
        '/settings/test-confluence',
        { method: 'POST', body: JSON.stringify({ url, pat: pat || undefined }) },
      );
      setTestResult(result);
      setVerified(result.success ? { url, pat } : null);
    } catch (err) {
      setTestResult({ success: false, message: err instanceof Error ? err.message : 'Failed' });
      setVerified(null);
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
      <PanelHeader
        subtitle="Connect Compendiq to your Confluence Data Center so your spaces can sync. Nothing is mirrored until this connection tests green."
      />

      <div>
        <label htmlFor="confluence-url" className="mb-1.5 block text-sm font-medium">Confluence URL</label>
        <input
          id="confluence-url"
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="nm-input"
          placeholder="https://confluence.company.com"
          aria-describedby="confluence-url-hint"
        />
        <p id="confluence-url-hint" className="mt-1.5 text-xs text-muted-foreground">
          The base address of your Confluence Data Center instance. Compendiq supports DC 9.2 and later.
        </p>
      </div>

      <div>
        <label htmlFor="confluence-pat" className="mb-1.5 block text-sm font-medium">
          Personal Access Token
          {settings.hasConfluencePat && (
            <span className="ml-2 text-xs text-success">Configured</span>
          )}
        </label>
        <input
          id="confluence-pat"
          type="password"
          value={pat}
          onChange={(e) => setPat(e.target.value)}
          className="nm-input"
          placeholder={settings.hasConfluencePat ? '••••••••••' : 'Paste your Confluence personal access token'}
          aria-describedby="confluence-pat-hint"
        />
        <div id="confluence-pat-hint" className="mt-2 space-y-1.5 text-xs text-muted-foreground">
          <p>
            Create one in Confluence under{' '}
            <span className="text-foreground">Profile → Personal Access Tokens</span>. The token needs
            read access to every space you want to mirror; grant write access only if you plan to
            publish edits back to Confluence.
          </p>
          {tokenUrl && (
            <p>
              <a
                href={tokenUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-medium text-action underline underline-offset-2"
                data-testid="confluence-token-link"
              >
                Create a token on your Confluence instance
                <ExternalLink size={12} aria-hidden="true" />
              </a>
            </p>
          )}
          <p className="flex items-start gap-1.5 text-muted-foreground">
            <ShieldCheck size={13} className="mt-px shrink-0 text-success" aria-hidden="true" />
            <span>
              Stored encrypted with AES-256-GCM. Never sent to the browser after saving, and never
              included in any prompt sent to a language model.
            </span>
          </p>
        </div>
      </div>

      {testResult && (
        <div
          data-testid="confluence-test-result"
          data-state={testResult.success ? 'success' : 'error'}
          className={`rounded-md p-3 text-sm ${testResult.success ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive'}`}
        >
          {testResult.message}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {/* Test is the primary action: saving an untested credential produces a
            connection that silently mirrors nothing, so the test comes first
            and Save stays inert until it passes. */}
        <button
          type="button"
          onClick={testConnection}
          disabled={testing || !url}
          className="nm-button-primary"
        >
          {testing ? 'Testing...' : 'Test Connection'}
        </button>
        <button
          type="submit"
          disabled={!isVerified}
          className="nm-button-ghost"
          data-testid="confluence-save-btn"
        >
          Save
        </button>
        {!isVerified && (
          <p className="text-xs text-muted-foreground" data-testid="confluence-save-hint">
            {testResult?.success
              ? 'Details changed — test the connection again before saving.'
              : 'Test the connection to enable saving.'}
          </p>
        )}
      </div>
    </form>
  );
}
