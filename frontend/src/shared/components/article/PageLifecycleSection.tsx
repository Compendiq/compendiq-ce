import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/cn';
import * as Dialog from '@radix-ui/react-dialog';
import { Loader2, Lock, LockOpen } from 'lucide-react';
import type { PageLifecycleState } from '@compendiq/contracts';
import { useEnterprise } from '../../enterprise/use-enterprise';
import {
  denialExplanation,
  useFreezePage,
  useFreezePreview,
  useUnfreezePage,
  type PageBaselineError,
} from '../../hooks/use-page-lifecycle';

/**
 * Document lifecycle, in the Details tab below Document health (#277).
 *
 * Deliberately a compact SECTION, not a second banner above the article: a
 * frozen page already says so in its header badge and by having no Edit
 * control, and a dominant card would push the document down on every page
 * that is merely frozen.
 *
 * Four claims are kept apart, because collapsing them is how an interface
 * starts overstating its own evidence:
 *
 *   1. **Frozen** — the article cannot be changed. A fact about `pages`.
 *   2. **Frozen by** — the person who performed the freeze.
 *   3. **Reported signatories** — names the freezing person TYPED. Never
 *      independently verified, and labelled as reported on screen.
 *   4. **Approved by** — an authenticated Enterprise approval record. Only
 *      rendered for `provenance === 'authenticated_approval'`, never
 *      inferred from `isFrozen`.
 *
 * Capabilities come from the server (`canFreeze` / `canUnfreeze`). An absent
 * page, an in-flight read and a failed read are all UNKNOWN, and unknown
 * never enables a mutation.
 */
/**
 * The page read is `Partial<PageLifecycleState>`: a server that predates
 * these fields sends none, and a missing capability is UNKNOWN, never
 * permission. Every gate below therefore tests `=== true`.
 */
type LifecycleFields = Partial<PageLifecycleState>;

interface PageLifecycleSectionProps {
  pageId: string;
  /** `undefined` while the page read is in flight or failed: state unknown. */
  page: LifecycleFields | undefined;
}

function formatWhen(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

const GOVERNANCE_COPY: Record<string, string> = {
  none: 'No approval proposal is open.',
  draft: 'A proposal is open and has no current approvals.',
  in_review: 'A proposal is in review and is collecting approvals.',
  approved: 'Every required role has approved; the freeze has not completed yet.',
  rejected: 'The last proposal was rejected.',
  withdrawn: 'The last proposal was withdrawn.',
  unavailable: 'The approval workflow could not be reached, so its state is unknown.',
};

export function PageLifecycleSection({ pageId, page }: PageLifecycleSectionProps) {
  const { isEnterprise } = useEnterprise();
  const [freezeOpen, setFreezeOpen] = useState(false);
  const [unfreezeOpen, setUnfreezeOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);

  const frozen = page?.isFrozen === true;
  const frozenOn = formatWhen(page?.frozenAt);
  const governed = page?.governanceProposalStatus != null && page.governanceProposalStatus !== 'none';

  // Two different handoffs, and both are needed.
  //
  //  - DISMISSED: the control that opened the dialog is still on screen, so
  //    focus belongs on it. Radix restores focus to whatever was focused at
  //    open time, which a pointer press on some platforms never moved, so
  //    the opener is captured explicitly.
  //  - SUCCEEDED: freezing removes `Freeze article` and thawing removes
  //    `Thaw article`, so focus is handed to the section heading — and only
  //    if the pressed control still owns it (the RetrievalTab recipe).
  const openerRef = useRef<HTMLElement | null>(null);
  const captureOpener = useCallback((event: { currentTarget: HTMLElement }) => {
    openerRef.current = event.currentTarget;
  }, []);
  const restoreOpener = useCallback(() => {
    // After the portal unmounts, not before: Radix's own teardown blurs on
    // the way out, so focusing in the same tick lands on `body`.
    requestAnimationFrame(() => {
      const opener = openerRef.current;
      if (opener?.isConnected) opener.focus();
      else headingRef.current?.focus();
    });
  }, []);
  const handOffFocus = useCallback((pressed: Element | null) => {
    if (document.activeElement !== pressed) return;
    headingRef.current?.focus();
  }, []);

  if (!page) {
    return (
      <section className="mt-5" data-testid="document-lifecycle">
        <h3 className="text-xs font-semibold text-foreground">Document lifecycle</h3>
        <p className="mt-1.5 text-xs text-muted-foreground">
          The lifecycle state could not be read, so no action is offered here.
        </p>
      </section>
    );
  }

  return (
    <section className="mt-5" data-testid="document-lifecycle">
      <h3
        ref={headingRef}
        tabIndex={-1}
        className="nm-focus-ring text-xs font-semibold text-foreground"
      >
        Document lifecycle
      </h3>

      <div className="mt-1.5 flex items-start gap-2 text-xs font-medium text-foreground/85">
        {frozen ? (
          <Lock size={14} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        ) : (
          <LockOpen size={14} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
        <span data-testid="lifecycle-state">
          {frozen
            ? `Frozen${page.frozenVersion ? ` at v${page.frozenVersion}` : ''}${frozenOn ? ` on ${frozenOn}` : ''}`
            : 'Editable — no baseline is in force'}
        </span>
      </div>

      {frozen && (
        <dl className="mt-2 text-xs" data-testid="lifecycle-details">
          {page.frozenByName && (
            <div className="flex items-start justify-between gap-3 py-1">
              <dt className="text-muted-foreground">Frozen by</dt>
              <dd className="text-right font-medium text-foreground/85">{page.frozenByName}</dd>
            </div>
          )}
          {page.provenance === 'authenticated_approval' && (
            <div className="flex items-start justify-between gap-3 py-1">
              <dt className="text-muted-foreground">Approval</dt>
              <dd className="text-right font-medium text-foreground/85" data-testid="lifecycle-provenance">
                Authenticated approval
              </dd>
            </div>
          )}
          {page.freezeReason && (
            <div className="flex items-start justify-between gap-3 py-1">
              <dt className="text-muted-foreground">Reason</dt>
              <dd className="max-w-[60%] text-right text-foreground/85">{page.freezeReason}</dd>
            </div>
          )}
        </dl>
      )}

      {isEnterprise && governed && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="lifecycle-governance">
          {GOVERNANCE_COPY[page.governanceProposalStatus ?? 'none'] ?? 'Approval state is unknown.'}
        </p>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {!frozen && page.canFreeze && (
          <button
            type="button"
            className="nm-button-ghost inline-flex h-8 items-center gap-1.5 px-2 text-xs"
            data-testid="freeze-btn"
            onClick={(event) => { captureOpener(event); setFreezeOpen(true); }}
          >
            <Lock size={12} className="shrink-0 opacity-70" aria-hidden="true" />
            <span>Freeze article</span>
          </button>
        )}
        {frozen && page.canUnfreeze && (
          <button
            type="button"
            className="nm-button-ghost inline-flex h-8 items-center gap-1.5 px-2 text-xs"
            data-testid="unfreeze-btn"
            onClick={(event) => { captureOpener(event); setUnfreezeOpen(true); }}
          >
            <LockOpen size={12} className="shrink-0 opacity-70" aria-hidden="true" />
            <span>Thaw article</span>
          </button>
        )}
      </div>

      {/* A refusal is explained in prose, reachable by keyboard and touch —
          never only as the `title` of a disabled control. */}
      {!frozen && !page.canFreeze && denialExplanation(page.freezeDeniedReason) && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="freeze-denied">
          {denialExplanation(page.freezeDeniedReason)}
        </p>
      )}
      {frozen && !page.canUnfreeze && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="unfreeze-denied">
          {denialExplanation(page.unfreezeDeniedReason)
            ?? 'Thawing this article needs a different permission than yours.'}
        </p>
      )}

      {/* Mounted before any update: a region inserted together with its first
          sentence is the case assistive tech is least reliable about. */}
      <span className="sr-only" role="status" aria-live="polite" data-testid="lifecycle-announcer">
        {announcement}
      </span>

      <FreezeDialog
        open={freezeOpen}
        pageId={pageId}
        onClose={(pressed) => {
          setFreezeOpen(false);
          if (pressed) handOffFocus(pressed); else restoreOpener();
        }}
        onFrozen={() => setAnnouncement('This article is now frozen.')}
      />
      <UnfreezeDialog
        open={unfreezeOpen}
        pageId={pageId}
        baselineId={page.baselineId ?? null}
        lifecycleRevision={page.lifecycleRevision ?? ''}
        onClose={(pressed) => {
          setUnfreezeOpen(false);
          if (pressed) handOffFocus(pressed); else restoreOpener();
        }}
        onThawed={() => setAnnouncement('This article is editable again. Its baseline is retained.')}
      />
    </section>
  );
}

const overlayClass = 'fixed inset-0 z-50 bg-black/50 backdrop-blur-sm';
const contentClass =
  'nm-card fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 p-6 outline-none';

function errorLine(error: PageBaselineError | null): string | null {
  if (!error) return null;
  return denialExplanation(error.reason) ?? error.message;
}

function FreezeDialog({
  open,
  pageId,
  onClose,
  onFrozen,
}: {
  open: boolean;
  pageId: string;
  onClose: (pressed: Element | null) => void;
  onFrozen: () => void;
}) {
  const preview = useFreezePreview(pageId, open);
  const freeze = useFreezePage(pageId);
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const [signatories, setSignatories] = useState('');
  const [error, setError] = useState<PageBaselineError | null>(null);

  useEffect(() => {
    if (!open) {
      // Entered text survives a failure, but a fresh open starts clean.
      setError(null);
      setReason('');
      setReference('');
      setSignatories('');
    }
  }, [open]);

  const submit = useCallback(async (pressed: Element | null) => {
    if (freeze.isPending || !preview.data) return;
    setError(null);
    try {
      await freeze.mutateAsync({
        reason: reason.trim(),
        expectedContentRevision: preview.data.contentRevision,
        expectedManifestDigest: preview.data.manifestDigest,
        ...(reference.trim() ? { reportedReference: reference.trim() } : {}),
        ...(signatories.trim()
          ? {
            reportedSignatories: signatories
              .split(',')
              .map((name) => name.trim())
              .filter(Boolean)
              .map((displayName) => ({ displayName })),
          }
          : {}),
      });
      onFrozen();
      onClose(pressed);
    } catch (err) {
      // Fields are preserved deliberately: a stale preview or a busy room is
      // retried with the same text, not retyped.
      setError(err as PageBaselineError);
    }
  }, [freeze, onClose, onFrozen, preview.data, reason, reference, signatories]);

  const reasonValid = reason.trim().length >= 5;

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next && !freeze.isPending) onClose(null); }}>
      <Dialog.Portal>
        <Dialog.Overlay className={overlayClass} />
        <Dialog.Content className={contentClass} data-testid="freeze-dialog">
          <Dialog.Title className="text-base font-semibold text-foreground">Freeze this article</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-muted-foreground">
            Freezing records an immutable copy of the current article and its media, and stops
            further edits until it is thawed.
          </Dialog.Description>

          {preview.isPending && (
            <p className="mt-3 text-xs text-muted-foreground" data-testid="freeze-preview-loading">
              Reading what this freeze would cover…
            </p>
          )}
          {preview.isError && (
            <p className="mt-3 text-xs text-destructive" data-testid="freeze-preview-error">
              {errorLine(preview.error)} Nothing has been frozen.
            </p>
          )}
          {preview.data && (
            <dl className="mt-3 rounded-md border border-border p-3 text-xs" data-testid="freeze-preview">
              <div className="flex items-center justify-between gap-3 py-0.5">
                <dt className="text-muted-foreground">Version</dt>
                <dd className="font-medium tabular-nums text-foreground/85">v{preview.data.version}</dd>
              </div>
              <div className="flex items-center justify-between gap-3 py-0.5">
                <dt className="text-muted-foreground">Media covered</dt>
                <dd className="font-medium tabular-nums text-foreground/85">
                  {preview.data.attachments.length}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3 py-0.5">
                <dt className="text-muted-foreground">Manifest</dt>
                <dd className="font-mono text-[11px] text-muted-foreground">
                  {preview.data.manifestDigest.slice(0, 12)}…
                </dd>
              </div>
            </dl>
          )}

          <label className="mt-3 block text-xs font-medium text-foreground" htmlFor="freeze-reason">
            Reason
          </label>
          <textarea
            id="freeze-reason"
            className="nm-input mt-1 w-full text-xs"
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            data-testid="freeze-reason"
          />

          <label className="mt-3 block text-xs font-medium text-foreground" htmlFor="freeze-reference">
            Reference (optional)
          </label>
          <input
            id="freeze-reference"
            className="nm-input mt-1 w-full text-xs"
            value={reference}
            onChange={(event) => setReference(event.target.value)}
            data-testid="freeze-reference"
          />

          <label className="mt-3 block text-xs font-medium text-foreground" htmlFor="freeze-signatories">
            Reported signatories (optional, comma separated)
          </label>
          <input
            id="freeze-signatories"
            className="nm-input mt-1 w-full text-xs"
            value={signatories}
            onChange={(event) => setSignatories(event.target.value)}
            aria-describedby="freeze-signatories-help"
            data-testid="freeze-signatories"
          />
          <p id="freeze-signatories-help" className="mt-1 text-[11px] text-muted-foreground">
            Recorded as reported by you. This is not verified agreement from those people.
          </p>

          {error && (
            <p className="mt-3 text-xs text-destructive" data-testid="freeze-error">
              {errorLine(error)} Your text is kept; nothing was frozen.
            </p>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              className="nm-button-ghost h-8 px-3 text-xs"
              onClick={() => { if (!freeze.isPending) onClose(null); }}
              data-testid="freeze-cancel"
            >
              Cancel
            </button>
            <button
              type="button"
              className="nm-button-primary inline-flex h-8 items-center gap-1.5 px-3 text-xs"
              aria-disabled={freeze.isPending || !preview.data || !reasonValid}
              data-testid="freeze-confirm"
              onClick={(event) => {
                if (freeze.isPending || !preview.data || !reasonValid) return;
                void submit(event.currentTarget);
              }}
            >
              {freeze.isPending && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
              <span>{freeze.isPending ? 'Freezing…' : 'Freeze article'}</span>
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function UnfreezeDialog({
  open,
  pageId,
  baselineId,
  lifecycleRevision,
  onClose,
  onThawed,
}: {
  open: boolean;
  pageId: string;
  baselineId: string | null;
  lifecycleRevision: string;
  onClose: (pressed: Element | null) => void;
  onThawed: () => void;
}) {
  const unfreeze = useUnfreezePage(pageId);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<PageBaselineError | null>(null);

  useEffect(() => {
    if (!open) {
      setError(null);
      setReason('');
    }
  }, [open]);

  const submit = useCallback(async (pressed: Element | null) => {
    if (unfreeze.isPending || !baselineId) return;
    setError(null);
    try {
      await unfreeze.mutateAsync({
        reason: reason.trim(),
        expectedBaselineId: baselineId,
        expectedLifecycleRevision: lifecycleRevision,
      });
      onThawed();
      onClose(pressed);
    } catch (err) {
      setError(err as PageBaselineError);
    }
  }, [baselineId, lifecycleRevision, onClose, onThawed, reason, unfreeze]);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next && !unfreeze.isPending) onClose(null); }}>
      <Dialog.Portal>
        <Dialog.Overlay className={overlayClass} />
        <Dialog.Content className={cn(contentClass, 'max-w-md')} data-testid="unfreeze-dialog">
          <Dialog.Title className="text-base font-semibold text-foreground">Thaw this article</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-muted-foreground">
            The article becomes editable again. The frozen baseline is kept exactly as it was and
            stays readable — thawing does not delete or change it.
          </Dialog.Description>

          <label className="mt-3 block text-xs font-medium text-foreground" htmlFor="unfreeze-reason">
            Reason
          </label>
          <textarea
            id="unfreeze-reason"
            className="nm-input mt-1 w-full text-xs"
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            data-testid="unfreeze-reason"
          />

          {error && (
            <p className="mt-3 text-xs text-destructive" data-testid="unfreeze-error">
              {errorLine(error)} The article is still frozen.
            </p>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              className="nm-button-ghost h-8 px-3 text-xs"
              onClick={() => { if (!unfreeze.isPending) onClose(null); }}
              data-testid="unfreeze-cancel"
            >
              Cancel
            </button>
            <button
              type="button"
              className="nm-button-primary inline-flex h-8 items-center gap-1.5 px-3 text-xs"
              aria-disabled={unfreeze.isPending || !baselineId || reason.trim().length < 10}
              data-testid="unfreeze-confirm"
              onClick={(event) => {
                if (unfreeze.isPending || !baselineId || reason.trim().length < 10) return;
                void submit(event.currentTarget);
              }}
            >
              {unfreeze.isPending && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
              <span>{unfreeze.isPending ? 'Thawing…' : 'Thaw article'}</span>
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
