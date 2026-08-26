import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SettingsResponse } from '@compendiq/contracts';
import { EditorPreferencesTab } from './EditorPreferencesTab';

const settings: SettingsResponse = {
  confluenceUrl: null,
  hasConfluencePat: false,
  selectedSpaces: [],
  theme: 'dark',
  syncIntervalMin: 15,
  confluenceConnected: false,
  showSpaceHomeContent: true,
  customPrompts: {},
  confluencePatPromptDismissed: false,
  inlineCompletionEnabled: true,
  inlineCompletionDelay: 'balanced',
  inlineCompletionMode: 'full',
  inlineCompletionCodeOnly: false,
  clientInferenceEnabled: false,
  clientInferenceWithoutServer: true,
  clientInferenceAdminEnabled: false,
  clientSpellcheckEnabled: false,
  clientSpellcheckLanguages: ['en_US', 'de_DE'],
  onboardingState: {
    firstAiQueryMade: false,
    shortcutsModalViewed: false,
    pageCreatedOrEdited: false,
    dismissed: false,
    completedAt: null,
  },
};

describe('EditorPreferencesTab (#1417)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows every preference with the documented defaults', () => {
    render(<EditorPreferencesTab settings={settings} onSave={vi.fn()} />);
    expect(screen.getByRole('switch', { name: 'Show inline suggestions' })).toBeChecked();
    expect(screen.getByTestId('inline-delay-balanced')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('inline-mode-full')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: 'Code blocks only' })).not.toBeChecked();
    expect(screen.getByTestId('editor-preferences-save')).toBeDisabled();
  });

  it('saves enablement, delay, mode, and code-only together', () => {
    const onSave = vi.fn();
    render(<EditorPreferencesTab settings={settings} onSave={onSave} />);
    fireEvent.click(screen.getByTestId('inline-delay-deliberate'));
    fireEvent.click(screen.getByTestId('inline-mode-word'));
    fireEvent.click(screen.getByRole('switch', { name: 'Code blocks only' }));
    fireEvent.click(screen.getByTestId('editor-preferences-save'));
    expect(onSave).toHaveBeenCalledWith({
      inlineCompletionEnabled: true,
      inlineCompletionDelay: 'deliberate',
      inlineCompletionMode: 'word',
      inlineCompletionCodeOnly: true,
      clientInferenceWithoutServer: true,
      clientSpellcheckEnabled: false,
      clientSpellcheckLanguages: ['en_US', 'de_DE'],
    });
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty('clientInferenceEnabled');
  });

  it('disables automatic delay choices when suggestions are off', () => {
    render(<EditorPreferencesTab settings={settings} onSave={vi.fn()} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Show inline suggestions' }));
    expect(screen.getByTestId('inline-delay-fast')).toBeDisabled();
    expect(screen.getByTestId('inline-mode-word')).toBeDisabled();
  });

  it('uses macOS Option and Command names in shortcut help', () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    );
    render(<EditorPreferencesTab settings={settings} onSave={vi.fn()} />);

    expect(screen.getByText(/Option\+\\ or Command\+Shift\+Space/)).toBeInTheDocument();
    expect(screen.getByText(/Accept one word with Option\+\]/)).toBeInTheDocument();
  });
});

describe('EditorPreferencesTab on-device shells (#1418)', () => {
  it('renders on-device, unassigned-server, pre-download, and spellcheck in order', () => {
    render(<EditorPreferencesTab settings={settings} onSave={vi.fn()} />);
    const headings = screen.getAllByRole('heading', { level: 3 }).map((el) => el.textContent);
    expect(headings).toEqual([
      'Inline suggestions',
      'On-device suggestions (WebGPU)',
      'Spellcheck',
    ]);
    expect(screen.getByRole('switch', { name: 'On-device suggestions (WebGPU)' })).toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: 'Use on-device suggestions when no server model is assigned' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pre-download on-device model' })).toBeInTheDocument();
    expect(screen.getByText(
      'Falls back to the server model when the on-device model is not ready.',
    )).toBeInTheDocument();
    expect(screen.getByText(
      'English and German. A word is flagged only if every enabled language rejects it.',
    )).toBeInTheDocument();
  });

  it('cannot enable on-device suggestions when the admin flag is off', () => {
    render(<EditorPreferencesTab settings={settings} onSave={vi.fn()} />);
    const toggle = screen.getByRole('switch', { name: 'On-device suggestions (WebGPU)' });
    expect(toggle).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(screen.getByTestId('editor-preferences-save')).toBeDisabled();
  });

  it('keeps the unassigned-server control off until the parent toggle is on', () => {
    render(
      <EditorPreferencesTab
        settings={{ ...settings, clientInferenceAdminEnabled: true }}
        onSave={vi.fn()}
      />,
    );
    const child = screen.getByRole('switch', {
      name: 'Use on-device suggestions when no server model is assigned',
    });
    expect(child).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getByRole('switch', { name: 'On-device suggestions (WebGPU)' }));
    expect(child).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('omits clientInferenceEnabled on Save when the admin flag is off', () => {
    const onSave = vi.fn();
    render(
      <EditorPreferencesTab
        settings={{
          ...settings,
          clientInferenceEnabled: true,
          clientInferenceAdminEnabled: false,
        }}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByTestId('inline-delay-deliberate'));
    fireEvent.click(screen.getByTestId('editor-preferences-save'));
    expect(onSave).toHaveBeenCalledTimes(1);
    const payload = onSave.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('clientInferenceEnabled');
    expect(payload.inlineCompletionDelay).toBe('deliberate');
  });

  it('saves on-device and spellcheck prefs together with inline suggestions', () => {
    const onSave = vi.fn();
    render(
      <EditorPreferencesTab
        settings={{ ...settings, clientInferenceAdminEnabled: true }}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByRole('switch', { name: 'On-device suggestions (WebGPU)' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Spellcheck' }));
    fireEvent.click(screen.getByTestId('editor-preferences-save'));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      inlineCompletionEnabled: true,
      clientInferenceEnabled: true,
      clientInferenceWithoutServer: true,
      clientSpellcheckEnabled: true,
      clientSpellcheckLanguages: ['en_US', 'de_DE'],
    }));
  });

  it('does not uncheck the last remaining spell language while spellcheck is on', () => {
    render(
      <EditorPreferencesTab
        settings={{
          ...settings,
          clientSpellcheckEnabled: true,
          clientSpellcheckLanguages: ['en_US'],
        }}
        onSave={vi.fn()}
      />,
    );
    const english = screen.getByRole('checkbox', { name: 'English (US)' });
    expect(english).toHaveAttribute('aria-checked', 'true');
    expect(english).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(english);
    expect(english).toHaveAttribute('aria-checked', 'true');
  });

  it('wires visible help through aria-describedby on each new control', () => {
    render(
      <EditorPreferencesTab
        settings={{ ...settings, clientInferenceAdminEnabled: true }}
        onSave={vi.fn()}
      />,
    );
    const onDevice = screen.getByRole('switch', { name: 'On-device suggestions (WebGPU)' });
    const described = onDevice.getAttribute('aria-describedby') ?? '';
    expect(described.length).toBeGreaterThan(0);
    for (const id of described.split(/\s+/)) {
      const region = document.getElementById(id);
      expect(region).not.toBeNull();
      expect(region!.querySelector('a,button,input,select,textarea')).toBeNull();
    }
  });

  it('uses a ghost Pre-download control, not a filled primary', () => {
    render(<EditorPreferencesTab settings={settings} onSave={vi.fn()} />);
    const predownload = screen.getByRole('button', { name: 'Pre-download on-device model' });
    expect(predownload.className).toMatch(/nm-button-ghost/);
    expect(predownload.className).toMatch(/h-8/);
    expect(predownload.className).not.toMatch(/nm-button-primary/);
  });
});
