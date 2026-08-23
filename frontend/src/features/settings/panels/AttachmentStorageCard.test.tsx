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
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AttachmentStorageStats, AttachmentSweepRun, AttachmentSweepStatus } from '@compendiq/contracts';
import { AttachmentStorageCard } from './AttachmentStorageCard';
import { toast } from 'sonner';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

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
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/admin/attachments/stats')) {
      return plan.stats === 'error' ? json({ message: 'boom' }, 500) : json(plan.stats ?? STATS);
    }
    if (url.endsWith('/admin/attachments/sweep') && (init?.method ?? 'GET') === 'GET') {
      return plan.sweep === 'error' ? json({ message: 'boom' }, 500) : json(plan.sweep ?? SWEEP);
    }
    if (url.endsWith('/admin/attachments/sweep') && init?.method === 'POST') {
      postedBodies.push(JSON.parse(String(init?.body)));
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

  it('an already-running trigger reports neutrally, not as success', async () => {
    mockApi({ post: { started: false, alreadyRunning: true } });
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    await screen.findByTestId('attachment-storage-counters');
    fireEvent.click(screen.getByTestId('attachment-sweep-dry-run'));

    await waitFor(() => expect(toast.message).toHaveBeenCalledWith(expect.stringMatching(/already running/i)));
    expect(toast.success).not.toHaveBeenCalled();
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
    expect(strip.getAttribute('role')).toBe('status');
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
  it('reports pageless directories that hold sub-folders, and nothing when there are none', async () => {
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
    expect(note.textContent).toMatch(/1 pageless directory holds sub-folders/i);
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
    expect(screen.getByTestId('attachment-sweep-candidate-list').textContent).toContain(
      'local/77/gone.png',
    );
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
    expect(note).toHaveAttribute('role', 'status');
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
   * or what it removed. The two existing live regions are both amber strips
   * that render only for a run that did not complete or that stood a store
   * down; the ordinary success path had none.
   *
   * `role="status"` (polite), not an alert: a completed run is a verdict worth
   * hearing, not worth interrupting for — the refusal-strip recipe.
   */
  it('announces a completed run politely, and marks the card busy while one is in flight', async () => {
    mockApi({});
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    const lastRun = await screen.findByTestId('attachment-sweep-last-run');
    expect(lastRun).toHaveAttribute('role', 'status');
    expect(screen.getByTestId('attachment-storage-card')).toHaveAttribute('aria-busy', 'false');
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
