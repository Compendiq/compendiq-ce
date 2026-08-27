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
}: {
  settings: SettingsResponse;
  onSave: (value: Record<string, unknown>) => void;
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
  const adminOn = settings.clientInferenceAdminEnabled;
  const [manifestBytes, setManifestBytes] = useState<number | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void apiFetch<ClientAssetManifest>('/models/client-assets')
      .then((manifest) => {
        if (cancelled) return;
        const onnx = manifest.models.find((m) => m.kind === 'onnx');
        setManifestBytes(onnx?.bytes && onnx.bytes > 0 ? onnx.bytes : null);
      })
      .catch(() => {
        if (!cancelled) setManifestBytes(null);
      });
    return () => { cancelled = true; };
  }, []);
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

          <div className="px-4 py-4">
            <button
              type="button"
              className="nm-button-ghost h-8"
              disabled={!adminOn || downloadProgress !== null}
              aria-describedby="client-inference-predownload-help"
              onClick={() => {
                if (!adminOn || downloadProgress) return;
                setDownloadError(null);
                getClientInferenceManager().setFlags({
                  adminEnabled: adminOn,
                  userEnabled: clientEnabled,
                });
                void getClientInferenceManager()
                  .predownload((loaded, total) => setDownloadProgress({ loaded, total }))
                  .catch((err: unknown) => {
                    setDownloadError(err instanceof Error ? err.message : 'Download failed');
                  })
                  .finally(() => setDownloadProgress(null));
              }}
            >
              Pre-download on-device model
            </button>
            <p id="client-inference-predownload-help" className="mt-2 text-xs leading-5 text-muted-foreground">
              Downloads only in this browser
              {manifestBytes != null ? ` (${Math.round(manifestBytes / (1024 * 1024))} MB).` : '.'}
              {' '}The on-device model is not shared with other browsers.
            </p>
            {downloadProgress && (
              <div
                className="mt-2 h-1 overflow-hidden rounded bg-muted"
                aria-hidden="true"
              >
                <div
                  className="h-full bg-[var(--color-status-embedding)]"
                  style={{ width: `${Math.min(100, (downloadProgress.loaded / downloadProgress.total) * 100)}%` }}
                />
              </div>
            )}
            {downloadError && (
              <p className="mt-2 text-xs leading-5 text-muted-foreground">{downloadError}</p>
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
