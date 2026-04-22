import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SettingsResponse, CustomPrompts } from '@compendiq/contracts';
import { apiFetch } from '../../../shared/lib/api';

const PROMPT_TYPES = [
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
      {/* Active AI Safety rules info banner */}
      {aiSafety && (aiSafety.guardrails.noFabricationEnabled || aiSafety.outputRules.stripReferences) && (
        <div className="rounded-lg border border-sky-500/30 bg-sky-500/10 p-3 text-sm" data-testid="ai-safety-banner">
          <p className="font-medium text-sky-300">Active AI Safety Rules</p>
          <ul className="mt-1 list-disc pl-5 text-xs text-sky-300/80">
            {aiSafety.guardrails.noFabricationEnabled && (
              <li>No-fabrication guardrail active (prevents hallucinated references)</li>
            )}
            {aiSafety.outputRules.stripReferences && (
              <li>Reference detection active (action: {aiSafety.outputRules.referenceAction})</li>
            )}
          </ul>
          {isAdmin && (
            <p className="mt-1 text-xs text-sky-400/70">
              Manage these rules in the AI Safety tab.
            </p>
          )}
        </div>
      )}

      <div>
        <p className="text-sm text-muted-foreground">
          Customize the system prompts used by the AI Improver. Leave empty to use the built-in default.
          The language preservation instruction is always appended automatically.
        </p>
      </div>

      {PROMPT_TYPES.map((pt) => (
        <div key={pt.key}>
          <label className="mb-1 block text-sm font-medium">{pt.label}</label>
          <p className="mb-1.5 text-xs text-muted-foreground">{pt.description}</p>
          <textarea
            value={prompts[pt.key] ?? ''}
            onChange={(e) => handleChange(pt.key, e.target.value)}
            placeholder={pt.placeholder}
            rows={3}
            className="glass-input w-full resize-y font-mono text-xs"
            data-testid={`prompt-${pt.key}`}
          />
          {prompts[pt.key] && (
            <button
              onClick={() => handleChange(pt.key, '')}
              className="mt-1 text-xs text-muted-foreground hover:text-destructive"
            >
              Reset to default
            </button>
          )}
        </div>
      ))}

      <div>
        <button
          onClick={() => onSave({ customPrompts: prompts })}
          disabled={!hasChanges}
          className="glass-button-primary"
          data-testid="ai-prompts-save-btn"
        >
          Save
        </button>
      </div>
    </div>
  );
}
