import type { ReactNode } from 'react';
import type { AppEdition } from '@compendiq/contracts';
import { Check, FileText, Link2, Sparkles } from 'lucide-react';
import { LoginBrandHeader } from './LoginBrandHeader';

interface ChangeDeskLoginProps {
  authPanel: ReactNode;
  controls?: ReactNode;
  edition?: AppEdition | null;
}

export function ChangeDeskLogin({ authPanel, controls, edition }: ChangeDeskLoginProps) {
  return (
    <div className="login-backdrop h-dvh overflow-y-auto text-foreground">
      <div className="relative isolate mx-auto flex min-h-full w-full max-w-[1440px] flex-col overflow-hidden px-5 py-5 sm:px-8 sm:py-7 lg:px-12 lg:py-9">
        <div
          aria-hidden="true"
          data-halo="ai"
          className="login-halo bottom-[4%] left-[18%] h-[28rem] w-[28rem]"
        />

        <LoginBrandHeader controls={controls} edition={edition} />

        <main className="grid flex-1 gap-10 py-12 lg:grid-cols-[minmax(0,1.12fr)_minmax(22rem,28rem)] lg:grid-rows-[auto_auto] lg:items-center lg:gap-x-16 lg:gap-y-9 lg:py-14">
          <section className="max-w-3xl lg:col-start-1 lg:row-start-1" aria-labelledby="change-desk-title">
            <p className="mb-5 inline-flex items-center gap-2 text-sm font-semibold text-status-ai">
              <Sparkles aria-hidden="true" className="h-4 w-4" />
              A clearer workspace for every page
            </p>
            <h1
              id="change-desk-title"
              className="max-w-[13ch] text-balance font-display text-5xl font-semibold leading-[0.98] tracking-[-0.035em] text-foreground sm:text-6xl xl:text-7xl"
            >
              Make the page worth finding.
            </h1>
            <p className="mt-6 max-w-[62ch] text-lg leading-8 text-muted-foreground">
              Review source knowledge, shape a clearer draft, and keep the context your team needs close at hand.
            </p>
          </section>

          <div className="lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-end">{authPanel}</div>

          <section
            className="nm-card overflow-hidden lg:col-start-1 lg:row-start-2"
            aria-labelledby="change-preview-title"
          >
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4 sm:px-6">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <FileText aria-hidden="true" className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <h2 id="change-preview-title" className="truncate text-sm font-semibold text-foreground">
                    Incident response notes
                  </h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">Illustrative workflow preview</p>
                </div>
              </div>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-status-ai/10 px-2.5 py-1 text-xs font-semibold text-status-ai">
                <Sparkles aria-hidden="true" className="h-3.5 w-3.5" />
                Suggested revision
              </span>
            </div>

            <div className="grid md:grid-cols-2">
              <article className="border-b border-border p-5 sm:p-6 md:border-b-0 md:border-r" aria-label="Source passage">
                <p className="mb-4 text-xs font-semibold text-muted-foreground">Source passage</p>
                <p className="text-sm leading-6 text-muted-foreground">
                  When an incident starts, check the dashboard and message the on-call person. Add notes to the page
                  so the next shift can see what happened.
                </p>
                <div className="mt-5 space-y-2" aria-hidden="true">
                  <span className="block h-2 w-full rounded-sm bg-muted" />
                  <span className="block h-2 w-4/5 rounded-sm bg-muted" />
                  <span className="block h-2 w-2/3 rounded-sm bg-muted" />
                </div>
              </article>

              <article className="p-5 sm:p-6" aria-label="Improved draft">
                <p className="mb-4 text-xs font-semibold text-status-ai">Improved draft</p>
                <h3 className="font-display text-base font-semibold text-foreground">First-response checklist</h3>
                <ul className="mt-4 space-y-3 text-sm text-muted-foreground">
                  <li className="flex gap-2.5">
                    <Check aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                    Confirm the incident in the service dashboard.
                  </li>
                  <li className="flex gap-2.5">
                    <Check aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                    Contact the current on-call owner.
                  </li>
                  <li className="flex gap-2.5">
                    <Link2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-primary-ink" />
                    Keep handover notes linked to the source page.
                  </li>
                </ul>
              </article>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
