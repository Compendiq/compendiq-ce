import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientAssetManifest, SettingsResponse } from '@compendiq/contracts';
import { EditorPreferencesTab } from './EditorPreferencesTab';
import { useUiStore } from '../../stores/ui-store';
import * as apiModule from '../../shared/lib/api';
import { getClientInferenceManager } from '../../shared/lib/client-inference/client-inference-manager';

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
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual([
      'Inline suggestions',
      'On-device suggestions (WebGPU)',
      'Spellcheck',
      'Keybindings & Editing Mode',
    ]);
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

  it('renders "Not downloaded" badge when model is not cached', async () => {
    const mgr = getClientInferenceManager();
    vi.spyOn(mgr, 'isModelDownloaded').mockResolvedValue(false);

    render(<EditorPreferencesTab settings={{ ...settings, clientInferenceAdminEnabled: true }} onSave={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId('client-inference-status-not-downloaded')).toBeInTheDocument();
    });
    expect(screen.getByText('Not downloaded')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pre-download on-device model' })).toBeInTheDocument();
    expect(screen.queryByTestId('client-inference-clear-model')).not.toBeInTheDocument();
  });

  it('renders "Downloaded & ready" badge and action buttons when model is cached', async () => {
    const mgr = getClientInferenceManager();
    vi.spyOn(mgr, 'isModelDownloaded').mockResolvedValue(true);
    vi.spyOn(apiModule, 'apiFetch').mockImplementation(async (path: string) => {
      if (path === '/models/client-assets') {
        return {
          enabled: true,
          activeModelId: 'qwen2.5-0.5b-instruct-q4',
          models: [
            {
              id: 'qwen2.5-0.5b-instruct-q4',
              kind: 'onnx',
              bytes: 250 * 1024 * 1024,
              installed: true,
              available: true,
              repo: 'onnx-community/Qwen2.5-0.5B-Instruct',
              files: [{ name: 'onnx/model_q4.onnx', bytes: 250 * 1024 * 1024 }],
            },
          ],
        } as ClientAssetManifest;
      }
      return {} as unknown;
    });

    render(<EditorPreferencesTab settings={{ ...settings, clientInferenceAdminEnabled: true }} onSave={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId('client-inference-status-downloaded')).toBeInTheDocument();
    });
    expect(screen.getByText('Downloaded & ready')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Re-download on-device model' })).toBeInTheDocument();
    expect(screen.getByTestId('client-inference-clear-model')).toBeInTheDocument();
    expect(screen.getByText(/250 MB/)).toBeInTheDocument();
  });

  it('clears downloaded model when Remove from browser button is clicked', async () => {
    const mgr = getClientInferenceManager();
    vi.spyOn(mgr, 'isModelDownloaded').mockResolvedValue(true);
    const clearSpy = vi.spyOn(mgr, 'clearDownloadedModel').mockResolvedValue();

    render(<EditorPreferencesTab settings={{ ...settings, clientInferenceAdminEnabled: true }} onSave={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId('client-inference-clear-model')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('client-inference-clear-model'));

    await waitFor(() => {
      expect(clearSpy).toHaveBeenCalled();
      expect(screen.getByTestId('client-inference-status-not-downloaded')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Pre-download on-device model' })).toBeInTheDocument();
  });

  it('updates progress and transitions to downloaded when Pre-download succeeds', async () => {
    const mgr = getClientInferenceManager();
    vi.spyOn(mgr, 'isModelDownloaded').mockResolvedValue(false);
    vi.spyOn(mgr, 'predownload').mockImplementation(async (onProgress) => {
      onProgress?.(100 * 1024 * 1024, 200 * 1024 * 1024);
    });

    render(<EditorPreferencesTab settings={{ ...settings, clientInferenceAdminEnabled: true }} onSave={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Pre-download on-device model' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Pre-download on-device model' }));

    await waitFor(() => {
      expect(screen.getByTestId('client-inference-status-downloaded')).toBeInTheDocument();
    });
  });

  it('shows error alert if predownload fails', async () => {
    const mgr = getClientInferenceManager();
    vi.spyOn(mgr, 'isModelDownloaded').mockResolvedValue(false);
    vi.spyOn(mgr, 'predownload').mockRejectedValue(new Error('Network connection failed'));

    render(<EditorPreferencesTab settings={{ ...settings, clientInferenceAdminEnabled: true }} onSave={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Pre-download on-device model' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Pre-download on-device model' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Network connection failed');
    });
  });
});

describe('EditorPreferencesTab vim mode toggle', () => {
  afterEach(() => {
    useUiStore.setState({ vimModeEnabled: false });
  });

  it('renders unchecked by default', () => {
    render(<EditorPreferencesTab settings={settings} onSave={vi.fn()} />);
    expect(screen.getByTestId('vim-mode-toggle')).toHaveAttribute('data-state', 'unchecked');
  });

  it('reflects an already-enabled preference', () => {
    useUiStore.setState({ vimModeEnabled: true });
    render(<EditorPreferencesTab settings={settings} onSave={vi.fn()} />);
    expect(screen.getByTestId('vim-mode-toggle')).toHaveAttribute('data-state', 'checked');
  });

  it('toggles the shared ui-store preference, not local component state', () => {
    render(<EditorPreferencesTab settings={settings} onSave={vi.fn()} />);
    fireEvent.click(screen.getByTestId('vim-mode-toggle'));
    expect(useUiStore.getState().vimModeEnabled).toBe(true);
    fireEvent.click(screen.getByTestId('vim-mode-toggle'));
    expect(useUiStore.getState().vimModeEnabled).toBe(false);
  });
});
