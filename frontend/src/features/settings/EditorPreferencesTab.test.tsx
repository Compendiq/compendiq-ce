import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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
  inlineCompletionCodeOnly: false,
};

describe('EditorPreferencesTab (#1417)', () => {
  it('shows every preference with the documented defaults', () => {
    render(<EditorPreferencesTab settings={settings} onSave={vi.fn()} />);
    expect(screen.getByRole('switch', { name: 'Show inline suggestions' })).toBeChecked();
    expect(screen.getByTestId('inline-delay-balanced')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: 'Code blocks only' })).not.toBeChecked();
    expect(screen.getByTestId('editor-preferences-save')).toBeDisabled();
  });

  it('saves enablement, delay, and code-only together', () => {
    const onSave = vi.fn();
    render(<EditorPreferencesTab settings={settings} onSave={onSave} />);
    fireEvent.click(screen.getByTestId('inline-delay-deliberate'));
    fireEvent.click(screen.getByRole('switch', { name: 'Code blocks only' }));
    fireEvent.click(screen.getByTestId('editor-preferences-save'));
    expect(onSave).toHaveBeenCalledWith({
      inlineCompletionEnabled: true,
      inlineCompletionDelay: 'deliberate',
      inlineCompletionCodeOnly: true,
    });
  });

  it('disables automatic delay choices when suggestions are off', () => {
    render(<EditorPreferencesTab settings={settings} onSave={vi.fn()} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Show inline suggestions' }));
    expect(screen.getByTestId('inline-delay-fast')).toBeDisabled();
  });
});
