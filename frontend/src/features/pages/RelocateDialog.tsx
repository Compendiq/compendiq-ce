/**
 * Move an article between a local space and Confluence (#1123).
 *
 * A relocate is not an edit — it changes which system owns the article, and
 * each direction destroys something on the way:
 *
 *   standalone → Confluence  deletes every local `page_versions` row
 *   Confluence → local       deletes the Confluence page, for everyone
 *
 * Both directions also swap the access model wholesale. This dialog's entire
 * job is to state those three facts with the server's own numbers and names
 * before the click, which is why the confirmation echoes them back: the route
 * re-verifies `acknowledgeDiscardedVersions` and `confirmDeleteConfluencePage`
 * against live state and 409s on a mismatch, so a blind confirm is impossible.
 *
 * The preview is deliberately a **dependent** query. Fetched without a
 * destination it can only describe the target access model in the abstract;
 * re-fetched with the chosen space (or visibility) it names the principals who
 * actually gain and lose access. Keeping the access panel on screen the whole
 * time — visibly generic, then visibly resolved — is what makes the causal
 * link legible. A wizard would hide it behind a Next.
 *
 * Design of record: docs/superpowers/specs/2026-07-29-relocate-dialog-design.md
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  AlertTriangle,
  ArrowDown,
  Download,
  Globe,
  KeyRound,
  Loader2,
  RotateCcw,
  Upload,
  User,
  UserMinus,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import type { RelocatePageInput, RelocatePreview, RelocatePrincipal } from '@compendiq/contracts';
import { ApiError } from '../../shared/lib/api';
import { cn } from '../../shared/lib/cn';
import { useSpaces } from '../../shared/hooks/use-spaces';
import { useLocalSpaces } from '../../shared/hooks/use-standalone';
import { useRelocatePage, useRelocatePreview } from '../../shared/hooks/use-relocate';

export interface RelocateDialogProps {
  open: boolean;
  pageId: string;
  /** Shown in the header until the preview arrives with the canonical title. */
  pageTitle: string;
  source: 'confluence' | 'standalone';
  onClose: () => void;
}

/** The one direction this article can move in, derived from where it lives. */
type Target = 'confluence' | 'local';

// ── Principals ──────────────────────────────────────────────────────

const PRINCIPAL_ICON = {
  user: User,
  group: Users,
  everyone: Globe,
  owner: KeyRound,
} as const;

function principalTestId(principal: RelocatePrincipal): string {
  return `relocate-principal-${principal.kind}-${principal.label.toLowerCase().replace(/\s+/g, '-')}`;
}

function PrincipalList({
  label,
  principals,
  testId,
  tone,
}: {
  label: string;
  principals: RelocatePrincipal[];
  testId: string;
  tone: 'gain' | 'lose';
}) {
  const ToneIcon = tone === 'gain' ? UserPlus : UserMinus;

  return (
    <div className="min-w-0" data-testid={testId}>
      <p
        className={cn(
          'flex items-center gap-1.5 text-xs font-semibold',
          tone === 'gain' ? 'text-success' : 'text-destructive',
        )}
      >
        <ToneIcon size={13} className="shrink-0" aria-hidden />
        {label}
        <span className="font-mono tabular-nums text-muted-foreground">({principals.length})</span>
      </p>
      {principals.length === 0 ? (
        // An empty roster is an answer, not an absence of one.
        <p className="mt-1.5 text-sm italic text-muted-foreground">Nobody</p>
      ) : (
        // A space can hold 50 listed assignments; the list scrolls inside
        // itself rather than growing the dialog past the viewport.
        <ul className="mt-1.5 max-h-40 space-y-1 overflow-y-auto pr-1">
          {principals.map((principal) => {
            const KindIcon = PRINCIPAL_ICON[principal.kind];
            return (
              <li
                key={`${principal.kind}:${principal.label}`}
                data-testid={principalTestId(principal)}
                className="flex items-start gap-1.5 text-sm text-foreground"
              >
                <KindIcon size={13} className="mt-1 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 break-words">{principal.label}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ── Consequence ledger ──────────────────────────────────────────────

function EffectRow({
  detail,
  label,
  testId,
  value,
}: {
  detail?: string;
  label: string;
  testId: string;
  value: React.ReactNode;
}) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[10rem_1fr] sm:gap-4" data-testid={testId}>
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm text-foreground">
        {value}
        {detail && <span className="mt-0.5 block text-xs text-muted-foreground">{detail}</span>}
      </dd>
    </div>
  );
}

/** Counts are data figures — JetBrains Mono, per the type system. */
function Count({ children }: { children: React.ReactNode }) {
  return <span className="font-mono tabular-nums font-medium">{children}</span>;
}

/**
 * A Confluence space key in the upstream-deletion sentences.
 *
 * `pages.space_key` is nullable, and the route encodes that NULL as `''` all
 * the way through the preview and the confirmation body. Rendered raw it
 * leaves a blank where the space name belongs — "in space  is deleted" — so
 * name the absence instead (#1169).
 */
function SpaceKeyName({ spaceKey }: { spaceKey: string }) {
  return spaceKey ? (
    <span className="font-mono">{spaceKey}</span>
  ) : (
    <span className="italic text-muted-foreground">(no space)</span>
  );
}

/**
 * The one row that has to explain something a count cannot: children keep
 * their own space and path while their `parent_id` now points across the
 * boundary, so they stay in the origin tree with their parent no longer in it.
 * Singular and plural are written out rather than assembled from fragments —
 * "1 child page stay in DEV" is the kind of thing a reader stops on.
 */
function ChildPagesRow({
  childCount,
  subtreeEffect,
}: {
  childCount: number;
  subtreeEffect: RelocatePreview['subtreeEffect'];
}) {
  const one = childCount === 1;
  const where = subtreeEffect?.childrenRemainInSpaceKey
    ? ` in ${subtreeEffect.childrenRemainInSpaceKey}`
    : one
      ? ' where it is'
      : ' where they are';

  return (
    <EffectRow
      testId="relocate-effect-children"
      label={one ? 'Child page' : 'Child pages'}
      value={
        <>
          <Count>{childCount}</Count> child page{one ? ' stays' : 's stay'}
          {where}
        </>
      }
      detail={
        subtreeEffect?.childrenDetachFromOriginTree
          ? one
            ? 'It keeps its own location, but its parent leaves it — so it will sit at the top level there, with this article no longer above it.'
            : 'They keep their own location, but their parent leaves it — so they will sit at the top level there, with this article no longer above them.'
          : one
            ? 'Its link to this article follows the move.'
            : 'Their link to this article follows the move.'
      }
    />
  );
}

function ConsequenceLedger({ preview, target }: { preview: RelocatePreview; target: Target }) {
  const { attachmentCount, childCount, localVersionCount, subtreeEffect, upstreamDeletion } = preview;

  return (
    <dl className="space-y-3">
      {target === 'confluence' && (
        <EffectRow
          testId="relocate-effect-versions"
          label="Version history"
          value={
            localVersionCount > 0 ? (
              <>
                <Count>{localVersionCount}</Count> local version
                {localVersionCount === 1 ? '' : 's'} deleted permanently
              </>
            ) : (
              'No local version history to discard'
            )
          }
          detail={
            localVersionCount > 0 ? 'Confluence keeps this article’s history from here on.' : undefined
          }
        />
      )}

      <EffectRow
        testId="relocate-effect-attachments"
        label="Attachments"
        value={
          attachmentCount > 0 ? (
            <>
              <Count>{attachmentCount}</Count> file{attachmentCount === 1 ? '' : 's'} moved to the{' '}
              {target === 'confluence' ? 'Confluence' : 'local'} attachment store
            </>
          ) : (
            'No attachments to move'
          )
        }
      />

      {childCount > 0 && <ChildPagesRow childCount={childCount} subtreeEffect={subtreeEffect} />}

      {upstreamDeletion && (
        <EffectRow
          testId="relocate-effect-upstream"
          label="Confluence page"
          value={
            <>
              “{upstreamDeletion.title}” in space{' '}
              <SpaceKeyName spaceKey={upstreamDeletion.spaceKey} /> is deleted in Confluence
            </>
          }
          detail="Everyone in Confluence loses the page. This cannot be undone from Compendiq."
        />
      )}
    </dl>
  );
}

// ── Access change ───────────────────────────────────────────────────

/**
 * The heart of the dialog: the read-access model before and after, then the
 * resolved difference.
 *
 * It stays mounted from the moment the dialog opens — generic prose and two
 * "Nobody" lists until a destination is chosen, real principals afterwards.
 * That is deliberate: watching this panel rewrite itself is what connects the
 * destination to its consequence. Hiding it behind a wizard step would let the
 * user click past the one thing they are being asked to read.
 */
function AccessChangeSection({
  accessChange,
  destinationChosen,
  updating,
}: {
  accessChange: RelocatePreview['accessChange'];
  destinationChosen: boolean;
  updating: boolean;
}) {
  return (
    <section className="space-y-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        Who can read it
        {updating && (
          <Loader2 size={13} className="animate-spin text-muted-foreground" aria-label="Updating" />
        )}
      </h3>

      <div className="space-y-1.5 text-sm">
        <p className="text-muted-foreground" data-testid="relocate-access-from">
          <span className="text-xs uppercase tracking-wide">Now</span>
          <span className="mt-0.5 block text-foreground">{accessChange.from}</span>
        </p>
        <ArrowDown size={14} className="text-muted-foreground" aria-hidden />
        <p className="text-muted-foreground" data-testid="relocate-access-to">
          <span className="text-xs uppercase tracking-wide">After the move</span>
          <span className="mt-0.5 block text-foreground">{accessChange.to}</span>
        </p>
      </div>

      {!destinationChosen && (
        <p className="text-xs text-muted-foreground" data-testid="relocate-access-hint">
          Choose a destination to see exactly who gains and loses access.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <PrincipalList
          label="Gains access"
          principals={accessChange.gains}
          testId="relocate-gains"
          tone="gain"
        />
        <PrincipalList
          label="Loses access"
          principals={accessChange.loses}
          testId="relocate-loses"
          tone="lose"
        />
      </div>

      {/* A capped roster that says nothing about the cap is a roster that
          under-reports the blast radius. Amber is the palette's reserved
          warning role, which this is. */}
      {accessChange.truncated && (
        <p className="flex items-start gap-2 text-xs text-warning" data-testid="relocate-truncated">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden />
          Only the first 50 role assignments in this space are listed — more people may be affected
          than shown.
        </p>
      )}
    </section>
  );
}

// ── Dialog ──────────────────────────────────────────────────────────

export function RelocateDialog({ open, pageId, pageTitle, source, onClose }: RelocateDialogProps) {
  // `source` comes from a cached `usePage`, so it can be stale — a page synced
  // to Confluence since the cache was filled would otherwise render the
  // move-to-Confluence dialog, which offers no upstream-deletion confirmation.
  // The preview is the server's own answer, so it wins as soon as it lands; the
  // prop only decides what to show while the first fetch is in flight.
  const fallbackTarget: Target = source === 'standalone' ? 'confluence' : 'local';

  const [spaceKey, setSpaceKey] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'shared' | undefined>(undefined);
  const [ackAccess, setAckAccess] = useState(false);
  const [ackDestructive, setAckDestructive] = useState(false);
  const [failure, setFailure] = useState<{ message: string; conflict: boolean } | null>(null);

  // Re-opening the dialog must not inherit the previous run's choices — least
  // of all its ticked acknowledgements.
  useEffect(() => {
    if (!open) return;
    setSpaceKey('');
    setVisibility(undefined);
    setAckAccess(false);
    setAckDestructive(false);
    setFailure(null);
    setServerTarget(null);
    setLastGoodPreview(null);
  }, [open, pageId]);

  const { data: spaces } = useSpaces();
  const { data: localSpaces } = useLocalSpaces();
  // `Array.isArray` rather than `?? []`: a failed or malformed `/spaces`
  // response resolves to a non-array, and `.filter` on it takes the whole
  // dialog down. Matches how NewPagePage guards the same data.
  const confluenceSpaces = useMemo(
    () => (Array.isArray(spaces) ? spaces : []).filter((space) => space.source === 'confluence'),
    [spaces],
  );

  // Adopted from the preview once it lands. Held as state rather than read
  // inline so the query arguments below — which decide whether a `spaceKey` or
  // a `visibility` is sent — are keyed on the same value the UI renders. Sending
  // a local space key to the preview route's Confluence-space check would 403.
  const [serverTarget, setServerTarget] = useState<Target | null>(null);
  const target: Target = serverTarget ?? fallbackTarget;

  const {
    data: preview,
    error: previewError,
    isFetching: previewFetching,
    isPending: previewPending,
    refetch: refetchPreview,
  } = useRelocatePreview(
    pageId,
    // See RelocateDestination: a local space key must never reach the preview
    // route's Confluence-space authorisation check.
    target === 'confluence' ? { spaceKey: spaceKey || undefined } : { visibility },
    open,
  );

  useEffect(() => {
    if (preview && preview.target !== serverTarget) setServerTarget(preview.target);
  }, [preview, serverTarget]);

  // `placeholderData` only covers the *pending* state — once a destination-keyed
  // fetch errors, TanStack drops `data` for that key entirely. Without holding
  // the last good preview the whole body unmounts, taking the destination
  // picker with it, and the only recovery on offer is re-requesting the same
  // failing key. Never used to submit: `canSubmit` refuses while `previewError`.
  const [lastGoodPreview, setLastGoodPreview] = useState<RelocatePreview | null>(null);
  useEffect(() => {
    if (preview) setLastGoodPreview(preview);
  }, [preview]);
  const shownPreview = preview ?? lastGoodPreview;

  const relocate = useRelocatePage();

  const destinationChosen = target === 'confluence' ? spaceKey !== '' : visibility !== undefined;
  const upstream = shownPreview?.upstreamDeletion ?? null;
  const discardsVersions = target === 'confluence' && (shownPreview?.localVersionCount ?? 0) > 0;
  const needsDestructiveAck = target === 'local' || discardsVersions;

  // Red is spent where something is destroyed. A move to a local space always
  // deletes an upstream Confluence page; a move to Confluence only destroys
  // anything when there is local history to discard.
  const isDestructive = target === 'local' || discardsVersions;

  const acknowledged = ackAccess && (!needsDestructiveAck || ackDestructive);

  const canSubmit =
    !!preview &&
    // A stale body is on screen while the chosen destination is unresolved.
    !previewError &&
    // `placeholderData` deliberately keeps the previous preview on screen while
    // the destination-keyed one loads, so `preview` is truthy throughout.
    // Without this the acknowledgements could be ticked and the move confirmed
    // against the roster and version count of the *previous* destination.
    !previewFetching &&
    !relocate.isPending &&
    destinationChosen &&
    acknowledged &&
    (target === 'confluence' || upstream !== null);

  /**
   * Why the confirm is refused, in the order the user should act on it. A
   * disabled button with no stated reason reads as broken — and on a short
   * viewport the acknowledgements it is waiting for are below the fold.
   */
  const blockedBecause = ((): string | null => {
    if (!shownPreview || canSubmit) return null;
    // Telling someone to choose from an empty list is worse than saying why
    // there is nothing to choose from.
    if (target === 'confluence' && confluenceSpaces.length === 0) {
      return 'No Confluence space is available to you. Ask an administrator for access, or sync a space first.';
    }
    if (previewFetching) return 'Working out what this destination changes…';
    if (!destinationChosen) {
      return target === 'confluence'
        ? 'Choose a Confluence space to continue.'
        : 'Choose whether the article becomes private or shared to continue.';
    }
    if (target === 'local' && !upstream) return 'This article has no Confluence page on record.';
    if (!acknowledged) return 'Confirm what this move changes and destroys, above.';
    return null;
  })();

  const resetAcknowledgements = useCallback(() => {
    setAckAccess(false);
    setAckDestructive(false);
  }, []);

  /**
   * Changing the destination invalidates what was acknowledged: the roster the
   * user read belonged to the *previous* space, and the new one is still in
   * flight. Re-ticking is cheap; confirming a roster you never saw is not.
   */
  const changeDestination = useCallback(
    (apply: () => void) => {
      apply();
      resetAcknowledgements();
      setFailure(null);
    },
    [resetAcknowledgements],
  );

  const handleReloadPreview = useCallback(() => {
    // The numbers a stale 409 rejected may have changed, so the ticked boxes no
    // longer say what the user read. Clearing them is the whole recovery — a
    // bare refetch would let the same stale echo be re-submitted.
    setFailure(null);
    resetAcknowledgements();
    void refetchPreview();
  }, [refetchPreview, resetAcknowledgements]);

  const handleSubmit = useCallback(async () => {
    if (!preview) return;

    const input: RelocatePageInput =
      target === 'confluence'
        ? {
            target: 'confluence',
            spaceKey,
            acknowledgeAccessChange: true,
            // Echoed exactly, including 0: the route verifies it against the
            // live count, so a version created since the preview still 409s.
            acknowledgeDiscardedVersions: preview.localVersionCount,
          }
        : {
            target: 'local',
            spaceKey: spaceKey || null,
            visibility: visibility!,
            acknowledgeAccessChange: true,
            confirmDeleteConfluencePage: {
              confluenceId: upstream!.confluenceId,
              spaceKey: upstream!.spaceKey,
            },
          };

    setFailure(null);
    try {
      const result = await relocate.mutateAsync({ pageId, input });

      for (const warning of result.warnings) toast.warning(warning);
      if (target === 'local' && !result.upstreamDeleted) {
        toast.warning(
          'The article is now local, but the Confluence page could not be confirmed deleted — it may still exist and be re-imported by the next sync.',
          { duration: 12_000 },
        );
      }
      toast.success(
        target === 'confluence'
          ? `“${preview.title}” now lives in Confluence space ${spaceKey}.`
          : `“${preview.title}” is now a local article${spaceKey ? ` in ${spaceKey}` : ''}.`,
      );
      onClose();
    } catch (err) {
      const status = err instanceof ApiError ? err.statusCode : 0;
      setFailure({
        message: err instanceof Error ? err.message : 'The move failed.',
        // 409 is the whole family of "what you confirmed no longer matches":
        // a running sync, a changed version count, a mismatched confirmation,
        // an identifier that became ambiguous. All are recoverable by reading
        // a fresh preview.
        conflict: status === 409,
      });
    }
  }, [onClose, pageId, preview, relocate, spaceKey, target, upstream, visibility]);

  const Icon = target === 'confluence' ? Upload : Download;
  const title = target === 'confluence' ? 'Move to Confluence' : 'Move to a local space';
  const displayTitle = preview?.title ?? pageTitle;

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <Dialog.Content
          className="nm-card-elevated fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[min(46rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden outline-none"
          data-testid="relocate-dialog"
        >
          {/* Header */}
          <div className="flex items-start gap-3 border-b border-border px-6 py-5">
            <span
              className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border-interactive text-primary"
              aria-hidden
            >
              <Icon size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-base font-semibold text-foreground">{title}</Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-muted-foreground">
                {target === 'confluence'
                  ? `“${displayTitle}” leaves Compendiq’s local storage and becomes a Confluence page. Confluence takes over its history and decides who can read it.`
                  : `“${displayTitle}” becomes a local article in Compendiq. Its Confluence page is deleted, so it disappears for everyone in Confluence.`}
              </Dialog.Description>
            </div>
            <Dialog.Close
              className="nm-icon-button h-8 w-8 shrink-0"
              aria-label="Close"
              data-testid="relocate-close"
            >
              <X size={15} />
            </Dialog.Close>
          </div>

          {/* Body. `scroll-mask` fades the edges so the acknowledgements below
              the fold announce themselves on a short viewport — without it the
              content simply ends at the footer rule and reads as complete. */}
          <div className="scroll-mask min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {previewPending ? (
              <div
                className="flex items-center gap-2 py-8 text-sm text-muted-foreground"
                data-testid="relocate-loading"
              >
                <Loader2 size={15} className="animate-spin" aria-hidden />
                Working out what this move would do…
              </div>
            ) : previewError && !shownPreview ? (
              <div className="py-8 text-sm" role="alert" data-testid="relocate-preview-error">
                <p className="text-destructive">
                  {previewError instanceof Error ? previewError.message : 'Could not load the preview.'}
                </p>
                <button
                  type="button"
                  onClick={handleReloadPreview}
                  className="nm-button-ghost mt-4"
                  data-testid="relocate-preview-retry"
                >
                  <RotateCcw size={14} aria-hidden />
                  Try again
                </button>
              </div>
            ) : shownPreview ? (
              <div className="space-y-6" data-testid="relocate-preview">
                {/* A *dependent* fetch failed while an earlier preview is still
                    on screen. Replacing the body would take the destination
                    picker with it, leaving the user able to do nothing but
                    re-request the same failing key. */}
                {previewError && (
                  <p
                    className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
                    role="alert"
                    data-testid="relocate-destination-error"
                  >
                    {previewError instanceof Error
                      ? previewError.message
                      : 'Could not check that destination.'}{' '}
                    The details below are for the previous one — pick another destination, or try again.
                  </p>
                )}

                {/* 1 — destination */}
                <section className="space-y-3">
                  <h3 className="text-sm font-semibold text-foreground">Where it goes</h3>

                  <label className="block">
                    <span className="mb-1.5 block text-xs text-muted-foreground">
                      {target === 'confluence' ? 'Confluence space' : 'Local space'}
                    </span>
                    <select
                      className="nm-select-md w-full"
                      value={spaceKey}
                      onChange={(event) => changeDestination(() => setSpaceKey(event.target.value))}
                      data-testid="relocate-space-select"
                    >
                      <option value="">
                        {target === 'confluence'
                          ? 'Choose a Confluence space…'
                          : 'No space — a personal article'}
                      </option>
                      {(target === 'confluence' ? confluenceSpaces : (Array.isArray(localSpaces) ? localSpaces : [])).map((space) => (
                        <option key={space.key} value={space.key}>
                          {space.name} ({space.key})
                        </option>
                      ))}
                    </select>
                  </label>

                  {target === 'local' && (
                    <fieldset className="space-y-2">
                      <legend className="mb-1.5 text-xs text-muted-foreground">
                        Who can read it locally — Confluence has no equivalent, so this has to be
                        chosen, not inherited
                      </legend>
                      {(
                        [
                          ['private', 'Private', 'Only you can read it.'],
                          ['shared', 'Shared', 'Every signed-in user can read it.'],
                        ] as const
                      ).map(([value, label, hint]) => (
                        <label
                          key={value}
                          className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border-interactive px-3 py-2"
                        >
                          <input
                            type="radio"
                            name="relocate-visibility"
                            value={value}
                            checked={visibility === value}
                            onChange={() => changeDestination(() => setVisibility(value))}
                            className="mt-0.5 h-4 w-4 accent-primary"
                            data-testid={`relocate-visibility-${value}`}
                          />
                          <span className="min-w-0">
                            <span className="block text-sm font-medium text-foreground">{label}</span>
                            <span className="block text-xs text-muted-foreground">{hint}</span>
                          </span>
                        </label>
                      ))}
                    </fieldset>
                  )}
                </section>

                <hr className="border-border" />

                {/* 2 — consequences */}
                <section className="space-y-3">
                  <h3 className="text-sm font-semibold text-foreground">What this move does</h3>
                  <ConsequenceLedger preview={shownPreview} target={target} />
                </section>

                <hr className="border-border" />

                {/* 3 — access */}
                <AccessChangeSection
                  accessChange={shownPreview.accessChange}
                  destinationChosen={destinationChosen}
                  updating={previewFetching}
                />

                <hr className="border-border" />

                {/* 4 — acknowledgements */}
                <section className="space-y-2.5">
                  <label className="flex cursor-pointer items-start gap-2.5">
                    <input
                      type="checkbox"
                      checked={ackAccess}
                      onChange={(event) => setAckAccess(event.target.checked)}
                      className="mt-0.5 h-4 w-4 rounded border-border-interactive accent-primary"
                      data-testid="relocate-ack-access"
                    />
                    <span className="text-sm text-foreground">
                      I understand this changes who can read the article.
                    </span>
                  </label>

                  {discardsVersions && (
                    <label className="flex cursor-pointer items-start gap-2.5">
                      <input
                        type="checkbox"
                        checked={ackDestructive}
                        onChange={(event) => setAckDestructive(event.target.checked)}
                        className="mt-0.5 h-4 w-4 rounded border-border-interactive accent-destructive"
                        data-testid="relocate-ack-versions"
                      />
                      <span className="text-sm text-foreground" data-testid="relocate-ack-versions-label">
                        Permanently delete this article’s{' '}
                        <Count>{shownPreview.localVersionCount}</Count> local version
                        {shownPreview.localVersionCount === 1 ? '' : 's'}. Confluence becomes its only
                        history.
                      </span>
                    </label>
                  )}

                  {target === 'local' &&
                    (upstream ? (
                      <label className="flex cursor-pointer items-start gap-2.5">
                        <input
                          type="checkbox"
                          checked={ackDestructive}
                          onChange={(event) => setAckDestructive(event.target.checked)}
                          className="mt-0.5 h-4 w-4 rounded border-border-interactive accent-destructive"
                          data-testid="relocate-ack-delete"
                        />
                        <span className="text-sm text-foreground" data-testid="relocate-ack-delete-label">
                          Delete “{upstream.title}” from Confluence space{' '}
                          <SpaceKeyName spaceKey={upstream.spaceKey} />. Everyone in Confluence
                          loses the page.
                        </span>
                      </label>
                    ) : (
                      <p className="text-sm text-destructive" role="alert" data-testid="relocate-no-upstream">
                        This article has no Confluence page on record, so the deletion cannot be
                        confirmed. Re-sync the space and try again.
                      </p>
                    ))}
                </section>
              </div>
            ) : null}
          </div>

          {/* Footer */}
          <div className="border-t border-border px-6 py-4">
            {failure && (
              <div className="mb-3 flex items-start gap-2" role="alert" data-testid="relocate-error">
                <AlertTriangle size={14} className="mt-0.5 shrink-0 text-destructive" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-destructive">{failure.message}</p>
                  {failure.conflict && (
                    <button
                      type="button"
                      onClick={handleReloadPreview}
                      className="nm-button-ghost mt-2"
                      data-testid="relocate-reload-preview"
                    >
                      <RotateCcw size={14} aria-hidden />
                      Reload preview
                    </button>
                  )}
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
              {blockedBecause && (
                <p
                  className="mr-auto text-xs text-muted-foreground"
                  data-testid="relocate-submit-hint"
                >
                  {blockedBecause}
                </p>
              )}
              <button
                type="button"
                onClick={onClose}
                className="nm-button-ghost"
                data-testid="relocate-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={!canSubmit}
                className={isDestructive ? 'nm-button-destructive' : 'nm-button-primary'}
                data-testid="relocate-submit"
              >
                {relocate.isPending && <Loader2 size={14} className="animate-spin" aria-hidden />}
                {relocate.isPending
                  ? 'Moving…'
                  : target === 'confluence'
                    ? 'Move to Confluence'
                    : 'Move to local space'}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
