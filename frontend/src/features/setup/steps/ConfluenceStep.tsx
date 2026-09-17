import { useState, type FormEvent } from 'react';
import { m } from 'framer-motion';
import { toast } from 'sonner';
import { apiFetch } from '../../../shared/lib/api';
import { SpaceSyncPanel } from './SpaceSyncPanel';

interface ConfluenceStepProps {
  onNext: () => void;
  onBack: () => void;
}

export function ConfluenceStep({ onNext, onBack }: ConfluenceStepProps) {
  const [confluenceUrl, setConfluenceUrl] = useState('');
  const [pat, setPat] = useState('');
  const [testing, setTesting] = useState(false);
  const [testSuccess, setTestSuccess] = useState<boolean | null>(null);
  const [choosingStandalone, setChoosingStandalone] = useState(false);

  /**
   * #1623: declining Confluence is a *decision*, not a deferral. Persisting
   * `confluenceEnabled: false` is what puts the instance in standalone mode —
   * every feature keeps working, nothing syncs — so the rest of the app stops
   * asking for a URL and a PAT. Advancing without the write (the old
   * behaviour) left the flag at its default `true`, and the admin who had just
   * said "no thanks" met a connect prompt on every surface afterwards.
   *
   * The write must never trap anyone in setup: a failed PUT is reported and
   * the wizard still advances, exactly as a failed in-wizard sync does.
   */
  async function handleStandalone() {
    setChoosingStandalone(true);
    try {
      await apiFetch('/settings', {
        method: 'PUT',
        body: JSON.stringify({ confluenceEnabled: false }),
      });
    } catch (err) {
      toast.error(
        err instanceof Error
          ? `Could not save standalone mode: ${err.message}`
          : 'Could not save standalone mode',
      );
    } finally {
      setChoosingStandalone(false);
    }
    onNext();
  }

  async function handleTest(e: FormEvent) {
    e.preventDefault();
    setTesting(true);
    setTestSuccess(null);

    try {
      // Save settings first, then test the connection. `confluenceEnabled` is
      // sent explicitly (#1623): an admin who picked standalone earlier in the
      // same session — or on an earlier run of the wizard — has the flag
      // persisted as false, and entering credentials now is the clearest
      // possible statement that they want the integration back on.
      await apiFetch('/settings', {
        method: 'PUT',
        body: JSON.stringify({
          confluenceUrl,
          confluencePat: pat,
          confluenceEnabled: true,
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
        Connect to your Confluence Data Center instance to sync knowledge base pages. Confluence is
        optional: in standalone mode every feature works against your local library, with nothing
        synced either way. You can switch either direction later in Settings.
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

        {/* Test result indicator. Uses the semantic status tokens rather than
            literal Tailwind emerald/red: those shades are dark-theme tuned and
            (unlike the amber ones) are not remapped for Paper, so they
            rendered at ~1.6:1 on the light surface. The status tokens carry an
            AA-passing value per theme, and match the sync banners below. */}
        {testSuccess !== null && (
          <m.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className={`rounded-lg border p-3 text-sm ${
              testSuccess
                ? 'border-status-connected/30 bg-status-connected/10 text-status-connected'
                : 'border-status-disconnected/30 bg-status-disconnected/10 text-status-disconnected'
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

      {/* #1127: the space picker is the consequence of a passing probe, so it
          lives in this step rather than a sixth one — the whole point is that
          the admin never has to go looking for Settings → Spaces & Sync. It
          is purely additive: `testSuccess` alone still enables Continue
          below, and the panel's own sync state is deliberately not consulted
          there. */}
      {testSuccess === true && <SpaceSyncPanel />}

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
          {/* Same test id as the old "Skip for Now": the control is in the
              same place doing the same navigation, it just now says what it
              means and records the choice. */}
          <button
            type="button"
            onClick={handleStandalone}
            disabled={choosingStandalone}
            className="nm-icon-button px-4 py-2 text-sm"
            data-testid="skip-confluence-btn"
          >
            {choosingStandalone ? 'Saving...' : 'Use Standalone Mode'}
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
