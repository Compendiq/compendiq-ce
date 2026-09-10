import { useEffect, useState } from 'react';
import * as Switch from '@radix-ui/react-switch';
import type {
  ClientAssetManifest,
  ClientSpellcheckLanguage,
  InlineCompletionDelay,
  InlineCompletionMode,
  SettingsResponse,
} from '@compendiq/contracts';
import { apiFetch } from '../../shared/lib/api';
import { getClientInferenceManager } from '../../shared/lib/client-inference/client-inference-manager';
import { useUiStore } from '../../stores/ui-store';
import { CollabEditingCard } from './CollabEditingCard';
import { Check } from 'lucide-react';
import { PanelHeader } from './PanelHeader';
import { cn } from '../../shared/lib/cn';
import { isMac } from '../../shared/lib/platform';

const DELAYS: ReadonlyArray<{
  value: InlineCompletionDelay;
  label: string;
  detail: string;
}> = [
  { value: 'fast', label: 'Fast', detail: '300 ms' },
  { value: 'balanced', label: 'Balanced', detail: '500 ms' },
  { value: 'deliberate', label: 'Deliberate', detail: '800 ms' },
  { value: 'manual', label: 'Manual only', detail: 'Shortcut' },
];

const MODES: ReadonlyArray<{
  value: InlineCompletionMode;
  label: string;
  detail: string;
}> = [
  { value: 'word', label: 'Word', detail: 'Fast and focused' },
  { value: 'full', label: 'Full suggestion', detail: 'One concise line' },
];

const SPELL_LANGUAGES: ReadonlyArray<{
  value: ClientSpellcheckLanguage;
  label: string;
}> = [
  { value: 'en_US', label: 'English (US)' },
  { value: 'de_DE', label: 'German' },
];

function PreferenceSwitch({
  id,
  checked,
  onCheckedChange,
  label,
  help,
  describedBy,
  ariaDisabled = false,
}: {
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  help: string;
  describedBy?: string;
  ariaDisabled?: boolean;
}) {
  const helpId = `${id}-help`;
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-4">
      <div className="min-w-0">
        <label htmlFor={id} className="cursor-pointer text-sm font-medium text-foreground">
          {label}
        </label>
        <p id={helpId} className="mt-0.5 text-xs leading-5 text-muted-foreground">
          {help}
        </p>
      </div>
      <Switch.Root
        id={id}
        data-testid={id}
        checked={checked}
        onCheckedChange={(next) => {
          if (ariaDisabled) return;
          onCheckedChange(next);
        }}
        aria-describedby={describedBy ? `${helpId} ${describedBy}` : helpId}
        aria-disabled={ariaDisabled || undefined}
        className="relative h-5 w-9 shrink-0 rounded-full bg-foreground/10 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring data-[state=checked]:bg-action aria-disabled:opacity-70"
      >
        <Switch.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-white transition-transform data-[state=checked]:translate-x-4" />
      </Switch.Root>
    </div>
  );
}

export function EditorPreferencesTab({
  settings,
  onSave,
  isAdmin = false,
}: {
  settings: SettingsResponse;
  onSave: (value: Record<string, unknown>) => void;
  isAdmin?: boolean;
}) {
  const [enabled, setEnabled] = useState(settings.inlineCompletionEnabled);
  const [delay, setDelay] = useState(settings.inlineCompletionDelay);
  const [mode, setMode] = useState(settings.inlineCompletionMode);
  const [codeOnly, setCodeOnly] = useState(settings.inlineCompletionCodeOnly);
  const [clientEnabled, setClientEnabled] = useState(settings.clientInferenceEnabled);
  const [withoutServer, setWithoutServer] = useState(settings.clientInferenceWithoutServer);
  const [spellEnabled, setSpellEnabled] = useState(settings.clientSpellcheckEnabled);
  const [spellLangs, setSpellLangs] = useState<ClientSpellcheckLanguage[]>(
    settings.clientSpellcheckLanguages,
  );
  const vimModeEnabled = useUiStore((s) => s.vimModeEnabled);
  const setVimModeEnabled = useUiStore((s) => s.setVimModeEnabled);
  const adminOn = settings.clientInferenceAdminEnabled;
  const [manifest, setManifest] = useState<ClientAssetManifest | null>(null);
  const [manifestBytes, setManifestBytes] = useState<number | null>(null);
  const [modelDownloaded, setModelDownloaded] = useState<boolean | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [isClearing, setIsClearing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void apiFetch<ClientAssetManifest>('/models/client-assets')
      .then(async (manifestData) => {
        if (cancelled) return;
        setManifest(manifestData);
        const onnx = manifestData.models.find(
          (m) => m.kind === 'onnx' && (m.id === manifestData.activeModelId || m.installed),
        ) ?? manifestData.models.find((m) => m.kind === 'onnx');
        const bytes = onnx?.bytes && onnx.bytes > 0 ? onnx.bytes : null;
        setManifestBytes(bytes);
        const modelId = onnx?.id;
        const files = onnx?.files.map((f) => f.name);
        try {
          const downloaded = await getClientInferenceManager().isModelDownloaded(modelId, files);
          if (!cancelled) setModelDownloaded(downloaded);
        } catch {
          if (!cancelled) setModelDownloaded(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setManifest(null);
          setManifestBytes(null);
          void getClientInferenceManager().isModelDownloaded()
            .then((downloaded) => {
              if (!cancelled) setModelDownloaded(downloaded);
            })
            .catch(() => {
              if (!cancelled) setModelDownloaded(false);
            });
        }
      });
    return () => { cancelled = true; };
  }, []);

  const activeOnnx = manifest?.models.find(
    (m) => m.kind === 'onnx' && (m.id === manifest.activeModelId || m.installed),
  ) ?? manifest?.models.find((m) => m.kind === 'onnx');
  const modelName = activeOnnx?.repo ?? activeOnnx?.id;

  async function handlePreDownload() {
    if (!adminOn || downloadProgress) return;
    setDownloadError(null);
    getClientInferenceManager().setFlags({
      adminEnabled: adminOn,
      userEnabled: clientEnabled,
    });
    try {
      await getClientInferenceManager().predownload((loaded, total) => {
        setDownloadProgress({ loaded, total });
      });
      setModelDownloaded(true);
    } catch (err: unknown) {
      setDownloadError(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setDownloadProgress(null);
    }
  }

  async function handleClearModel() {
    if (downloadProgress || isClearing) return;
    setIsClearing(true);
    setDownloadError(null);
    try {
      const modelId = activeOnnx?.id;
      await getClientInferenceManager().clearDownloadedModel(modelId);
      setModelDownloaded(false);
    } catch (err: unknown) {
      setDownloadError(err instanceof Error ? err.message : 'Failed to remove model');
    } finally {
      setIsClearing(false);
    }
  }
  const changed = enabled !== settings.inlineCompletionEnabled
    || delay !== settings.inlineCompletionDelay
    || mode !== settings.inlineCompletionMode
    || codeOnly !== settings.inlineCompletionCodeOnly
    || clientEnabled !== settings.clientInferenceEnabled
    || withoutServer !== settings.clientInferenceWithoutServer
    || spellEnabled !== settings.clientSpellcheckEnabled
    || spellLangs.join(',') !== settings.clientSpellcheckLanguages.join(',');
  const mac = isMac();

  function toggleSpellLanguage(lang: ClientSpellcheckLanguage) {
    const has = spellLangs.includes(lang);
    if (has && spellEnabled && spellLangs.length === 1) return;
    setSpellLangs(has ? spellLangs.filter((item) => item !== lang) : [...spellLangs, lang]);
  }

  return (
    <div className="space-y-6">
      <PanelHeader
        subtitle="Control when AI offers a short continuation ahead of your cursor. Suggestions stay hidden until an administrator assigns a dedicated inline-completion model."
      />

      <section aria-labelledby="inline-completion-heading">
        <div className="mb-3">
          <h3 id="inline-completion-heading" className="text-sm font-semibold text-foreground">
            Inline suggestions
          </h3>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Accept with Tab, dismiss with Escape, or request manually with{' '}
            {mac ? 'Option+\\ or Command+Shift+Space' : 'Alt+\\'}.
            {mode === 'full' && ` Accept one word with ${mac ? 'Option+]' : 'Ctrl+]'}.`}
          </p>
        </div>

        <div className="divide-y divide-border rounded-xl border border-border">
          <PreferenceSwitch
            id="inline-completion-enabled"
            checked={enabled}
            onCheckedChange={setEnabled}
            label="Show inline suggestions"
            help="Offer a one-line continuation after you pause while writing."
          />

          <fieldset className="px-4 py-4" disabled={!enabled}>
            <legend className="text-sm font-medium text-foreground">Suggestion delay</legend>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
              A longer pause makes fewer requests. Manual only never requests automatically.
            </p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Suggestion delay">
              {DELAYS.map((option) => {
                const active = delay === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    disabled={!enabled}
                    onClick={() => setDelay(option.value)}
                    data-testid={`inline-delay-${option.value}`}
                    className={cn(
                      'flex items-center justify-between rounded-lg border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
                      active
                        ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/8'
                        : 'border-border hover:border-border-interactive',
                    )}
                  >
                    <span>
                      <span className="block text-sm font-medium text-foreground">{option.label}</span>
                      <span className="block text-xs text-muted-foreground">{option.detail}</span>
                    </span>
                    {active && <Check size={15} className="text-[var(--color-primary)]" aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
          </fieldset>

          <fieldset className="px-4 py-4" disabled={!enabled}>
            <legend className="text-sm font-medium text-foreground">Default mode</legend>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
              Choose how much text appears ahead of your cursor.
            </p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Default completion mode">
              {MODES.map((option) => {
                const active = mode === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    disabled={!enabled}
                    onClick={() => setMode(option.value)}
                    data-testid={`inline-mode-${option.value}`}
                    className={cn(
                      'flex items-center justify-between rounded-lg border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
                      active
                        ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/8'
                        : 'border-border hover:border-border-interactive',
                    )}
                  >
                    <span>
                      <span className="block text-sm font-medium text-foreground">{option.label}</span>
                      <span className="block text-xs text-muted-foreground">{option.detail}</span>
                    </span>
                    {active && <Check size={15} className="text-[var(--color-primary)]" aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
          </fieldset>

          <PreferenceSwitch
            id="inline-completion-code-only"
            checked={codeOnly}
            onCheckedChange={setCodeOnly}
            label="Code blocks only"
            help="Keep prose quiet and offer suggestions only while the cursor is inside a code block."
          />
        </div>
      </section>

      <section aria-labelledby="client-inference-heading">
        <div className="mb-3">
          <h3 id="client-inference-heading" className="text-sm font-semibold text-foreground">
            On-device suggestions (WebGPU)
          </h3>
          <p id="client-inference-fallback" className="mt-1 text-sm leading-6 text-muted-foreground">
            Falls back to the server model when the on-device model is not ready.
          </p>
        </div>

        <div className="divide-y divide-border rounded-xl border border-border">
          <PreferenceSwitch
            id="client-inference-enabled"
            checked={clientEnabled}
            onCheckedChange={setClientEnabled}
            ariaDisabled={!adminOn}
            describedBy="client-inference-fallback client-inference-admin-note"
            label="On-device suggestions (WebGPU)"
            help="Needs administrator enablement and a compatible GPU. Drafts stay in this browser. The model downloads once per browser."
          />
          <p id="client-inference-admin-note" className="px-4 py-3 text-xs leading-5 text-muted-foreground">
            {adminOn
              ? 'An administrator has enabled on-device suggestions for this instance.'
              : 'An administrator has not enabled on-device suggestions.'}
          </p>

          <PreferenceSwitch
            id="client-inference-without-server"
            checked={withoutServer}
            onCheckedChange={setWithoutServer}
            ariaDisabled={!clientEnabled}
            label="Use on-device suggestions when no server model is assigned"
            help="Air-gapped use when no inline-completion model is assigned. Off keeps ghost text off until a server model exists."
          />

          <div className="px-4 py-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <span className="text-sm font-medium text-foreground">
                  Local model storage
                </span>
                <p id="client-inference-predownload-help" className="mt-0.5 text-xs leading-5 text-muted-foreground">
                  {modelDownloaded
                    ? `The on-device model${modelName ? ` (${modelName})` : ''} is downloaded and ready in this browser${manifestBytes != null ? ` (${Math.round(manifestBytes / (1024 * 1024))} MB)` : ''}.`
                    : `Downloads only in this browser${manifestBytes != null ? ` (${Math.round(manifestBytes / (1024 * 1024))} MB)` : ''}. The on-device model is not shared with other browsers.`}
                </p>
              </div>

              <div role="status" aria-live="polite" className="shrink-0">
                {downloadProgress !== null ? (
                  <span
                    data-testid="client-inference-status-downloading"
                    className="inline-flex items-center gap-1.5 rounded-md border border-warning/30 bg-warning/10 px-2.5 py-1 text-xs font-medium text-warning"
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-warning animate-pulse" aria-hidden="true" />
                    Downloading ({Math.round((downloadProgress.loaded / Math.max(1, downloadProgress.total)) * 100)}%)
                  </span>
                ) : modelDownloaded === true ? (
                  <span
                    data-testid="client-inference-status-downloaded"
                    className="inline-flex items-center gap-1.5 rounded-md border border-success/30 bg-success/10 px-2.5 py-1 text-xs font-medium text-success"
                  >
                    <Check size={13} className="text-success" aria-hidden="true" />
                    Downloaded &amp; ready
                  </span>
                ) : modelDownloaded === false ? (
                  <span
                    data-testid="client-inference-status-not-downloaded"
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/60 px-2.5 py-1 text-xs font-medium text-muted-foreground"
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" aria-hidden="true" />
                    Not downloaded
                  </span>
                ) : (
                  <span
                    data-testid="client-inference-status-checking"
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2.5 py-1 text-xs font-medium text-muted-foreground"
                  >
                    Checking…
                  </span>
                )}
              </div>
            </div>

            {downloadProgress && (
              <div className="space-y-1.5">
                <div
                  className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                  aria-valuenow={Math.round((downloadProgress.loaded / Math.max(1, downloadProgress.total)) * 100)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label="On-device model download progress"
                >
                  <div
                    className="h-full bg-[var(--color-primary)] transition-all duration-150"
                    style={{ width: `${Math.min(100, (downloadProgress.loaded / Math.max(1, downloadProgress.total)) * 100)}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  {Math.round(downloadProgress.loaded / (1024 * 1024))} MB of {Math.round(downloadProgress.total / (1024 * 1024))} MB downloaded
                </p>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="button"
                className="nm-button-ghost h-8"
                disabled={!adminOn || downloadProgress !== null}
                aria-describedby="client-inference-predownload-help"
                onClick={handlePreDownload}
              >
                {modelDownloaded ? 'Re-download on-device model' : 'Pre-download on-device model'}
              </button>

              {modelDownloaded && (
                <button
                  type="button"
                  data-testid="client-inference-clear-model"
                  className="nm-button-ghost h-8 text-destructive hover:bg-destructive/10"
                  disabled={downloadProgress !== null || isClearing}
                  onClick={handleClearModel}
                >
                  {isClearing ? 'Removing…' : 'Remove from browser'}
                </button>
              )}
            </div>

            {downloadError && (
              <p role="alert" className="text-xs leading-5 text-destructive">
                {downloadError}
              </p>
            )}
          </div>
        </div>
      </section>

      <section aria-labelledby="spellcheck-heading">
        <div className="mb-3">
          <h3 id="spellcheck-heading" className="text-sm font-semibold text-foreground">
            Spellcheck
          </h3>
          <p id="spellcheck-bilingual" className="mt-1 text-sm leading-6 text-muted-foreground">
            English and German. A word is flagged only if every enabled language rejects it.
          </p>
        </div>

        <div className="divide-y divide-border rounded-xl border border-border">
          <PreferenceSwitch
            id="client-spellcheck-enabled"
            checked={spellEnabled}
            onCheckedChange={setSpellEnabled}
            describedBy="spellcheck-bilingual"
            label="Spellcheck"
            help="Hunspell-format English and German lint in the article editor. Does not use the on-device GPU model."
          />

          <fieldset className="px-4 py-4">
            <legend className="text-sm font-medium text-foreground">Languages</legend>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
              Keep at least one language on while spellcheck is enabled.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {SPELL_LANGUAGES.map((option) => {
                const checked = spellLangs.includes(option.value);
                const lastOn = spellEnabled && checked && spellLangs.length === 1;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    aria-disabled={lastOn || undefined}
                    onClick={() => toggleSpellLanguage(option.value)}
                    className={cn(
                      'rounded-lg border px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      checked
                        ? 'border-border-interactive bg-muted text-foreground'
                        : 'border-border text-muted-foreground hover:border-border-interactive',
                      lastOn && 'opacity-70',
                    )}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </fieldset>
        </div>
      </section>
      <section aria-labelledby="editor-keybindings-heading">
        <div className="mb-3">
          <h3 id="editor-keybindings-heading" className="text-sm font-semibold text-foreground">
            Keybindings & Editing Mode
          </h3>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Configure navigation and keyboard editing behaviors for the article editor.
          </p>
        </div>

        <div className="divide-y divide-border rounded-xl border border-border">
          <PreferenceSwitch
            id="vim-mode-toggle"
            checked={vimModeEnabled}
            onCheckedChange={setVimModeEnabled}
            label="Vim mode"
            help="Navigate and edit pages using Vim keybindings."
          />
        </div>
      </section>

      {isAdmin && (
        <div className="border-t border-border pt-6">
          <CollabEditingCard />
        </div>
      )}

      <button
        type="button"
        className="nm-button-primary"
        disabled={!changed}
        onClick={() => onSave({
          inlineCompletionEnabled: enabled,
          inlineCompletionDelay: delay,
          inlineCompletionMode: mode,
          inlineCompletionCodeOnly: codeOnly,
          ...(adminOn ? { clientInferenceEnabled: clientEnabled } : {}),
          clientInferenceWithoutServer: withoutServer,
          clientSpellcheckEnabled: spellEnabled,
          clientSpellcheckLanguages: spellLangs,
        })}
        data-testid="editor-preferences-save"
      >
        Save
      </button>
    </div>
  );
}
