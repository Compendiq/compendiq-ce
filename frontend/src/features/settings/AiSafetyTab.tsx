import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiFetch } from '../../shared/lib/api';
import type { ReferenceAction } from '@compendiq/contracts';

interface AdminSettings {
  aiGuardrailNoFabrication?: string;
  aiGuardrailNoFabricationEnabled?: boolean;
  aiOutputRuleStripReferences?: boolean;
  aiOutputRuleReferenceAction?: ReferenceAction;
  [key: string]: unknown;
}

const DEFAULT_GUARDRAIL_TEXT =
  'IMPORTANT: Do not fabricate, invent, or hallucinate references, sources, URLs, citations, or bibliographic entries. If you do not have a verified source for a claim, say so explicitly. Never generate fake links or made-up author names. Only cite sources that were provided to you in the context.';

const REFERENCE_ACTIONS: Array<{ value: ReferenceAction; label: string; description: string }> = [
  { value: 'flag', label: 'Flag with disclaimer', description: 'Keep references but prepend an AI-generated warning.' },
  { value: 'strip', label: 'Strip entirely', description: 'Remove the reference section from the output.' },
  { value: 'off', label: 'No action', description: 'Do not modify LLM output (not recommended).' },
];

export function AiSafetyTab() {
  const queryClient = useQueryClient();

  const { data: settings, isLoading } = useQuery<AdminSettings>({
    queryKey: ['admin-settings'],
    queryFn: () => apiFetch('/admin/settings'),
  });

  const [guardrailEnabled, setGuardrailEnabled] = useState(true);
  const [guardrailText, setGuardrailText] = useState(DEFAULT_GUARDRAIL_TEXT);
  const [stripReferences, setStripReferences] = useState(true);
  const [referenceAction, setReferenceAction] = useState<ReferenceAction>('flag');

  // Initialize form from settings
  useEffect(() => {
    if (settings) {
      setGuardrailEnabled(settings.aiGuardrailNoFabricationEnabled ?? true);
      setGuardrailText(settings.aiGuardrailNoFabrication ?? DEFAULT_GUARDRAIL_TEXT);
      setStripReferences(settings.aiOutputRuleStripReferences ?? true);
      setReferenceAction(settings.aiOutputRuleReferenceAction ?? 'flag');
    }
  }, [settings]);

  const mutation = useMutation({
    mutationFn: (body: Partial<AdminSettings>) =>
      apiFetch('/admin/settings', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
      queryClient.invalidateQueries({ queryKey: ['settings', 'ai-safety'] });
      toast.success('AI Safety settings updated');
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to update settings');
    },
  });

  const hasChanges =
    guardrailEnabled !== (settings?.aiGuardrailNoFabricationEnabled ?? true) ||
    guardrailText !== (settings?.aiGuardrailNoFabrication ?? DEFAULT_GUARDRAIL_TEXT) ||
    stripReferences !== (settings?.aiOutputRuleStripReferences ?? true) ||
    referenceAction !== (settings?.aiOutputRuleReferenceAction ?? 'flag');

  function handleSave() {
    mutation.mutate({
      aiGuardrailNoFabricationEnabled: guardrailEnabled,
      aiGuardrailNoFabrication: guardrailText,
      aiOutputRuleStripReferences: stripReferences,
      aiOutputRuleReferenceAction: referenceAction,
    });
  }

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading...</div>;
  }

  return (
    <div className="space-y-8">
      {/* Section 1: AI Guardrails */}
      <div>
        <h3 className="text-base font-semibold">AI Guardrails</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Instructions appended to all LLM system prompts to prevent hallucinated content.
        </p>

        <label className="mt-4 flex items-center gap-2" data-testid="ai-guardrail-toggle">
          <input
            type="checkbox"
            checked={guardrailEnabled}
            onChange={(e) => setGuardrailEnabled(e.target.checked)}
            className="rounded border-border/40"
          />
          <span className="text-sm font-medium">Enable no-fabrication guardrail</span>
        </label>

        {guardrailEnabled && (
          <div className="mt-3">
            <label className="mb-1 block text-sm font-medium">Guardrail instruction text</label>
            <textarea
              value={guardrailText}
              onChange={(e) => setGuardrailText(e.target.value)}
              rows={4}
              className="nm-input w-full resize-y font-mono text-xs"
              placeholder={DEFAULT_GUARDRAIL_TEXT}
              data-testid="ai-guardrail-text"
            />
            {guardrailText !== DEFAULT_GUARDRAIL_TEXT && (
              <button
                onClick={() => setGuardrailText(DEFAULT_GUARDRAIL_TEXT)}
                className="mt-1 text-xs text-muted-foreground hover:text-destructive"
              >
                Reset to default
              </button>
            )}
            <p className="mt-1 text-xs text-muted-foreground">
              This text is appended to every LLM system prompt for all users. Changes take effect within 60 seconds.
            </p>
          </div>
        )}
      </div>

      {/* Section 2: Output Rules */}
      <div className="border-t border-border/40 pt-6">
        <h3 className="text-base font-semibold">AI Output Rules</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Post-processing rules applied to LLM output before it reaches the user.
        </p>

        <label className="mt-4 flex items-center gap-2" data-testid="ai-output-rule-toggle">
          <input
            type="checkbox"
            checked={stripReferences}
            onChange={(e) => setStripReferences(e.target.checked)}
            className="rounded border-border/40"
          />
          <span className="text-sm font-medium">Enable reference section detection</span>
        </label>

        {stripReferences && (
          <div className="mt-3 space-y-2">
            <label className="block text-sm font-medium">When unverified references are detected:</label>
            {REFERENCE_ACTIONS.map((action) => (
              <label
                key={action.value}
                className="flex items-start gap-2"
                data-testid={`ai-output-action-${action.value}`}
              >
                <input
                  type="radio"
                  name="referenceAction"
                  value={action.value}
                  checked={referenceAction === action.value}
                  onChange={() => setReferenceAction(action.value)}
                  className="mt-1"
                />
                <div>
                  <span className="text-sm font-medium">{action.label}</span>
                  <p className="text-xs text-muted-foreground">{action.description}</p>
                </div>
              </label>
            ))}
          </div>
        )}
      </div>

      {/* Save button */}
      <div className="border-t border-border/40 pt-4">
        <button
          onClick={handleSave}
          disabled={!hasChanges || mutation.isPending}
          className="nm-button-primary"
          data-testid="ai-safety-save-btn"
        >
          {mutation.isPending ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  );
}
