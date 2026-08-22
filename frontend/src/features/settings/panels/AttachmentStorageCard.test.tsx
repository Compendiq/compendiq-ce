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

  // Review r2: Tailwind preflight forces `svg { display: block }`, so a bare
  // lucide icon inside a button with no flex layout stacks on its own line
  // above the label. `nm-action-destructive` supplies colour only — this
  // callsite must supply the box (the ProviderListSection precedent), or the
  // two buttons in the row render with different layouts. jsdom cannot see
  // the layout, so the classes themselves are pinned.
  it('the Delete orphans button carries the flex layout, gap and radius its treatment needs', async () => {
    mockApi({});
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    await screen.findByTestId('attachment-storage-counters');
    const del = screen.getByTestId('attachment-sweep-delete');
    expect(del.className).toContain('nm-action-destructive');
    for (const cls of ['inline-flex', 'items-center', 'gap-1.5', 'rounded-md']) {
      expect(del.className.split(/\s+/), `Delete orphans must carry ${cls}`).toContain(cls);
    }
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
