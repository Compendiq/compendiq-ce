import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { m, AnimatePresence } from 'framer-motion';
import { CompendiqLogo } from '../../shared/components/CompendiqLogo';
import { useSetupStatus } from '../../shared/hooks/useSetupStatus';
import { WelcomeStep } from './steps/WelcomeStep';
import { AdminStep } from './steps/AdminStep';
import { LlmStep } from './steps/LlmStep';
import { ConfluenceStep } from './steps/ConfluenceStep';
import { CompleteStep } from './steps/CompleteStep';

const STEPS = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'admin', label: 'Admin' },
  { id: 'llm', label: 'LLM' },
  { id: 'confluence', label: 'Confluence' },
  { id: 'complete', label: 'Complete' },
] as const;

const STORAGE_KEY = 'compendiq-setup-step';

/** Read persisted step from sessionStorage, falling back to the given default. */
function getPersistedStep(fallback: number): number {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw !== null) {
      const parsed = Number(raw);
      if (Number.isInteger(parsed) && parsed >= 0 && parsed < STEPS.length) {
        return parsed;
      }
    }
  } catch {
    // sessionStorage may be unavailable (e.g. security policy)
  }
  return fallback;
}

/**
 * Derive the earliest wizard step the user can meaningfully land on, given
 * the completion flags reported by `/api/health/setup-status`. Used at mount
 * time to resume a partially-completed wizard even if the user's
 * sessionStorage was wiped (incognito tab, different browser, etc).
 *
 * Returns the step index matching the first incomplete step. Falls back to
 * welcome (0) when nothing is configured yet. Kept module-private so this
 * file only exports the SetupWizard component (keeps the
 * `react-refresh/only-export-components` lint rule happy).
 */
function deriveMinStepFromBackend(steps: {
  admin: boolean;
  llm: boolean;
  confluence: boolean;
}): number {
  if (!steps.admin) return 0;      // welcome or admin (wizard walks welcome → admin)
  if (!steps.llm) return 2;         // LLM
  if (!steps.confluence) return 3;  // Confluence
  return STEPS.length - 1;          // all done → complete
}

export function SetupWizard() {
  const [searchParams] = useSearchParams();
  const isRerun = searchParams.get('rerun') === 'true';
  const { steps, isLoading: isSetupStatusLoading } = useSetupStatus();
  const adminExists = steps.admin;

  // Skip admin step when admin already exists; on rerun always start at LLM
  const initialStep = isRerun ? 2 : 0;
  const [currentStep, setCurrentStep] = useState(() => {
    // On rerun, ignore any stale persisted step and start fresh
    if (isRerun) {
      try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
      return initialStep;
    }
    return getPersistedStep(initialStep);
  });

  // One-shot gate: once the backend-derived min step has been applied, never
  // clobber the user's position again — they may have manually navigated
  // forward past what the backend yet knows about.
  const [hasAppliedBackendMin, setHasAppliedBackendMin] = useState(false);

  // Persist step changes to sessionStorage; clear on the final (complete) step
  useEffect(() => {
    try {
      if (currentStep === STEPS.length - 1) {
        sessionStorage.removeItem(STORAGE_KEY);
      } else {
        sessionStorage.setItem(STORAGE_KEY, String(currentStep));
      }
    } catch {
      // sessionStorage may be unavailable
    }
  }, [currentStep]);

  const goNext = useCallback(() => {
    setCurrentStep((prev) => {
      let next = prev + 1;
      // Skip admin step if admin already exists
      if (next === 1 && adminExists) next = 2;
      return Math.min(next, STEPS.length - 1);
    });
  }, [adminExists]);

  const goBack = useCallback(() => {
    setCurrentStep((prev) => {
      let back = prev - 1;
      // Skip admin step going back if admin already exists
      if (back === 1 && adminExists) back = 0;
      return Math.max(back, 0);
    });
  }, [adminExists]);

  // Resume support: once the setup-status query resolves, jump forward to the
  // earliest incomplete step so the user isn't forced back through Welcome +
  // sign-in after closing the tab mid-flow. `isRerun` short-circuits this —
  // admins explicitly re-opening the wizard want to start fresh at LLM.
  //
  // We use Math.max so a user whose sessionStorage puts them ahead of the
  // backend-known minimum keeps their position (e.g. they're mid-Confluence
  // but the backend doesn't yet know because they haven't clicked Save).
  useEffect(() => {
    if (hasAppliedBackendMin || isRerun || isSetupStatusLoading) return;
    const min = deriveMinStepFromBackend(steps);
    setCurrentStep((prev) => Math.max(prev, min));
    setHasAppliedBackendMin(true);
  }, [hasAppliedBackendMin, isRerun, isSetupStatusLoading, steps]);

  // The animated gradient mesh is retired (ADR-010 v0.6). v0.4 kept it here on
  // the grounds that it sat behind the neumorphic surfaces without conflict;
  // under a flat system there is nothing for it to sit behind, and three
  // separate rules were against it:
  //
  //  - it was the last gradient in the app, on the one screen a new operator
  //    sees first, so it set an expectation the rest of the product breaks;
  //  - `rgba(120, 80, 255, …)` is a hardcoded violet, and violet is reserved
  //    for AI in this system — it was signalling "AI" on a screen that has not
  //    asked about a model yet;
  //  - it animated `background`, a paint property rather than a compositable
  //    one, on `repeat: Infinity`, with no `prefers-reduced-motion` guard, for
  //    the entire time the wizard was open.
  //
  // The wizard now sits on the chassis like every other surface.
  return (
    <div className="bg-background flex min-h-screen items-center justify-center p-4">
      <div className="relative w-full max-w-lg">
        {/* Logo header for non-welcome steps */}
        {currentStep > 0 && currentStep < STEPS.length - 1 && (
          <m.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="mb-4 flex items-center justify-center gap-2"
          >
            <CompendiqLogo size={20} className="text-primary" />
            <span className="text-sm font-semibold text-muted-foreground">
              Compendiq Setup
            </span>
          </m.div>
        )}

        {/* Progress stepper */}
        {currentStep > 0 && currentStep < STEPS.length - 1 && (
          <m.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-6"
            data-testid="setup-stepper"
          >
            <div className="flex items-center justify-center gap-2">
              {STEPS.map((step, index) => (
                <div key={step.id} className="flex items-center">
                  <div
                    // Progress takes the accent, not `--color-action`. As
                    // near-black filled circles the completed steps were the
                    // heaviest thing on the screen — heavier than Continue, the
                    // only control that advances the flow — which is the same
                    // inversion the search-mode toggle had. The current step is
                    // an outlined accent ring so "where am I" and "what is done"
                    // stay distinguishable without a second hue.
                    className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium transition-colors ${
                      index < currentStep
                        ? 'bg-primary text-primary-foreground'
                        : index === currentStep
                          ? 'bg-card text-primary-ink ring-2 ring-primary'
                          : 'bg-muted text-muted-foreground'
                    }`}
                    data-testid={`step-indicator-${step.id}`}
                  >
                    {index < currentStep ? (
                      <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                    ) : (
                      index + 1
                    )}
                  </div>
                  {index < STEPS.length - 1 && (
                    <div
                      className={`mx-1 h-0.5 w-6 rounded transition-colors ${
                        index < currentStep ? 'bg-primary' : 'bg-border'
                      }`}
                    />
                  )}
                </div>
              ))}
            </div>
          </m.div>
        )}

        {/* Step content card */}
        <div className="nm-card p-8" data-testid="setup-wizard">
          <AnimatePresence mode="wait">
            {currentStep === 0 && (
              <WelcomeStep key="welcome" onNext={goNext} />
            )}
            {currentStep === 1 && (
              <AdminStep key="admin" onNext={goNext} onBack={goBack} />
            )}
            {currentStep === 2 && (
              <LlmStep key="llm" onNext={goNext} onBack={goBack} />
            )}
            {currentStep === 3 && (
              <ConfluenceStep key="confluence" onNext={goNext} onBack={goBack} />
            )}
            {currentStep === 4 && (
              <CompleteStep key="complete" />
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
