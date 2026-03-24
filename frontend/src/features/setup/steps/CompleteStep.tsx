import { m } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { AtlasMindLogo } from '../../../shared/components/AtlasMindLogo';

export function CompleteStep() {
  const navigate = useNavigate();

  const links = [
    { label: 'Go to Pages', description: 'Start creating and managing articles', path: '/', testId: 'goto-pages' },
    { label: 'Admin Settings', description: 'Configure advanced options', path: '/settings', testId: 'goto-settings' },
  ];

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
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/20">
          <svg className="h-8 w-8 text-emerald-400" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
          </svg>
        </div>
      </m.div>

      <m.h2
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2, duration: 0.25 }}
        className="mt-6 text-2xl font-bold"
      >
        You&apos;re All Set!
      </m.h2>

      <m.p
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3, duration: 0.25 }}
        className="mt-2 max-w-md text-muted-foreground"
      >
        AtlasMind is ready to use. Start building your knowledge base with AI-powered tools.
      </m.p>

      <m.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.35, duration: 0.25 }}
        className="mt-4 flex items-center gap-2 text-xs text-muted-foreground/60"
      >
        <AtlasMindLogo size={14} className="text-primary" />
        <span>Powered by AtlasMind v1.0.0</span>
      </m.div>

      <m.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.4, duration: 0.25 }}
        className="mt-8 w-full max-w-sm space-y-3"
      >
        {links.map((link) => (
          <button
            key={link.path}
            onClick={() => navigate(link.path)}
            className="group flex w-full items-center gap-3 rounded-lg border border-border/40 bg-foreground/5 px-4 py-3 text-left transition-colors hover:bg-foreground/10"
            data-testid={link.testId}
          >
            <div className="flex-1">
              <div className="text-sm font-medium">{link.label}</div>
              <div className="text-xs text-muted-foreground">{link.description}</div>
            </div>
            <svg
              className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
            </svg>
          </button>
        ))}
      </m.div>
    </m.div>
  );
}
