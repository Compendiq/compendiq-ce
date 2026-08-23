/**
 * #1349 — Settings → Spaces & Sync: attachment storage + sweep.
 *
 * The rules under test mirror ImageIndexCard's (the named precedent):
 * a failed stats fetch renders as a FAILURE, never as zero bytes; "no run
 * yet" is an explicit state; the live delete sits behind a destructive
 * confirm dialog and never fires from the bare button; a trigger that found
 * a sweep already running reports that neutrally; amber is reserved for a
 * last run that did not complete.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AttachmentStorageStats, AttachmentSweepRun, AttachmentSweepStatus } from '@compendiq/contracts';
import { AttachmentStorageCard } from './AttachmentStorageCard';
import { toast } from 'sonner';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

/**
 * Flush the announcer's publish tick before asserting the polite region is
 * EMPTY (fixer, external round 2). The card publishes in TWO commits — the
 * watch effect stores a pending sentence, a second effect empties the region
 * and refills it from `setTimeout(…, 0)` — so a bare assertion right after
 * the first paint reads the region during the window BEFORE any sentence
 * could have been written. Both mount tests below then passed with the
 * `watchedFrom` narrowing deleted (mutation: announce `lastRun` whenever one
 * exists — the exact defect r2 fixed), i.e. they measured a scheduling
 * accident, not the guard. With this flush that mutation makes both fail.
 */
async function flushAnnouncerPublish() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function createWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

const STORE_STATS = {
  bytes: 3 * 1024 * 1024,
  files: 42,
  directories: 7,
  orphanDirectories: 1,
  orphanDirectoryBytes: 1024,
  orphanFiles: 2,
  orphanFileBytes: 2048,
  graceSkipped: 0,
  keepProtectedDirectories: 0,
  nestedDirectories: 0,
  unkeyedDirectories: 0,
  unreadableDirectories: 0,
};

const STATS: AttachmentStorageStats = {
  computedAt: new Date().toISOString(),
  running: false,
  stores: { confluence: STORE_STATS, local: { ...STORE_STATS, bytes: 512 * 1024, files: 5, directories: 2 } },
  missingLocalFiles: 1,
};

const COMPLETED_RUN: AttachmentSweepRun = {
  at: new Date().toISOString(),
  dryRun: true,
  status: 'completed',
  note: null,
  durationMs: 1234,
  stores: STATS.stores,
  missingLocalFiles: 1,
  candidateSample: [],
  candidatesTotal: 3,
  deleted: null,
};

const SWEEP: AttachmentSweepStatus = { running: false, lastRun: COMPLETED_RUN };

interface FetchPlan {
  stats?: AttachmentStorageStats | 'error';
  sweep?: AttachmentSweepStatus | 'error';
  post?: { started: boolean; alreadyRunning: boolean } | 'error';
  /** What the sweep GET answers once a POST has been seen (the finished run). */
  sweepAfterPost?: AttachmentSweepStatus;
  /**
   * One answer per POST — `[0]` after the first press, `[1]` after the second,
   * the last entry thereafter. For the two-consecutive-runs cells; a single
   * `sweepAfterPost` cannot express "a second run, same verdict".
   */
  sweepAfterPosts?: AttachmentSweepStatus[];
  /** Fail the SECOND stats GET onward — the ordinary failed-refetch shape. */
  statsFailsAfterFirst?: boolean;
}

let postedBodies: unknown[] = [];

/**
 * Restated, not imported: the card does not export them, and a test that read
 * the module's own constants would advance by whatever they happen to be and
 * pass against a warm-up shortened to nothing. These are the documented
 * values — 5s poll (the admin rate limit is 20/min per route and two routes
 * poll) and a 20s post-kick window.
 */
const POLL_MS_UNDER_TEST = 5_000;
const KICK_WARMUP_MS_UNDER_TEST = 20_000;

function mockApi(plan: FetchPlan): void {
  postedBodies = [];
  let statsGets = 0;
  let postSeen = false;
  let postCount = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/admin/attachments/stats')) {
      statsGets += 1;
      if (plan.statsFailsAfterFirst && statsGets > 1) return json({ message: 'boom' }, 500);
      return plan.stats === 'error' ? json({ message: 'boom' }, 500) : json(plan.stats ?? STATS);
    }
    if (url.endsWith('/admin/attachments/sweep') && (init?.method ?? 'GET') === 'GET') {
      if (postSeen && plan.sweepAfterPosts) {
        return json(plan.sweepAfterPosts[Math.min(postCount - 1, plan.sweepAfterPosts.length - 1)]);
      }
      if (postSeen && plan.sweepAfterPost) return json(plan.sweepAfterPost);
      return plan.sweep === 'error' ? json({ message: 'boom' }, 500) : json(plan.sweep ?? SWEEP);
    }
    if (url.endsWith('/admin/attachments/sweep') && init?.method === 'POST') {
      postedBodies.push(JSON.parse(String(init?.body)));
      postSeen = true;
      postCount += 1;
      return plan.post === 'error'
        ? json({ message: 'boom' }, 500)
        : json(plan.post ?? { started: true, alreadyRunning: false }, 202);
    }
    return json({});
  });
}

describe('AttachmentStorageCard (#1349)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders neutral per-store figures from the persisted record', async () => {
    mockApi({});
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    await screen.findByTestId('attachment-storage-counters');
    expect(screen.getByTestId('attachment-storage-confluence-bytes').textContent).toContain('3.0 MB');
    expect(screen.getByTestId('attachment-storage-local-bytes').textContent).toContain('512.0 KB');
    // Orphan candidates and the missing-rows note are neutral measurements.
    expect(screen.getByTestId('attachment-storage-missing-rows').textContent).toMatch(/1 local attachment record/i);
  });

  it('shows an explicit no-run-yet state instead of claiming zero bytes', async () => {
    mockApi({
      stats: { computedAt: null, running: false, stores: null, missingLocalFiles: null },
      sweep: { running: false, lastRun: null },
    });
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    await screen.findByTestId('attachment-storage-empty');
    expect(screen.getByTestId('attachment-storage-empty').textContent).toMatch(/no sweep has run/i);
    expect(screen.queryByTestId('attachment-storage-counters')).not.toBeInTheDocument();
  });

  it('a failed stats fetch is a failure, not zero bytes', async () => {
    mockApi({ stats: 'error', sweep: 'error' });
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    await screen.findByTestId('attachment-storage-error');
    expect(screen.getByTestId('attachment-storage-error').textContent).toMatch(/could not be read/i);
    expect(screen.queryByText(/0 B/)).not.toBeInTheDocument();
  });

  // Fixer, external round: the two admin GETs share a backend, so both failing
  // is the ORDINARY outage shape — two paragraphs each saying "could not be
  // read" is one fact told twice.
  it('states a total outage once, not twice', async () => {
    mockApi({ stats: 'error', sweep: 'error' });
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    await screen.findByTestId('attachment-storage-error');
    expect(screen.queryByTestId('attachment-sweep-status-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('attachment-storage-error').textContent).toMatch(
      /storage record could not be read/i,
    );
  });

  // Fixer, external round: counted, on the wire and promised by the service
  // comment, but no surface rendered it — so one colliding common filename
  // pinned a whole pageless directory with no on-screen hint at all.
  it('reports directories the keep-set protected', async () => {
    mockApi({
      stats: {
        ...STATS,
        stores: {
          confluence: { ...STORE_STATS, keepProtectedDirectories: 2 },
          local: { ...STORE_STATS, keepProtectedDirectories: 0 },
        },
      },
    });
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    const note = await screen.findByTestId('attachment-storage-keep-protected');
    expect(note.textContent).toMatch(/2 pageless directories were left standing/i);
  });

  it('does not claim protected directories when there are none', async () => {
    mockApi({});
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });
    await screen.findByTestId('attachment-storage-counters');
    expect(screen.queryByTestId('attachment-storage-keep-protected')).not.toBeInTheDocument();
  });

  // Fixer r1: the FOURTH declined verdict. A root entry whose name is not a
  // usable attachment key (`tmp.12345/`) is dropped before the walk opens it,
  // so its bytes are in no figure and it reached none of the three lines
  // above — a partial walk showing the same clean figures as a complete one,
  // which is the exact thing those three lines exist to prevent.
  it('reports directories that do not look like attachment keys', async () => {
    mockApi({
      stats: {
        ...STATS,
        stores: {
          confluence: { ...STORE_STATS, unkeyedDirectories: 1 },
          local: { ...STORE_STATS, unkeyedDirectories: 2 },
        },
      },
    });
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    const note = await screen.findByTestId('attachment-storage-unkeyed');
    expect(note.textContent).toMatch(/3 directories do not look like attachment keys/i);
    expect(note.textContent).toMatch(/not in the figures above/i);
    // A measurement, never a state — muted like its three siblings.
    expect(note.className).toContain('text-muted-foreground');
  });

  it('does not claim unkeyed directories when there are none', async () => {
    mockApi({});
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });
    await screen.findByTestId('attachment-storage-counters');
    expect(screen.queryByTestId('attachment-storage-unkeyed')).not.toBeInTheDocument();
  });

  it('agrees with itself on number — never "1 files in 1 directories"', async () => {
    mockApi({
      stats: {
        ...STATS,
        stores: {
          confluence: { ...STORE_STATS, files: 1, directories: 1 },
          local: { ...STORE_STATS, files: 2, directories: 3 },
        },
      },
    });
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    await screen.findByTestId('attachment-storage-counters');
    expect(screen.getByTestId('attachment-storage-confluence-bytes').textContent).toContain(
      '1 file in 1 directory',
    );
    expect(screen.getByTestId('attachment-storage-local-bytes').textContent).toContain(
      '2 files in 3 directories',
    );
  });

  // Review r1: `stats.isError && sweep.isError` needed BOTH GETs down before
  // any failure showed — a one-sided failure (each route has its own
  // rate-limit counter and `retry: false`) collapsed into the empty state or
  // into silence, the exact anti-pattern the header comment forbids.
  it('a failed stats fetch is a failure even when the sweep GET succeeds — never the empty state', async () => {
    mockApi({ stats: 'error', sweep: { running: false, lastRun: null } });
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    await screen.findByTestId('attachment-storage-error');
    expect(screen.queryByTestId('attachment-storage-empty')).not.toBeInTheDocument();
  });

  it('a failed stats fetch beside a healthy last run shows the failure AND keeps the last-run line', async () => {
    mockApi({ stats: 'error', sweep: SWEEP });
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    await screen.findByTestId('attachment-storage-error');
    expect(screen.queryByTestId('attachment-storage-empty')).not.toBeInTheDocument();
    // The sweep GET answered, so its half of the card still renders.
    expect(screen.getByTestId('attachment-sweep-last-run')).toBeInTheDocument();
  });

  /**
   * Review r2. TanStack retains `data` through a failed REFETCH, which is the
   * ordinary poll-failure shape on a card that polls two admin routes every
   * 5s. The counters block and the missing-rows line were guarded on
   * `!statsError`; the four walk-verdict lines were gated on `stores &&`
   * alone — so "The storage figures could not be read" rendered directly above
   * four stale figures derived from that same record, one of them reading
   * "…the figures above cover only what the walk could see" with nothing above
   * it. Every consumer now reads one derived `figures` value.
   */
  it('a failed stats refetch takes the walk verdicts with it, not just the counters', async () => {
    mockApi({
      statsFailsAfterFirst: true,
      stats: {
        ...STATS,
        stores: {
          confluence: {
            ...STORE_STATS,
            unreadableDirectories: 10,
            nestedDirectories: 4,
            graceSkipped: 8,
            keepProtectedDirectories: 6,
          },
          local: STORE_STATS,
        },
      },
    });
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <AttachmentStorageCard />
      </QueryClientProvider>,
    );

    // First paint: the record read cleanly and all four verdicts render.
    await screen.findByTestId('attachment-storage-unreadable');
    expect(screen.getByTestId('attachment-storage-nested')).toBeInTheDocument();

    // …then the poll fails while the cached record is retained.
    await qc.refetchQueries({ queryKey: ['admin', 'attachment-storage-stats'] });

    await screen.findByTestId('attachment-storage-error');
    for (const id of [
      'attachment-storage-counters',
      'attachment-storage-measured-at',
      'attachment-storage-missing-rows',
      'attachment-storage-unreadable',
      'attachment-storage-nested',
      'attachment-storage-grace',
      'attachment-storage-keep-protected',
    ]) {
      expect(screen.queryByTestId(id), `${id} must not survive a failed stats read`).not.toBeInTheDocument();
    }
  });

  /**
   * Review r2: the ladder's fifth state. `attachment_storage_stats` is written
   * only by a CLEAN completed walk while the last-run record is written by
   * every run, so a first sweep that refuses — the mis-pointed ATTACHMENTS_DIR
   * this feature's refusal exists for — fails, or stands one store down leaves
   * `stores: null` beside a non-null `lastRun`. `noRunYet` needs BOTH records
   * empty, so the empty state was suppressed and the ladder's tail rendered
   * `null`: no counters, no pending, no error, no empty line, and no statement
   * that nothing had ever been measured.
   */
  it('says so when there is a last run but no measurement, instead of rendering nothing', async () => {
    mockApi({
      stats: { computedAt: null, running: false, stores: null, missingLocalFiles: null },
      sweep: {
        running: false,
        lastRun: {
          ...COMPLETED_RUN,
          status: 'refused',
          note: 'attachments root missing or unreadable',
          stores: null,
          candidatesTotal: 0,
        },
      },
    });
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    const line = await screen.findByTestId('attachment-storage-unmeasured');
    expect(line.textContent).toMatch(/no completed measurement yet/i);
    // Not the empty state — a sweep HAS run, it just produced no figures.
    expect(screen.queryByTestId('attachment-storage-empty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('attachment-storage-counters')).not.toBeInTheDocument();
    // The run's own verdict still renders beside it.
    expect(screen.getByTestId('attachment-sweep-last-run-problem')).toBeInTheDocument();
  });

  /**
   * Fixer, verification round: the same fifth state, reached with the LAST-RUN
   * GET as the thing that failed. The two GETs fail independently by decision
   * (review r1), so this is reachable — and the line above was written for the
   * other way in, asserting "the last run produced no figures" directly above
   * `attachment-sweep-status-error` saying that record could not be read. One
   * paragraph stating as fact what the next one calls unknown is the card's own
   * "a failure is reported, never inferred" rule inverted. The absent stats
   * record is certain (that GET succeeded and answered `stores: null`); what
   * produced it is not.
   */
  it('claims nothing about the last run when the last-run record is the unreadable one', async () => {
    mockApi({
      stats: { computedAt: null, running: false, stores: null, missingLocalFiles: null },
      sweep: 'error',
    });
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    const line = await screen.findByTestId('attachment-storage-unmeasured');
    expect(line.textContent).toMatch(/no completed measurement is on record/i);
    expect(
      line.textContent,
      'the last-run record could not be read, so this line cannot report what the last run produced',
    ).not.toMatch(/the last run produced/i);
    // The remedy survives, and the failed read is still reported beside it.
    expect(line.textContent).toMatch(/press dry run/i);
    expect(screen.getByTestId('attachment-sweep-status-error')).toBeInTheDocument();
  });

  it('renders no unmeasured line when the figures are there', async () => {
    mockApi({});
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });
    await screen.findByTestId('attachment-storage-counters');
    expect(screen.queryByTestId('attachment-storage-unmeasured')).not.toBeInTheDocument();
  });

  it('a failed sweep GET is a failure beside healthy storage figures — a refused run must not vanish silently', async () => {
    mockApi({ stats: STATS, sweep: 'error' });
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    await screen.findByTestId('attachment-sweep-status-error');
    expect(screen.getByTestId('attachment-sweep-status-error').textContent).toMatch(/could not be read/i);
    expect(screen.queryByTestId('attachment-storage-empty')).not.toBeInTheDocument();
    // The stats GET answered, so the figures still render.
    expect(screen.getByTestId('attachment-storage-counters')).toBeInTheDocument();
  });

  it('Dry run posts dryRun:true and reports the start', async () => {
    mockApi({});
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    await screen.findByTestId('attachment-storage-counters');
    fireEvent.click(screen.getByTestId('attachment-sweep-dry-run'));

    await waitFor(() => expect(postedBodies).toEqual([{ dryRun: true }]));
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/dry run started/i));
  });

  it('Delete orphans requires the destructive confirm — the bare button never posts', async () => {
    mockApi({});
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    await screen.findByTestId('attachment-storage-counters');
    fireEvent.click(screen.getByTestId('attachment-sweep-delete'));
    expect(postedBodies).toEqual([]);

    // The dialog names the destructive action and carries the destructive treatment.
    const confirm = await screen.findByTestId('confirm-dialog-confirm');
    expect(confirm.className).toContain('nm-button-destructive');
    fireEvent.click(confirm);

    await waitFor(() => expect(postedBodies).toEqual([{ dryRun: false }]));
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/deleting orphans/i));
  });

  it('cancelling the confirm posts nothing', async () => {
    mockApi({});
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    await screen.findByTestId('attachment-storage-counters');
    fireEvent.click(screen.getByTestId('attachment-sweep-delete'));
    fireEvent.click(await screen.findByTestId('confirm-dialog-cancel'));

    expect(postedBodies).toEqual([]);
  });

  /**
   * Review r1. The paragraph that names what Delete orphans does and what it
   * costs was completely unpinned: replacing it with a comment left all 41
   * cells green while both buttons kept `aria-describedby` pointing at an id
   * that no longer existed. CLAUDE.md's DeepSearchToggle precedent is explicit
   * — a cost caveat is visible at rest, wired to the control, and the tests
   * fail when it stops being either.
   */
  it('the cost caveat is on screen and describes both controls', async () => {
    mockApi({});
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    await screen.findByTestId('attachment-storage-counters');
    const note = screen.getByTestId('attachment-sweep-note');
    expect(note.id).toBeTruthy();
    for (const testId of ['attachment-sweep-dry-run', 'attachment-sweep-delete']) {
      expect(
        screen.getByTestId(testId).getAttribute('aria-describedby'),
        `${testId} must be described by the caveat`,
      ).toBe(note.id);
    }
    // What it must still say: the 24h floor, the delete-time re-check, and
    // the blast radius an operator would otherwise read backwards.
    expect(note.textContent).toMatch(/24 hours/i);
    expect(note.textContent).toMatch(/re-checked at delete time/i);
    expect(note.textContent, 'the live-page cache case must be named').toMatch(
      /cached Confluence image/i,
    );
  });

  /**
   * Review r1. The sweep DOES delete images attached to a live Confluence page
   * that no body embeds (`walkConfluenceTree` emits `orphan_file` for a known
   * key's unreferenced image-like files). The ADMIN-GUIDE says so; the last
   * surface before the irreversible act framed deletion as limited to files
   * nothing references at all, which an operator reads as "nothing on a live
   * page" — the opposite. Recoverable (Confluence re-serves the bytes), but
   * this is the sentence whose job is to name the cost.
   */
  it('the confirm dialog names the cached-Confluence-image case', async () => {
    mockApi({});
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    await screen.findByTestId('attachment-storage-counters');
    fireEvent.click(screen.getByTestId('attachment-sweep-delete'));

    const dialog = await screen.findByTestId('confirm-dialog-confirm');
    const text = dialog.closest('[role="dialog"]')?.textContent ?? document.body.textContent ?? '';
    expect(text).toMatch(/cached Confluence images that no page body embeds are removed too/i);
    expect(text).toMatch(/re-fetched from Confluence/i);
    // The claims it already made must still be there.
    expect(text).toMatch(/cannot be undone/i);
    expect(text).toMatch(/page icons/i);
  });

  it('an already-running trigger reports neutrally, names the remedy, and promises no outcome', async () => {
    mockApi({ post: { started: false, alreadyRunning: true } });
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    await screen.findByTestId('attachment-storage-counters');
    fireEvent.click(screen.getByTestId('attachment-sweep-dry-run'));

    await waitFor(() => expect(toast.message).toHaveBeenCalledWith(expect.stringMatching(/holds the lock/i)));
    expect(toast.success).not.toHaveBeenCalled();
    // The acquire is `failClosed`, so `alreadyRunning` also covers "Redis was
    // unreachable and no sweep is running" — on which branch nothing ever
    // finishes. The copy must therefore offer the remedy rather than promise
    // a result (fixer r1).
    const said = vi.mocked(toast.message).mock.calls.at(-1)?.[0] as string;
    expect(said).toMatch(/press again/i);
    expect(said).not.toMatch(/when it finishes/i);
  });

  it('a last run that did not complete gets the amber strip with its note', async () => {
    mockApi({
      sweep: {
        running: false,
        lastRun: {
          ...COMPLETED_RUN,
          status: 'refused',
          note: 'attachments root missing or unreadable',
          stores: null,
        },
      },
    });
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    const strip = await screen.findByTestId('attachment-sweep-last-run-problem');
    expect(strip.textContent).toMatch(/attachments root missing/i);
    // Not a live region — see the announcer cells below.
    expect(strip.getAttribute('role')).toBeNull();
    expect(strip.className).toContain('text-warning');
    // A refusal runs before the delete phase, so this claim is always true.
    expect(strip.textContent).toMatch(/no files were deleted/i);
  });

  // Review r1 minor: the backend keeps the last COMPLETED walk's figures
  // through a refused/failed run, so after one the counters can be days older
  // than the amber strip directly below them — the figures must carry their
  // own date (`computedAt`, shipped for exactly this) or the operator judging
  // whether to press Delete orphans cannot know how stale they are.
  it('the figures carry their own measured date — a newer refused run cannot masquerade as their age', async () => {
    const statsAt = new Date(Date.now() - 3 * 86_400_000).toISOString(); // 3 days ago
    mockApi({
      stats: { ...STATS, computedAt: statsAt },
      sweep: {
        running: false,
        lastRun: {
          ...COMPLETED_RUN,
          at: new Date().toISOString(),
          dryRun: false,
          status: 'refused',
          note: 'confluence store has zero files while the database references attachments — refusing to delete',
          stores: null,
        },
      },
    });
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    await screen.findByTestId('attachment-storage-counters');
    const measured = screen.getByTestId('attachment-storage-measured-at');
    expect(measured.textContent).toMatch(/measured/i);
    expect(measured.textContent).toMatch(/3d ago/);
    // Both dates are on screen: the old figures' and the newer refusal's.
    expect(screen.getByTestId('attachment-sweep-last-run-problem').textContent).toMatch(/just now/);
  });

  it('the measured date renders beside healthy figures too, and never without them', async () => {
    mockApi({});
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });
    await screen.findByTestId('attachment-storage-counters');
    expect(screen.getByTestId('attachment-storage-measured-at').textContent).toMatch(/just now/);
  });

  it('no measured date in the no-run-yet state — there is nothing it would date', async () => {
    mockApi({
      stats: { computedAt: null, running: false, stores: null, missingLocalFiles: null },
      sweep: { running: false, lastRun: null },
    });
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });
    await screen.findByTestId('attachment-storage-empty');
    expect(screen.queryByTestId('attachment-storage-measured-at')).not.toBeInTheDocument();
  });

  // Review r1: a FAILED live run can abort mid-delete, and the backend now
  // records the partial totals — "No files were deleted." was a false claim
  // on a destructive operator surface.
  it('a failed live run with partial deletions says so instead of claiming nothing was deleted', async () => {
    mockApi({
      sweep: {
        running: false,
        lastRun: {
          ...COMPLETED_RUN,
          dryRun: false,
          status: 'failed',
          note: 'sweep failed — see the server logs',
          stores: null,
          deleted: { directories: 1, files: 3, bytes: 87, imageEmbeddingRows: 1, pagesMarkedDirty: 1 },
        },
      },
    });
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    const strip = await screen.findByTestId('attachment-sweep-last-run-problem');
    expect(strip.textContent).toMatch(/stopped partway/i);
    expect(strip.textContent).toMatch(/3 files/i);
    expect(strip.textContent).not.toMatch(/no files were deleted/i);
  });

  // Review r2: `fs.rm({recursive:true})` can unlink files inside a directory
  // and then throw, and totals are incremented only AFTER the rm returns — so
  // a failed live run with zero-valued recorded totals cannot honestly claim
  // "No files were deleted."; it claims what the record supports instead.
  it('a failed live run with a started delete phase but zero recorded totals claims only what the record supports', async () => {
    mockApi({
      sweep: {
        running: false,
        lastRun: {
          ...COMPLETED_RUN,
          dryRun: false,
          status: 'failed',
          note: 'sweep failed — see the server logs',
          stores: null,
          deleted: { directories: 0, files: 0, bytes: 0, imageEmbeddingRows: 0, pagesMarkedDirty: 0 },
        },
      },
    });
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    const strip = await screen.findByTestId('attachment-sweep-last-run-problem');
    expect(strip.textContent).toMatch(/no deletions were recorded/i);
    expect(strip.textContent).not.toMatch(/no files were deleted/i);
  });

  it('a failed live run whose delete phase never started keeps the honest "no files" claim', async () => {
    mockApi({
      sweep: {
        running: false,
        lastRun: {
          ...COMPLETED_RUN,
          dryRun: false,
          status: 'failed',
          note: 'sweep failed — see the server logs',
          stores: null,
          deleted: null,
        },
      },
    });
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    const strip = await screen.findByTestId('attachment-sweep-last-run-problem');
    expect(strip.textContent).toMatch(/no files were deleted/i);
  });

  it('a completed last run renders neutrally — no amber at rest', async () => {
    mockApi({});
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    await screen.findByTestId('attachment-sweep-last-run');
    expect(screen.queryByTestId('attachment-sweep-last-run-problem')).not.toBeInTheDocument();
  });

  /**
   * Review r2. The hand-rolled `nm-action-destructive` + box classes shipped a
   * control that disagreed with the `nm-button-ghost` beside it in the same
   * row on every axis that matters: 14px/400 against 13px/500, and — because
   * `@utility nm-action-destructive` declares colour, hover and focus only —
   * an explicitly TRANSPARENT border against Dry run's
   * `--color-border-interactive` one. `transparent` is not forced, so under
   * `forced-colors: active` the colour and the hover fill are both overridden
   * and the destructive control becomes indistinguishable from body text
   * while its neutral sibling keeps its outline — the failure ADR-010's "every
   * operable surface keeps a 1px solid border" rule exists to prevent.
   *
   * `nm-button-destructive` is what the lane brief specified, what the
   * component comment claimed and what the PR body describes; it matches
   * `nm-button-ghost`'s box metrics by construction. `nm-action-destructive`
   * stays the right choice for a destructive row INSIDE a bordered container
   * (its three pinned callsites) — not for a peer button beside a bordered one.
   */
  it('Delete orphans is the filled destructive variant, matching its sibling’s box', async () => {
    mockApi({});
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    await screen.findByTestId('attachment-storage-counters');
    const del = screen.getByTestId('attachment-sweep-delete');
    const dry = screen.getByTestId('attachment-sweep-dry-run');

    expect(del.className.split(/\s+/)).toContain('nm-button-destructive');
    // No hand-rolled box beside it: the recipe owns padding, radius, border,
    // type size and weight, so a stray override is how the row drifts apart.
    for (const cls of ['text-sm', 'border-transparent', 'px-3', 'py-1.5', 'rounded-md']) {
      expect(del.className.split(/\s+/), `must not re-declare ${cls}`).not.toContain(cls);
    }
    // Both peers take their box from a `nm-button-*` recipe, not the callsite.
    expect(dry.className.split(/\s+/)).toContain('nm-button-ghost');
  });

  // Review r2: `unreadableDirectories` is recorded per store precisely so an
  // unjudged directory is REPORTED instead — a partial walk must not show the
  // same clean figures as a complete one. Muted, not amber: a fact about the
  // last run that qualifies the figures, not a state needing attention.
  it('renders a muted line when directories could not be read, and nothing when all were', async () => {
    mockApi({
      stats: {
        ...STATS,
        stores: {
          confluence: { ...STORE_STATS, unreadableDirectories: 2 },
          local: { ...STORE_STATS, unreadableDirectories: 1 },
        },
      },
    });
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    const note = await screen.findByTestId('attachment-storage-unreadable');
    expect(note.textContent).toMatch(/3 directories could not be read/i);
    expect(note.textContent).toMatch(/not judged/i);
    expect(note.className).toContain('text-muted-foreground');
    expect(note.className).not.toContain('text-warning');
  });

  it('no unreadable-directories line when every directory was read', async () => {
    mockApi({});
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    await screen.findByTestId('attachment-storage-counters');
    expect(screen.queryByTestId('attachment-storage-unreadable')).not.toBeInTheDocument();
  });

  // Review r1: the third walk verdict. `nestedDirectories` is what keeps a
  // directory holding sub-folders from being judged a 0 B orphan and `rm
  // -rf`'d — the mechanism that cost the page-icon store. It must be visible
  // for the same reason its two siblings are.
  it('reports pageless directories that hold sub-folders or links, and nothing when there are none', async () => {
    mockApi({
      stats: {
        ...STATS,
        stores: {
          confluence: { ...STORE_STATS, nestedDirectories: 1 },
          local: { ...STORE_STATS, nestedDirectories: 0 },
        },
      },
    });
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    const note = await screen.findByTestId('attachment-storage-nested');
    expect(note.textContent).toMatch(/1 pageless directory holds sub-folders or links/i);
    expect(note.textContent).toMatch(/not judged/i);
    expect(note.className).toContain('text-muted-foreground');
    expect(note.className).not.toContain('text-warning');
  });

  it('no nested-directory line when every directory was flat', async () => {
    mockApi({});
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });
    await screen.findByTestId('attachment-storage-counters');
    expect(screen.queryByTestId('attachment-storage-nested')).not.toBeInTheDocument();
  });

  // Review r1: a store whose entire orphan population is inside the 24-hour
  // grace window reported "0 candidates" — indistinguishable from a store with
  // nothing to clean, and that is exactly the state an admin lands in right
  // after the bulk page delete that sends them to this card.
  it('reports orphans deferred by the grace window, and nothing when there are none', async () => {
    mockApi({
      stats: {
        ...STATS,
        stores: {
          confluence: { ...STORE_STATS, graceSkipped: 500 },
          local: { ...STORE_STATS, graceSkipped: 0 },
        },
      },
    });
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    const note = await screen.findByTestId('attachment-storage-grace');
    expect(note.textContent).toMatch(/500 files or directories are orphaned but younger than 24 hours/i);
    expect(note.textContent).toMatch(/become candidates once they age out/i);
    expect(note.className).toContain('text-muted-foreground');
    expect(note.className).not.toContain('text-warning');
  });

  it('no grace line when nothing is waiting out the window', async () => {
    mockApi({});
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });
    await screen.findByTestId('attachment-storage-counters');
    expect(screen.queryByTestId('attachment-storage-grace')).not.toBeInTheDocument();
  });

  // Review r1: "dry-run-first" is the safety premise of the feature and the
  // confirm dialog's own instruction, but the candidate LIST was rendered
  // nowhere — so reviewing a dry run meant reading a number, and seeing WHICH
  // files a live run would destroy meant curling an admin route.
  it('lists the dry run candidates behind a disclosure, with reason and size', async () => {
    mockApi({
      sweep: {
        running: false,
        lastRun: {
          ...COMPLETED_RUN,
          candidatesTotal: 2,
          candidateSample: [
            { store: 'confluence', key: '55555', filename: null, bytes: 4096, reason: 'orphan_directory' },
            { store: 'local', key: '77', filename: 'stray.png', bytes: 1024, reason: 'orphan_file' },
          ],
        },
      },
    });
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    const disclosure = await screen.findByTestId('attachment-sweep-candidates');
    expect(disclosure.textContent).toMatch(/Show the 2 candidates/i);
    const list = screen.getByTestId('attachment-sweep-candidate-list');
    expect(list.textContent).toContain('55555/');
    expect(list.textContent).toMatch(/whole directory/i);
    expect(list.textContent).toContain('local/77/stray.png');
    expect(list.textContent).toMatch(/single file/i);
    expect(list.textContent).toContain('1.0 KB');
    // A 100-row sample must never push the actions off screen.
    expect(list.className).toContain('overflow-y-auto');
  });

  /**
   * Review r1 (WCAG 2.1.1, axe `scrollable-region-focusable`). The scroller
   * above holds about ten of up to 100 rows and every descendant is a
   * `<span>`, so with no `tabindex` there is no keyboard path past row ten in
   * Chromium or WebKit — on the one surface that says WHICH files a live run
   * will destroy, and which the confirm dialog instructs the operator to
   * read. The name matters as much as the stop: a focusable region with no
   * accessible name announces nothing when focus lands on it.
   */
  it('the candidate scroller is a keyboard-reachable, named region', async () => {
    mockApi({
      sweep: {
        running: false,
        lastRun: {
          ...COMPLETED_RUN,
          candidatesTotal: 1,
          candidateSample: [
            { store: 'confluence', key: '55555', filename: null, bytes: 4096, reason: 'orphan_directory' },
          ],
        },
      },
    });
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    const list = await screen.findByTestId('attachment-sweep-candidate-list');
    expect(list.getAttribute('tabindex'), 'a scroll container must be reachable by keyboard').toBe(
      '0',
    );
    expect(
      list.getAttribute('aria-label') ?? list.getAttribute('aria-labelledby'),
      'a focusable region needs an accessible name',
    ).toBeTruthy();
    // The same ring recipe the disclosure summary carries — the UA outline is
    // the fallback this card's siblings already refuse.
    expect(list.className).toContain('focus-visible:ring-2');
  });

  it('says the sample is bounded when the run found more candidates than it kept', async () => {
    mockApi({
      sweep: {
        running: false,
        lastRun: {
          ...COMPLETED_RUN,
          candidatesTotal: 940,
          candidateSample: [
            { store: 'confluence', key: '1', filename: 'a.png', bytes: 1, reason: 'orphan_file' },
          ],
        },
      },
    });
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    const disclosure = await screen.findByTestId('attachment-sweep-candidates');
    expect(disclosure.textContent).toMatch(/Showing the first 1 of 940/i);
  });

  /**
   * Review r2. `candidateSample` is dual-purpose — the contract calls it
   * "candidates/deletions" — and after a LIVE run it holds the entries the
   * walk found, most of which the run then destroyed. The card labelled them
   * "candidates" anyway, directly under post-delete figures reporting zero
   * orphans: one card saying there is nothing to sweep and listing two things
   * to sweep a few lines below. The operator's reading is "it did nothing,
   * press Delete again" — the exact failure the post-delete figures were
   * introduced to prevent.
   *
   * The live wording is past tense about the WALK and never claims removal
   * per row, because when one store stands down for the mis-mount anomaly its
   * entries are reported and deliberately NOT deleted.
   */
  it('a completed live run never calls what it destroyed a current candidate', async () => {
    mockApi({
      stats: {
        ...STATS,
        stores: {
          confluence: { ...STORE_STATS, orphanDirectories: 0, orphanFiles: 0, orphanDirectoryBytes: 0, orphanFileBytes: 0 },
          local: { ...STORE_STATS, orphanDirectories: 0, orphanFiles: 0, orphanDirectoryBytes: 0, orphanFileBytes: 0 },
        },
      },
      sweep: {
        running: false,
        lastRun: {
          ...COMPLETED_RUN,
          dryRun: false,
          candidatesTotal: 2,
          candidateSample: [
            { store: 'confluence', key: '12345', filename: null, bytes: 4096, reason: 'orphan_directory' },
            { store: 'local', key: '77', filename: 'gone.png', bytes: 2048, reason: 'orphan_file' },
          ],
          deleted: { directories: 1, files: 1, bytes: 6144, imageEmbeddingRows: 0, pagesMarkedDirty: 1 },
        },
      },
    });
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    const disclosure = await screen.findByTestId('attachment-sweep-candidates');
    const lastRun = screen.getByTestId('attachment-sweep-last-run');
    for (const el of [disclosure, lastRun]) {
      expect(el.textContent, 'a live run lists what it FOUND, not what is pending').not.toMatch(
        /candidate/i,
      );
    }
    expect(lastRun.textContent).toMatch(/2 found/i);
    expect(disclosure.textContent).toMatch(/what the sweep found/i);
    // The list itself is unchanged — it is the label that was the lie.
    const list = screen.getByTestId('attachment-sweep-candidate-list');
    expect(list.textContent).toContain('local/77/gone.png');
    // …and the rule reaches the ACCESSIBLE name too (fixer r1). The assertions
    // above read `textContent`, which never contains an attribute value, so
    // the region kept announcing itself as "Orphan candidates" after a live
    // run — the one wording this cell exists to forbid, surviving where the
    // cell could not see it.
    expect(list.getAttribute('aria-label')).not.toMatch(/candidate/i);
    expect(list.getAttribute('aria-label')).toBe('What the sweep found');
  });

  it('a completed DRY run still calls them candidates — they really are pending', async () => {
    mockApi({
      sweep: {
        running: false,
        lastRun: {
          ...COMPLETED_RUN,
          dryRun: true,
          candidatesTotal: 1,
          candidateSample: [
            { store: 'confluence', key: '12345', filename: null, bytes: 4096, reason: 'orphan_directory' },
          ],
        },
      },
    });
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    const disclosure = await screen.findByTestId('attachment-sweep-candidates');
    expect(disclosure.textContent).toMatch(/Show the 1 candidate/i);
    expect(screen.getByTestId('attachment-sweep-last-run').textContent).toMatch(/1 candidate/i);
    // Visible copy and accessible name agree — a dry run's entries really are
    // pending (fixer r1, the other half of the cell above).
    expect(screen.getByTestId('attachment-sweep-candidate-list').getAttribute('aria-label')).toBe(
      'Orphan candidates',
    );
  });

  it('renders no candidate disclosure when the last run found nothing', async () => {
    mockApi({});
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });
    await screen.findByTestId('attachment-sweep-last-run');
    expect(screen.queryByTestId('attachment-sweep-candidates')).not.toBeInTheDocument();
  });

  // Review r1: the anomaly verdict is per store, so a run can COMPLETE having
  // deliberately left one store alone. That is attention-worthy (it usually
  // means a mis-mounted ATTACHMENTS_DIR), and a completed run used to render
  // no note at all.
  it('renders an amber note for a completed run that stood one store down', async () => {
    mockApi({
      sweep: {
        running: false,
        lastRun: {
          ...COMPLETED_RUN,
          dryRun: false,
          note: 'confluence store has zero files while the database references attachments — refusing to delete',
          deleted: { directories: 1, files: 2, bytes: 2048, imageEmbeddingRows: 0, pagesMarkedDirty: 0 },
        },
      },
    });
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    const note = await screen.findByTestId('attachment-sweep-partial-note');
    expect(note.textContent).toMatch(/One store was left alone/i);
    expect(note.textContent).toMatch(/confluence store has zero files/i);
    expect(note.className).toContain('text-warning');
    // Not a live region of its own — the card's one announcer speaks for a run
    // it watched, so opening the tab does not re-read a days-old stand-down.
    expect(note).not.toHaveAttribute('role');
    // The ordinary completed line still reports what WAS deleted.
    expect(screen.getByTestId('attachment-sweep-last-run').textContent).toMatch(/deleted/i);
  });

  it('renders no partial note for an unqualified completion', async () => {
    mockApi({});
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });
    await screen.findByTestId('attachment-sweep-last-run');
    expect(screen.queryByTestId('attachment-sweep-partial-note')).not.toBeInTheDocument();
  });

  /**
   * Review r2. The kick toast promises the outcome will land on the card
   * ("figures update here when the walk finishes"), and the 5s poll then swaps
   * the running chip for the verdict silently — so a screen-reader user who
   * pressed Delete orphans was told the run STARTED and never told it finished
   * or what it removed. That was r2's finding; putting `role="status"` on the
   * conditionally-rendered last-run line was its first cut, and it announced
   * the HISTORICAL record instead: a live region inserted into the DOM
   * carrying text is announced on insertion, so merely opening this tab read
   * out a run from three days ago. The three strips are therefore plain text
   * and the card carries ONE always-mounted, initially EMPTY polite region
   * that speaks only for a run this card watched.
   */
  it('announces nothing on mount — the record is history, not an event', async () => {
    mockApi({});
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    const lastRun = await screen.findByTestId('attachment-sweep-last-run');
    // The live region exists from the first paint (that is what stops the
    // insertion announcement) and is empty — asserted AFTER the publish tick,
    // so silence is the guard's doing and not the clock's.
    expect(screen.getByTestId('attachment-sweep-announcement')).toHaveAttribute('role', 'status');
    await flushAnnouncerPublish();
    expect(screen.getByTestId('attachment-sweep-announcement').textContent).toBe('');
    // …and none of the conditional strips is a live region of its own.
    expect(lastRun).not.toHaveAttribute('role');
    expect(screen.getByTestId('attachment-storage-card')).toHaveAttribute('aria-busy', 'false');
  });

  it('does not announce a days-old failed run just because the tab was opened', async () => {
    mockApi({
      sweep: {
        running: false,
        lastRun: { ...COMPLETED_RUN, status: 'refused', note: 'attachments root missing or unreadable' },
      },
    });
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    const strip = await screen.findByTestId('attachment-sweep-last-run-problem');
    expect(strip).not.toHaveAttribute('role');
    await flushAnnouncerPublish();
    expect(screen.getByTestId('attachment-sweep-announcement').textContent).toBe('');
  });

  it('announces the verdict of a run it watched', async () => {
    mockApi({
      sweepAfterPost: {
        running: false,
        lastRun: {
          ...COMPLETED_RUN,
          at: new Date(Date.now() + 1000).toISOString(),
          dryRun: false,
          candidatesTotal: 2,
          deleted: { files: 2, directories: 1, bytes: 2048, imageEmbeddingRows: 0, pagesMarkedDirty: 1 },
        },
      },
    });
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByTestId('attachment-sweep-dry-run')).toBeEnabled());
    fireEvent.click(screen.getByTestId('attachment-sweep-dry-run'));

    await waitFor(() =>
      expect(screen.getByTestId('attachment-sweep-announcement').textContent).toMatch(
        /Sweep finished — deleted 2 files and 1 directory/,
      ),
    );
  });

  /**
   * Fixer r1. An `aria-live` region whose text does not CHANGE is not
   * re-announced, and React bails out of a `useState` write equal to the
   * current value — so pressing Dry run twice on a store that did not change
   * announced the first run and then completed in total silence, on the one
   * surface built for the user this announcer exists for.
   *
   * The assertion is on DOM MUTATIONS, not on the final text: the sentence is
   * identical by construction, so reading `textContent` after the second run
   * passes with the bug in place.
   */
  it('re-announces a second run whose verdict reads exactly the same', async () => {
    const first = { ...COMPLETED_RUN, at: new Date(Date.now() + 1000).toISOString(), candidatesTotal: 3 };
    const second = { ...COMPLETED_RUN, at: new Date(Date.now() + 2000).toISOString(), candidatesTotal: 3 };
    mockApi({
      sweepAfterPosts: [
        { running: false, lastRun: first },
        { running: false, lastRun: second },
      ],
    });
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByTestId('attachment-sweep-dry-run')).toBeEnabled());
    fireEvent.click(screen.getByTestId('attachment-sweep-dry-run'));

    const region = screen.getByTestId('attachment-sweep-announcement');
    await waitFor(() => expect(region.textContent).toMatch(/Dry run finished — 3 candidates/));

    // Arm the observer only now: everything before this is the FIRST run.
    let mutations = 0;
    const observer = new MutationObserver((records) => {
      mutations += records.length;
    });
    observer.observe(region, { childList: true, characterData: true, subtree: true });

    await waitFor(() => expect(screen.getByTestId('attachment-sweep-dry-run')).toBeEnabled());
    fireEvent.click(screen.getByTestId('attachment-sweep-dry-run'));

    await waitFor(() => expect(mutations).toBeGreaterThan(0));
    observer.disconnect();
    // …and it ends up saying the same true thing, not empty.
    await waitFor(() => expect(region.textContent).toMatch(/Dry run finished — 3 candidates/));
  });

  /**
   * Fixer r1. "The actions stay live on a failed READ" is stated in the
   * card's own header comment and was pinned by nothing — adding
   * `|| statsError || sweepError` to `actionsDisabled` left every cell green,
   * so the one remedy for an unreadable record could grey itself out on
   * exactly the failure it exists to fix.
   */
  it('keeps both actions live when the record cannot be read', async () => {
    mockApi({ stats: 'error', sweep: 'error' });
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    await screen.findByTestId('attachment-storage-error');
    await waitFor(() => expect(screen.getByTestId('attachment-sweep-dry-run')).toBeEnabled());
    expect(screen.getByTestId('attachment-sweep-delete')).toBeEnabled();
  });

  it('marks the card busy while a sweep is running', async () => {
    mockApi({ stats: { ...STATS, running: true }, sweep: { ...SWEEP, running: true } });
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    await screen.findByTestId('attachment-sweep-running');
    expect(screen.getByTestId('attachment-storage-card')).toHaveAttribute('aria-busy', 'true');
  });

  // Review r2: this is the card's only keyboard-reachable disclosure and it
  // opens the destructive review list, yet it fell back to the UA outline
  // while both sibling settings disclosures (ChatVisionCapability,
  // ImageEmbeddingCapability) ring theirs with the Steel token.
  it('the candidate disclosure carries the app’s focus ring, not the UA default', async () => {
    mockApi({
      sweep: {
        running: false,
        lastRun: {
          ...COMPLETED_RUN,
          candidatesTotal: 1,
          candidateSample: [
            { store: 'confluence', key: '1', filename: 'a.png', bytes: 1, reason: 'orphan_file' },
          ],
        },
      },
    });
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    const disclosure = await screen.findByTestId('attachment-sweep-candidates');
    const summary = disclosure.querySelector('summary')!;
    for (const cls of ['focus-visible:outline-none', 'focus-visible:ring-2', 'focus-visible:ring-ring']) {
      expect(summary.className.split(/\s+/), `summary must carry ${cls}`).toContain(cls);
    }
  });

  /**
   * Review r2. The post-kick warm-up had no test in either direction —
   * deleting the `kickedAt` line from `pollWhile` left all 35 cells green —
   * and it is the only thing that fetches the finished record on the path its
   * comment documents: with Redis unreachable `isWorkerLocked` cannot report a
   * lock, so `running` never flips and the interval would never arm at all.
   *
   * Both halves are asserted: it polls inside the window, and it stops after
   * it. A warm-up that never expires is its own defect (a card polling two
   * admin routes forever against a 20/min limit).
   */
  it('polls after a kick even when the payload never reports a lock, and stops after the warm-up', async () => {
    vi.useFakeTimers();
    try {
      mockApi({});
      render(<AttachmentStorageCard />, { wrapper: createWrapper() });

      await vi.waitFor(() => expect(screen.getByTestId('attachment-sweep-dry-run')).toBeEnabled());
      fireEvent.click(screen.getByTestId('attachment-sweep-dry-run'));
      // Settle the POST and the two invalidations it fires.
      await vi.advanceTimersByTimeAsync(50);

      const afterKick = vi.mocked(globalThis.fetch).mock.calls.length;
      // Two GETs per poll tick, and `running` is false on every one of them.
      await vi.advanceTimersByTimeAsync(3 * POLL_MS_UNDER_TEST);
      const duringWarmup = vi.mocked(globalThis.fetch).mock.calls.length;
      expect(duringWarmup, 'the card must keep polling inside the warm-up').toBeGreaterThan(
        afterKick,
      );

      // Past the 20s window with `running` still false: the interval stands down.
      await vi.advanceTimersByTimeAsync(KICK_WARMUP_MS_UNDER_TEST);
      const settled = vi.mocked(globalThis.fetch).mock.calls.length;
      await vi.advanceTimersByTimeAsync(3 * POLL_MS_UNDER_TEST);
      expect(vi.mocked(globalThis.fetch).mock.calls.length, 'the warm-up must expire').toBe(settled);
    } finally {
      vi.useRealTimers();
    }
  });

  it('disables both actions while a sweep is running', async () => {
    mockApi({
      stats: { ...STATS, running: true },
      sweep: { ...SWEEP, running: true },
    });
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    await screen.findByTestId('attachment-sweep-running');
    expect(screen.getByTestId('attachment-sweep-dry-run')).toBeDisabled();
    expect(screen.getByTestId('attachment-sweep-delete')).toBeDisabled();
  });
});
