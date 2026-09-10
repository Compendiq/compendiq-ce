import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AiPromptsTab } from './AiPromptsTab';
import type { SettingsResponse } from '@compendiq/contracts';

vi.mock('../../../shared/lib/api', () => ({
  apiFetch: vi.fn().mockResolvedValue({
    guardrails: { noFabricationEnabled: false },
    outputRules: { stripReferences: false, referenceAction: 'flag' },
  }),
}));

describe('AiPromptsTab', () => {
  let queryClient: QueryClient;
  let onSave: ReturnType<typeof vi.fn>;

  const mockSettings: SettingsResponse = {
    confluenceUrl: 'https://confluence.example.com',
    hasConfluencePat: true,
    selectedSpaces: ['ENG'],
    theme: 'graphite',
    syncIntervalMin: 15,
    confluenceConnected: true,
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

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    onSave = vi.fn();
  });

  function renderComponent(settings: SettingsResponse = mockSettings) {
    return render(
      <QueryClientProvider client={queryClient}>
        <AiPromptsTab settings={settings} onSave={onSave} isAdmin={true} />
      </QueryClientProvider>,
    );
  }

  it('renders all improvement prompt textareas', () => {
    renderComponent();

    expect(screen.getByTestId('prompt-improve_grammar')).toBeInTheDocument();
    expect(screen.getByTestId('prompt-improve_structure')).toBeInTheDocument();
    expect(screen.getByTestId('prompt-improve_clarity')).toBeInTheDocument();
    expect(screen.getByTestId('prompt-improve_technical')).toBeInTheDocument();
    expect(screen.getByTestId('prompt-improve_completeness')).toBeInTheDocument();
  });

  it('renders all create skill prompt textareas', () => {
    renderComponent();

    expect(screen.getByTestId('prompt-generate_spec')).toBeInTheDocument();
    expect(screen.getByTestId('prompt-generate_guide')).toBeInTheDocument();
    expect(screen.getByTestId('prompt-generate_notes')).toBeInTheDocument();
    expect(screen.getByTestId('prompt-generate_postmortem')).toBeInTheDocument();
    expect(screen.getByTestId('prompt-generate')).toBeInTheDocument();
  });

  it('allows customizing a create skill prompt and saving changes', () => {
    renderComponent();

    const specTextarea = screen.getByTestId('prompt-generate_spec');
    fireEvent.change(specTextarea, {
      target: { value: 'Custom architecture RFC prompt instructions' },
    });

    const saveBtn = screen.getByTestId('ai-prompts-save-btn');
    expect(saveBtn).not.toBeDisabled();

    fireEvent.click(saveBtn);
    expect(onSave).toHaveBeenCalledWith({
      customPrompts: {
        generate_spec: 'Custom architecture RFC prompt instructions',
      },
    });
  });

  it('displays existing custom prompts and allows resetting to default', () => {
    const settingsWithPrompts: SettingsResponse = {
      ...mockSettings,
      customPrompts: {
        generate_guide: 'My custom runbook instructions',
      },
    };

    renderComponent(settingsWithPrompts);

    const guideTextarea = screen.getByTestId('prompt-generate_guide');
    expect(guideTextarea).toHaveValue('My custom runbook instructions');

    const resetButtons = screen.getAllByRole('button', { name: /reset to default/i });
    expect(resetButtons.length).toBeGreaterThanOrEqual(1);

    fireEvent.click(resetButtons[0]!);
    expect(guideTextarea).toHaveValue('');

    const saveBtn = screen.getByTestId('ai-prompts-save-btn');
    expect(saveBtn).not.toBeDisabled();

    fireEvent.click(saveBtn);
    expect(onSave).toHaveBeenCalledWith({
      customPrompts: {},
    });
  });
});
