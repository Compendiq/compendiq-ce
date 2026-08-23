import { useState } from 'react';
import * as Switch from '@radix-ui/react-switch';
import type {
  InlineCompletionDelay,
  InlineCompletionMode,
  SettingsResponse,
} from '@compendiq/contracts';
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

function PreferenceSwitch({
  id,
  checked,
  onCheckedChange,
  label,
  help,
}: {
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  help: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-4">
      <div className="min-w-0">
        <label htmlFor={id} className="cursor-pointer text-sm font-medium text-foreground">
          {label}
        </label>
        <p id={`${id}-help`} className="mt-0.5 text-xs leading-5 text-muted-foreground">
          {help}
        </p>
      </div>
      <Switch.Root
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-describedby={`${id}-help`}
        className="relative h-5 w-9 shrink-0 rounded-full bg-foreground/10 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring data-[state=checked]:bg-action"
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
  const changed = enabled !== settings.inlineCompletionEnabled
    || delay !== settings.inlineCompletionDelay
    || mode !== settings.inlineCompletionMode
    || codeOnly !== settings.inlineCompletionCodeOnly;
  const mac = isMac();

  return (
    <div className="space-y-6">
      <PanelHeader
        title="Editor"
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

      <button
        type="button"
        className="nm-button-primary"
        disabled={!changed}
        onClick={() => onSave({
          inlineCompletionEnabled: enabled,
          inlineCompletionDelay: delay,
          inlineCompletionMode: mode,
          inlineCompletionCodeOnly: codeOnly,
        })}
        data-testid="editor-preferences-save"
      >
        Save
      </button>
    </div>
  );
}
