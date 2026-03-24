import { m } from 'framer-motion';
import { AtlasMindLogo } from '../../../shared/components/AtlasMindLogo';

interface WelcomeStepProps {
  onNext: () => void;
}

export function WelcomeStep({ onNext }: WelcomeStepProps) {
  return (
    <m.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      transition={{ duration: 0.25 }}
      className="flex flex-col items-center text-center"
    >
      <m.div
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ delay: 0.1, duration: 0.3 }}
      >
        <AtlasMindLogo size={80} className="text-primary" animated />
      </m.div>

      <m.h1
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2, duration: 0.25 }}
        className="mt-6 text-3xl font-bold tracking-tight"
      >
        Welcome to Atlas<span className="font-extrabold">Mind</span>
      </m.h1>

      <m.p
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3, duration: 0.25 }}
        className="mt-3 max-w-md text-muted-foreground"
      >
        Your AI-powered knowledge base. Let&apos;s get everything set up in just a few steps.
      </m.p>

      <m.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.35, duration: 0.25 }}
        className="mt-3 text-xs text-muted-foreground/60"
      >
        v{__APP_VERSION__}
      </m.div>

      <m.button
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.4, duration: 0.25 }}
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.98 }}
        onClick={onNext}
        className="glass-button-primary mt-8 px-8 py-3 text-base"
        data-testid="start-setup-btn"
      >
        Start Setup
      </m.button>
    </m.div>
  );
}
