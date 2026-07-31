import type { ReactNode } from 'react';
import { BookOpenText, Bot, Database, Server } from 'lucide-react';
import { LoginBrandHeader } from './LoginBrandHeader';

interface LocalLoopLoginProps {
  authPanel: ReactNode;
  controls?: ReactNode;
}

const steps = [
  {
    icon: Database,
    label: 'Confluence',
    detail: 'Connected pages',
  },
  {
    icon: Server,
    label: 'Compendiq',
    detail: 'Your workspace',
  },
  {
    icon: Bot,
    label: 'Selected model',
    detail: 'Local or API',
  },
  {
    icon: BookOpenText,
    label: 'Grounded answer',
    detail: 'With source links',
  },
];

export function LocalLoopLogin({ authPanel, controls }: LocalLoopLoginProps) {
  return (
    <div className="app-backdrop h-dvh overflow-y-auto text-foreground">
      <div className="relative isolate mx-auto flex min-h-full w-full max-w-[1440px] flex-col overflow-hidden px-5 py-5 sm:px-8 sm:py-7 lg:px-12 lg:py-9">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-[8%] top-[12%] -z-10 h-[32rem] w-[32rem] rounded-full bg-primary opacity-[0.08] blur-[120px]"
        />

        <LoginBrandHeader controls={controls} />

        <main className="grid flex-1 gap-10 py-12 lg:grid-cols-[minmax(0,1fr)_minmax(22rem,28rem)] lg:grid-rows-[auto_auto] lg:items-center lg:gap-x-16 lg:gap-y-10 lg:py-14">
          <section className="max-w-3xl lg:col-start-1 lg:row-start-1" aria-labelledby="local-loop-title">
            <p className="mb-5 inline-flex items-center gap-2 text-sm font-semibold text-primary-ink">
              <span className="size-2 rounded-full bg-success" aria-hidden="true" />
              Knowledge stays connected to its source
            </p>
            <h1
              id="local-loop-title"
              className="max-w-[12ch] text-balance font-display text-5xl font-semibold leading-[0.98] tracking-[-0.035em] text-foreground sm:text-6xl xl:text-7xl"
            >
              See the whole knowledge loop.
            </h1>
            <p className="mt-6 max-w-[62ch] text-lg leading-8 text-muted-foreground">
              Bring Confluence knowledge into one workspace, ask through the model you configure, and follow every
              answer back to the pages that shaped it.
            </p>
          </section>

          <div className="lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-center">{authPanel}</div>

          <section
            className="nm-card relative overflow-hidden p-5 sm:p-6 lg:col-start-1 lg:row-start-2"
            aria-labelledby="topology-title"
          >
            <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 id="topology-title" className="font-display text-lg font-semibold text-foreground">
                  One visible path
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">Static topology · your provider choice stays explicit</p>
              </div>
              <span className="text-xs font-medium text-primary-ink">Local and remote paths</span>
            </div>

            <ol className="grid gap-3 sm:grid-cols-4" aria-label="Compendiq knowledge flow">
              {steps.map((step, index) => {
                const Icon = step.icon;
                return (
                  <li key={step.label} className="relative flex min-w-0 items-center gap-3 sm:block">
                    <div className="relative z-10 flex size-10 shrink-0 items-center justify-center rounded-lg border border-border-interactive bg-card text-primary-ink">
                      <Icon aria-hidden="true" className="h-5 w-5" />
                    </div>
                    {index < steps.length - 1 && (
                      <span
                        aria-hidden="true"
                        className="absolute left-5 top-10 h-[calc(100%+0.75rem)] w-px bg-border sm:left-10 sm:top-5 sm:h-px sm:w-[calc(100%-1.5rem)]"
                      />
                    )}
                    <div className="min-w-0 sm:mt-3 sm:pr-3">
                      <p className="text-sm font-semibold text-foreground">{step.label}</p>
                      <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{step.detail}</p>
                    </div>
                  </li>
                );
              })}
            </ol>

            <div className="mt-6 grid gap-3 border-t border-border pt-5 text-sm sm:grid-cols-2">
              <p className="leading-6 text-muted-foreground">
                <strong className="font-semibold text-foreground">Local provider:</strong> requests can remain inside
                the network boundary you operate.
              </p>
              <p className="leading-6 text-muted-foreground">
                <strong className="font-semibold text-foreground">Remote provider:</strong> requests follow the API
                endpoint and policy you configure.
              </p>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
