import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SettingsResponse, CustomPrompts } from '@compendiq/contracts';
import { apiFetch } from '../../../shared/lib/api';
import { PanelHeader } from '../PanelHeader';

const IMPROVE_PROMPT_TYPES = [
  {
    key: 'improve_grammar' as const,
    label: 'Grammar',
    description: 'Fix spelling, grammar, and punctuation without changing meaning.',
    placeholder: 'You are a technical writing assistant. Improve the grammar, spelling, and punctuation of the following article while preserving its meaning and structure. Return the improved text in Markdown format. Only output the improved text, no explanations.',
  },
  {
    key: 'improve_structure' as const,
    label: 'Structure',
    description: 'Reorganize headings, paragraph flow, and logical order.',
    placeholder: 'You are a technical writing assistant. Improve the structure and organization of the following article. Add clear headings, improve paragraph flow, and ensure logical order. Return the improved text in Markdown format. Only output the improved text, no explanations.',
  },
  {
    key: 'improve_clarity' as const,
    label: 'Clarity',
    description: 'Simplify complex sentences and remove unnecessary jargon.',
    placeholder: 'You are a technical writing assistant. Improve the clarity and readability of the following article. Simplify complex sentences, remove jargon where possible, and ensure each point is clear. Return the improved text in Markdown format. Only output the improved text, no explanations.',
  },
  {
    key: 'improve_technical' as const,
    label: 'Technical',
    description: 'Fix technical errors and add missing technical details.',
    placeholder: 'You are a technical expert reviewer. Review the following article for technical accuracy. Fix any technical errors, update outdated information, and add missing technical details. Return the improved text in Markdown format. Only output the improved text, no explanations.',
  },
  {
    key: 'improve_completeness' as const,
    label: 'Completeness',
    description: 'Fill gaps, add missing sections, and include examples.',
    placeholder: 'You are a technical writing assistant. Review the following article for completeness. Identify and fill in any missing sections, add examples where helpful, and ensure all topics are adequately covered. Return the improved text in Markdown format. Only output the improved text, no explanations.',
  },
];

const CREATE_PROMPT_TYPES = [
  {
    key: 'generate_spec' as const,
    label: 'Technical Spec / RFC',
    description: 'System prompt used for drafting technical specifications, system architecture, and RFCs.',
    placeholder: 'You are a software architect and technical lead. Generate a comprehensive technical specification and RFC with: Overview & Motivation, Architecture & System Design, API Contracts & Interfaces, Data Models & Storage, Rollout & Migration Plan, Security & Failure Modes, and Open Questions. Return in Markdown format.',
  },
  {
    key: 'generate_guide' as const,
    label: 'How-To Guide / Runbook',
    description: 'System prompt used for creating step-by-step how-to procedures, guides, and runbooks.',
    placeholder: 'You are a technical documentation writer. Generate a step-by-step how-to guide and runbook with: Overview, Prerequisites & Permissions, Step-by-Step Instructions with code/command examples, Verification & Testing, and Troubleshooting & Rollback. Return in Markdown format.',
  },
  {
    key: 'generate_notes' as const,
    label: 'Meeting Notes & Actions',
    description: 'System prompt used for structuring meeting notes, key decisions, and action items table.',
    placeholder: 'You are an executive assistant and technical scribe. Generate structured meeting notes with: Meeting Objective & Date/Attendees, Executive Summary, Key Decisions Made, Detailed Discussion Topics, and an Action Items Table with Owner and Due Date columns. Return in Markdown format.',
  },
  {
    key: 'generate_postmortem' as const,
    label: 'Incident Post-Mortem',
    description: 'System prompt used for incident retrospectives, timeline analysis, root causes, and preventative measures.',
    placeholder: 'You are a reliability engineer. Generate an incident post-mortem report with: Incident Summary & Severity, Impact & Duration, Timeline of Events (UTC), Root Cause Analysis (5 Whys), Resolution & Recovery, What Went Well / What Went Wrong, and Action Items with Preventative Measures. Return in Markdown format.',
  },
  {
    key: 'generate' as const,
    label: 'Custom Topic / General Draft',
    description: 'System prompt used when generating general documentation or custom topic drafts from scratch.',
    placeholder: 'You are a technical documentation writer. Generate a well-structured knowledge base article based on the user\'s request. Use clear headings, code examples where appropriate, and follow best practices for technical documentation. Return the article in Markdown format.',
  },
];

export function AiPromptsTab({ settings, onSave, isAdmin }: { settings: SettingsResponse; onSave: (v: Record<string, unknown>) => void; isAdmin: boolean }) {
  const [prompts, setPrompts] = useState<CustomPrompts>(settings.customPrompts ?? {});
  const saved = settings.customPrompts ?? {};

  // Fetch AI safety status for info banner
  const { data: aiSafety } = useQuery<{
    guardrails: { noFabricationEnabled: boolean };
    outputRules: { stripReferences: boolean; referenceAction: string };
  }>({
    queryKey: ['settings', 'ai-safety'],
    queryFn: () => apiFetch('/settings/ai-safety'),
    staleTime: 60_000,
  });
  const hasChanges = JSON.stringify(prompts) !== JSON.stringify(saved);

  function handleChange(key: string, value: string) {
    setPrompts((prev) => {
      const next = { ...prev };
      if (value.trim()) {
        next[key as keyof CustomPrompts] = value;
      } else {
        delete next[key as keyof CustomPrompts];
      }
      return next;
    });
  }

  return (
    <div className="space-y-6">
      <PanelHeader
        subtitle="Override the instructions Compendiq sends to the model for each task. Leave a field empty to use the built-in prompt."
      />

      {/* Active AI Safety rules info banner */}
      {aiSafety && (aiSafety.guardrails.noFabricationEnabled || aiSafety.outputRules.stripReferences) && (
        <div className="rounded-lg border border-info/30 bg-info/10 p-3 text-sm" data-testid="ai-safety-banner">
          <p className="font-medium text-info">Active AI Safety Rules</p>
          <ul className="mt-1 list-disc pl-5 text-xs text-info">
            {aiSafety.guardrails.noFabricationEnabled && (
              <li>No-fabrication guardrail active (prevents hallucinated references)</li>
            )}
            {aiSafety.outputRules.stripReferences && (
              <li>Reference detection active (action: {aiSafety.outputRules.referenceAction})</li>
            )}
          </ul>
          {isAdmin && (
            <p className="mt-1 text-xs text-info">
              Manage these rules in the AI Safety tab.
            </p>
          )}
        </div>
      )}

      <div>
        <p className="text-sm text-muted-foreground">
          Customize the system prompts used by the AI Improver and Create Skills. Leave empty to use the built-in default.
          The language preservation instruction is always appended automatically.
        </p>
      </div>

      <div className="space-y-4">
        <h3 className="text-sm font-semibold text-foreground">
          Improvement Prompts
        </h3>
        {IMPROVE_PROMPT_TYPES.map((pt) => (
          <div key={pt.key}>
            <label htmlFor={`prompt-input-${pt.key}`} className="mb-1 block text-sm font-medium">{pt.label}</label>
            <p className="mb-1.5 text-xs text-muted-foreground">{pt.description}</p>
            <textarea
              id={`prompt-input-${pt.key}`}
              value={prompts[pt.key] ?? ''}
              onChange={(e) => handleChange(pt.key, e.target.value)}
              placeholder={pt.placeholder}
              rows={3}
              className="nm-input w-full resize-y font-mono text-xs"
              data-testid={`prompt-${pt.key}`}
            />
            {prompts[pt.key] && (
              <button
                type="button"
                onClick={() => handleChange(pt.key, '')}
                className="mt-1 text-xs text-muted-foreground transition-colors hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-[var(--radius-sm)]"
              >
                Reset to default
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="space-y-4 pt-2">
        <h3 className="text-sm font-semibold text-foreground">
          Create Skills Prompts
        </h3>
        {CREATE_PROMPT_TYPES.map((pt) => (
          <div key={pt.key}>
            <label htmlFor={`prompt-input-${pt.key}`} className="mb-1 block text-sm font-medium">{pt.label}</label>
            <p className="mb-1.5 text-xs text-muted-foreground">{pt.description}</p>
            <textarea
              id={`prompt-input-${pt.key}`}
              value={prompts[pt.key] ?? ''}
              onChange={(e) => handleChange(pt.key, e.target.value)}
              placeholder={pt.placeholder}
              rows={3}
              className="nm-input w-full resize-y font-mono text-xs"
              data-testid={`prompt-${pt.key}`}
            />
            {prompts[pt.key] && (
              <button
                type="button"
                onClick={() => handleChange(pt.key, '')}
                className="mt-1 text-xs text-muted-foreground transition-colors hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-[var(--radius-sm)]"
              >
                Reset to default
              </button>
            )}
          </div>
        ))}
      </div>

      <div>
        <button
          onClick={() => onSave({ customPrompts: prompts })}
          disabled={!hasChanges}
          className="nm-button-primary"
          data-testid="ai-prompts-save-btn"
        >
          Save
        </button>
      </div>
    </div>
  );
}
