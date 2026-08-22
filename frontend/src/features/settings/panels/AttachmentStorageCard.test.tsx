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
  });

  it('a completed last run renders neutrally — no amber at rest', async () => {
    mockApi({});
    render(<AttachmentStorageCard />, { wrapper: createWrapper() });

    await screen.findByTestId('attachment-sweep-last-run');
    expect(screen.queryByTestId('attachment-sweep-last-run-problem')).not.toBeInTheDocument();
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
