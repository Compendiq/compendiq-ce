import { useState, type FormEvent } from 'react';
import { m } from 'framer-motion';
import { toast } from 'sonner';
import { apiFetch } from '../../../shared/lib/api';

interface ConfluenceStepProps {
  onNext: () => void;
  onBack: () => void;
}

export function ConfluenceStep({ onNext, onBack }: ConfluenceStepProps) {
  const [confluenceUrl, setConfluenceUrl] = useState('');
  const [pat, setPat] = useState('');
  const [testing, setTesting] = useState(false);
  const [testSuccess, setTestSuccess] = useState<boolean | null>(null);

  async function handleTest(e: FormEvent) {
    e.preventDefault();
    setTesting(true);
    setTestSuccess(null);

    try {
      // Save settings first, then test the connection
      await apiFetch('/settings', {
        method: 'PUT',
        body: JSON.stringify({
          confluenceUrl,
          confluencePat: pat,
        }),
      });

      // Actually authenticate against Confluence with the entered credentials.
      // A local read (GET /spaces) succeeds regardless of the PAT's validity,
      // so any credentials would "pass" — probe the real endpoint instead (#950).
      const result = await apiFetch<{ success: boolean; message: string }>(
        '/settings/test-confluence',
        { method: 'POST', body: JSON.stringify({ url: confluenceUrl, pat }) },
      );
      if (result.success) {
        setTestSuccess(true);
        toast.success('Confluence connected successfully');
      } else {
        setTestSuccess(false);
        toast.error(result.message || 'Connection test failed');
      }
    } catch (err) {
      setTestSuccess(false);
      toast.error(err instanceof Error ? err.message : 'Connection test failed');
    } finally {
      setTesting(false);
    }
  }

  return (
    <m.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      transition={{ duration: 0.25 }}
    >
      <h2 className="text-xl font-semibold">Connect Confluence</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Connect to your Confluence Data Center instance to sync knowledge base pages. This step is optional
        -- you can always configure it later.
      </p>

      <form onSubmit={handleTest} className="mt-6 space-y-4">
        <div>
          <label htmlFor="confluence-url" className="mb-1.5 block text-sm font-medium">
            Confluence Base URL
          </label>
          <input
            id="confluence-url"
            type="url"
            value={confluenceUrl}
            onChange={(e) => {
              setConfluenceUrl(e.target.value);
              // Any edit invalidates the prior test — the wizard must not
              // proceed with untested (and unpersisted) credentials.
              setTestSuccess(null);
            }}
            className="nm-input"
            placeholder="https://confluence.example.com"
            data-testid="confluence-url"
          />
        </div>

        <div>
          <label htmlFor="confluence-pat" className="mb-1.5 block text-sm font-medium">
            Personal Access Token (PAT)
          </label>
          <input
            id="confluence-pat"
            type="password"
            value={pat}
            onChange={(e) => {
              setPat(e.target.value);
              setTestSuccess(null);
            }}
            className="nm-input"
            placeholder="Your Confluence PAT"
            data-testid="confluence-pat"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Generate a PAT in Confluence under Profile &gt; Personal Access Tokens.
          </p>
        </div>

        {/* Test result indicator */}
        {testSuccess !== null && (
          <m.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className={`rounded-lg border p-3 text-sm ${
              testSuccess
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                : 'border-red-500/30 bg-red-500/10 text-red-300'
            }`}
            data-testid="confluence-test-result"
          >
            {testSuccess ? 'Connection successful' : 'Connection failed. Check your URL and PAT.'}
          </m.div>
        )}

        <button
          type="submit"
          disabled={testing || !confluenceUrl || !pat}
          className="nm-button-ghost px-4 py-2 text-sm"
          data-testid="test-confluence-btn"
        >
          {testing ? 'Testing...' : 'Test Connection'}
        </button>
      </form>

      <div className="mt-6 flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="nm-icon-button px-4 py-2 text-sm"
          data-testid="confluence-back-btn"
        >
          Back
        </button>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onNext}
            className="nm-icon-button px-4 py-2 text-sm"
            data-testid="skip-confluence-btn"
          >
            Skip for Now
          </button>
          <button
            type="button"
            onClick={onNext}
            disabled={!testSuccess}
            className="nm-button-primary px-6 py-2.5"
            data-testid="confluence-next-btn"
          >
            Continue
          </button>
        </div>
      </div>
    </m.div>
  );
}
