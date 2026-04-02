import { useState, useEffect } from 'react';
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

export function SetupWizard() {
  const [searchParams] = useSearchParams();
  const isRerun = searchParams.get('rerun') === 'true';
  const { steps } = useSetupStatus();
  const adminExists = steps.admin;

  // Skip admin step when admin already exists; on rerun always start at LLM
  const initialStep = isRerun ? 2 : 0;
  const [currentStep, setCurrentStep] = useState(initialStep);

  function goNext() {
    setCurrentStep((prev) => {
      let next = prev + 1;
      // Skip admin step if admin already exists
      if (next === 1 && adminExists) next = 2;
      return Math.min(next, STEPS.length - 1);
    });
  }

  function goBack() {
    setCurrentStep((prev) => {
      let back = prev - 1;
      // Skip admin step going back if admin already exists
      if (back === 1 && adminExists) back = 0;
      return Math.max(back, 0);
    });
  }

  // Auto-advance past admin step if setup-status query resolves while on it
  useEffect(() => {
    if (currentStep === 1 && adminExists) {
      setCurrentStep(2);
    }
  }, [currentStep, adminExists]);

  return (
    <div className="bg-background flex min-h-screen items-center justify-center p-4">
      {/* Animated gradient background */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <m.div
          animate={{
            background: [
              'radial-gradient(ellipse at 20% 50%, rgba(120, 80, 255, 0.08) 0%, transparent 50%)',
              'radial-gradient(ellipse at 80% 50%, rgba(120, 80, 255, 0.08) 0%, transparent 50%)',
              'radial-gradient(ellipse at 50% 20%, rgba(120, 80, 255, 0.08) 0%, transparent 50%)',
              'radial-gradient(ellipse at 20% 50%, rgba(120, 80, 255, 0.08) 0%, transparent 50%)',
            ],
          }}
          transition={{ duration: 20, repeat: Infinity, ease: 'linear' }}
          className="absolute inset-0"
        />
      </div>

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
                    className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium transition-colors ${
                      index < currentStep
                        ? 'bg-primary text-primary-foreground'
                        : index === currentStep
                          ? 'bg-primary/20 text-primary ring-2 ring-primary/40'
                          : 'bg-foreground/10 text-muted-foreground'
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
                        index < currentStep ? 'bg-primary' : 'bg-foreground/10'
                      }`}
                    />
                  )}
                </div>
              ))}
            </div>
          </m.div>
        )}

        {/* Step content card */}
        <div className="glass-card p-8" data-testid="setup-wizard">
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
