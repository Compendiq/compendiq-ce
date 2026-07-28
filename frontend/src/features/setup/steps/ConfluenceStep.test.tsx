import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LazyMotion, domMax } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UpdateSettingsSchema } from '@compendiq/contracts';
import { ConfluenceStep } from './ConfluenceStep';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function renderStep(onNext = vi.fn(), onBack = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <LazyMotion features={domMax}>
        <ConfluenceStep onNext={onNext} onBack={onBack} />
      </LazyMotion>
    </QueryClientProvider>,
  );
  return { onNext, onBack, ...utils };
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const SPACES = [
  { key: 'ENG', name: 'Engineering Handbook', type: 'global' },
  { key: 'PROD', name: 'Product', type: 'global' },
];

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : (input as Request).url;
}

function methodOf(init: RequestInit | undefined): string {
  return init?.method ?? 'GET';
}

/**
 * Network-boundary mock for the whole Confluence step: the connection probe,
 * the space picker's `GET /spaces/available`, and the fire-and-forget sync
 * (`POST /sync` + the `GET /sync/status` poll). `syncFails` exercises #1127's
 * retry path. The sync status is stateful so a dispatched sync actually flips
 * the poll to 'syncing', the way the backend does.
 */
function mockApi(
  opts: { probeSucceeds?: boolean; syncFails?: boolean; syncFinishesImmediately?: boolean } = {},
) {
  const { probeSucceeds = true, syncFails = false, syncFinishesImmediately = false } = opts;
  const state = {
    status: 'idle' as 'idle' | 'syncing',
    progress: undefined as { current: number; total: number; space?: string } | undefined,
  };

  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = urlOf(input);
    const method = methodOf(init as RequestInit | undefined);

    // Ordered longest-prefix-first: `/settings/test-confluence` also matches
    // `/settings`, and `/sync/status` also matches `/sync`.
    if (url.includes('/settings/test-confluence') && method === 'POST') {
      return jsonResponse(
        probeSucceeds
          ? { success: true, message: 'Connection successful' }
          : { success: false, message: 'Connection failed' },
      );
    }
    if (url.includes('/spaces/available')) return jsonResponse(SPACES);
    if (url.includes('/sync/status')) {
      return jsonResponse({ userId: 'u1', status: state.status, progress: state.progress });
    }
    if (url.includes('/sync') && method === 'POST') {
      if (syncFails) return jsonResponse({ message: 'Sync already in progress' }, 409);
      if (!syncFinishesImmediately) {
        state.status = 'syncing';
        state.progress = { current: 12, total: 340, space: 'ENG' };
      }
      return jsonResponse({ message: 'Sync started' });
    }
    if (url.includes('/spaces')) {
      return jsonResponse([
        { key: 'ENG', name: 'Engineering Handbook', pageCount: 124, lastSynced: null },
        { key: 'PROD', name: 'Product', pageCount: 38, lastSynced: null },
      ]);
    }
    return jsonResponse([]);
  });

  return { spy, state };
}

/** Fill the form and run a passing connection test, revealing the picker. */
async function connect() {
  fireEvent.change(screen.getByTestId('confluence-url'), {
    target: { value: 'https://confluence.example.com' },
  });
  fireEvent.change(screen.getByTestId('confluence-pat'), {
    target: { value: 'secret-pat' },
  });
  fireEvent.click(screen.getByTestId('test-confluence-btn'));
  await waitFor(() => {
    expect(screen.getByTestId('confluence-next-btn')).not.toBeDisabled();
  });
}

describe('ConfluenceStep', () => {
  beforeEach(() => {
    mockApi();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('gates Continue behind a passing connection test', () => {
    renderStep();
    // Continue is disabled until a successful test.
    expect(screen.getByTestId('confluence-next-btn')).toBeDisabled();
  });

  it('re-requires a test after the URL is edited following a passing test', async () => {
    renderStep();

    fireEvent.change(screen.getByTestId('confluence-url'), {
      target: { value: 'https://confluence.example.com' },
    });
    fireEvent.change(screen.getByTestId('confluence-pat'), {
      target: { value: 'secret-pat' },
    });

    fireEvent.click(screen.getByTestId('test-confluence-btn'));

    // Successful test enables Continue and shows the success banner.
    await waitFor(() => {
      expect(screen.getByTestId('confluence-test-result')).toHaveTextContent(
        'Connection successful',
      );
    });
    expect(screen.getByTestId('confluence-next-btn')).not.toBeDisabled();

    // Editing the URL must invalidate the prior test result so the wizard
    // cannot proceed with untested values.
    fireEvent.change(screen.getByTestId('confluence-url'), {
      target: { value: 'https://other.example.com' },
    });

    expect(screen.getByTestId('confluence-next-btn')).toBeDisabled();
    expect(screen.queryByTestId('confluence-test-result')).not.toBeInTheDocument();
  });

  it('persists the URL under the confluenceUrl key the backend expects (#875)', async () => {
    const { spy } = mockApi();
    renderStep();

    await connect();

    // Find the PUT /settings call and inspect its payload.
    const putCall = spy.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PUT',
    );
    expect(putCall).toBeDefined();
    const body = JSON.parse((putCall![1] as RequestInit).body as string);

    // The URL must go under `confluenceUrl` (a non-strict UpdateSettingsSchema
    // silently strips the old `confluenceBaseUrl` key, leaving confluence_url NULL).
    expect(body.confluenceBaseUrl).toBeUndefined();
    expect(body.confluenceUrl).toBe('https://confluence.example.com');

    // The whole payload must validate against the contract the backend parses with.
    const parsed = UpdateSettingsSchema.parse(body);
    expect(parsed.confluenceUrl).toBe('https://confluence.example.com');
  });

  it('keeps Continue disabled when the connection probe reports failure (#950)', async () => {
    const { spy } = mockApi({ probeSucceeds: false });
    renderStep();

    fireEvent.change(screen.getByTestId('confluence-url'), {
      target: { value: 'https://confluence.example.com' },
    });
    fireEvent.change(screen.getByTestId('confluence-pat'), {
      target: { value: 'bad-pat' },
    });

    fireEvent.click(screen.getByTestId('test-confluence-btn'));

    // The failure must surface and the wizard must NOT let the user proceed.
    await waitFor(() => {
      expect(screen.getByTestId('confluence-test-result')).toHaveTextContent(
        'Connection failed',
      );
    });
    expect(screen.getByTestId('confluence-next-btn')).toBeDisabled();

    // Prove the wizard hit the real probe endpoint with the entered credentials.
    const probeCall = spy.mock.calls.find(
      ([reqUrl, init]) =>
        urlOf(reqUrl!).includes('/settings/test-confluence') &&
        (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(probeCall).toBeDefined();
    const probeBody = JSON.parse((probeCall![1] as RequestInit).body as string);
    expect(probeBody.url).toBe('https://confluence.example.com');
    expect(probeBody.pat).toBe('bad-pat');
  });

  it('re-requires a test after the PAT is edited following a passing test', async () => {
    renderStep();

    fireEvent.change(screen.getByTestId('confluence-url'), {
      target: { value: 'https://confluence.example.com' },
    });
    fireEvent.change(screen.getByTestId('confluence-pat'), {
      target: { value: 'secret-pat' },
    });

    fireEvent.click(screen.getByTestId('test-confluence-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('confluence-next-btn')).not.toBeDisabled();
    });

    fireEvent.change(screen.getByTestId('confluence-pat'), {
      target: { value: 'different-pat' },
    });

    expect(screen.getByTestId('confluence-next-btn')).toBeDisabled();
  });

  // ── #1127: in-wizard space selection + sync ───────────────────────────────

  describe('space picker (#1127)', () => {
    it('stays hidden until the connection test passes, then reveals the spaces', async () => {
      renderStep();

      expect(screen.queryByTestId('space-sync-panel')).not.toBeInTheDocument();

      await connect();

      expect(screen.getByTestId('space-sync-panel')).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.getByTestId('space-option-ENG')).toBeInTheDocument();
      });
      expect(screen.getByText('Engineering Handbook')).toBeInTheDocument();
      expect(screen.getByTestId('space-option-PROD')).toBeInTheDocument();
    });

    it('hides the picker again when the credentials are edited after a passing test', async () => {
      renderStep();
      await connect();
      await waitFor(() => {
        expect(screen.getByTestId('space-option-ENG')).toBeInTheDocument();
      });

      fireEvent.change(screen.getByTestId('confluence-pat'), {
        target: { value: 'different-pat' },
      });

      expect(screen.queryByTestId('space-sync-panel')).not.toBeInTheDocument();
    });

    it('multi-selects spaces and dispatches one sync for the whole selection', async () => {
      const { spy } = mockApi();
      renderStep();
      await connect();
      await waitFor(() => {
        expect(screen.getByTestId('space-option-ENG')).toBeInTheDocument();
      });

      // Nothing selected yet — the sync trigger has nothing to do.
      expect(screen.getByTestId('start-sync-btn')).toBeDisabled();

      fireEvent.click(screen.getByTestId('space-option-ENG'));
      expect(screen.getByTestId('space-option-ENG')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByTestId('start-sync-btn')).toHaveTextContent('Sync 1 space');

      fireEvent.click(screen.getByTestId('space-option-PROD'));
      expect(screen.getByTestId('start-sync-btn')).toHaveTextContent('Sync 2 spaces');

      // Deselect and reselect — the toggle is symmetric.
      fireEvent.click(screen.getByTestId('space-option-PROD'));
      expect(screen.getByTestId('space-option-PROD')).toHaveAttribute('aria-pressed', 'false');
      fireEvent.click(screen.getByTestId('space-option-PROD'));

      fireEvent.click(screen.getByTestId('start-sync-btn'));

      await waitFor(() => {
        const syncCall = spy.mock.calls.find(
          ([reqUrl, init]) =>
            urlOf(reqUrl!).endsWith('/api/sync') &&
            (init as RequestInit | undefined)?.method === 'POST',
        );
        expect(syncCall).toBeDefined();
      });

      // The selection must be persisted before the sync — `syncUser` reads the
      // spaces to sync from the RBAC assignments PUT /settings writes.
      const selectionCall = spy.mock.calls.find(
        ([reqUrl, init]) =>
          urlOf(reqUrl!).endsWith('/api/settings') &&
          (init as RequestInit | undefined)?.method === 'PUT' &&
          typeof (init as RequestInit | undefined)?.body === 'string' &&
          ((init as RequestInit).body as string).includes('selectedSpaces'),
      );
      expect(selectionCall).toBeDefined();
      const selectionBody = JSON.parse((selectionCall![1] as RequestInit).body as string);
      expect(selectionBody.selectedSpaces).toEqual(['ENG', 'PROD']);
      // And it must satisfy the contract the backend parses with.
      expect(UpdateSettingsSchema.parse(selectionBody).selectedSpaces).toEqual(['ENG', 'PROD']);
    });

    it('renders inline progress with the space name and page counts while syncing', async () => {
      renderStep();
      await connect();
      await waitFor(() => {
        expect(screen.getByTestId('space-option-ENG')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('space-option-ENG'));
      fireEvent.click(screen.getByTestId('start-sync-btn'));

      await waitFor(() => {
        expect(screen.getByTestId('sync-progress')).toBeInTheDocument();
      });
      // The status reports a space KEY; the picker resolves it to the name.
      expect(screen.getByTestId('sync-progress')).toHaveTextContent('Syncing Engineering Handbook');
      expect(screen.getByTestId('sync-progress-count')).toHaveTextContent('12 of 340 pages');
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '4');
    });

    it('reports what landed once the run settles', async () => {
      // Same branch the 2s status poll reaches when the run finishes; a small
      // space can genuinely be idle again by the first read after dispatch.
      mockApi({ syncFinishesImmediately: true });
      renderStep();
      await connect();
      await waitFor(() => {
        expect(screen.getByTestId('space-option-ENG')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('space-option-ENG'));
      fireEvent.click(screen.getByTestId('start-sync-btn'));

      await waitFor(() => {
        expect(screen.getByTestId('sync-complete')).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.getByTestId('synced-space-ENG')).toHaveTextContent('124 pages');
      });
      // Only the spaces this admin actually picked are summarised.
      expect(screen.getByTestId('sync-complete')).toHaveTextContent('124 pages indexed across 1 space.');
      expect(screen.queryByTestId('synced-space-PROD')).not.toBeInTheDocument();
      // The trigger stays available for a re-run.
      expect(screen.getByTestId('start-sync-btn')).toHaveTextContent('Sync again');
    });

    it('never blocks Continue on sync state', async () => {
      renderStep();
      await connect();
      await waitFor(() => {
        expect(screen.getByTestId('space-option-ENG')).toBeInTheDocument();
      });

      // Enabled before any sync is dispatched...
      expect(screen.getByTestId('confluence-next-btn')).not.toBeDisabled();

      fireEvent.click(screen.getByTestId('space-option-ENG'));
      fireEvent.click(screen.getByTestId('start-sync-btn'));

      await waitFor(() => {
        expect(screen.getByTestId('sync-progress')).toBeInTheDocument();
      });

      // ...and still enabled mid-sync. Sync is fire-and-forget.
      expect(screen.getByTestId('confluence-next-btn')).not.toBeDisabled();
    });

    it('leaves an in-flight sync running when the step unmounts', async () => {
      const { spy } = mockApi();
      const { unmount, onNext } = renderStep();
      await connect();
      await waitFor(() => {
        expect(screen.getByTestId('space-option-ENG')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('space-option-ENG'));
      fireEvent.click(screen.getByTestId('start-sync-btn'));
      await waitFor(() => {
        expect(screen.getByTestId('sync-progress')).toBeInTheDocument();
      });

      // Continuing past the step tears the component down mid-sync.
      fireEvent.click(screen.getByTestId('confluence-next-btn'));
      expect(onNext).toHaveBeenCalled();

      const callsBefore = spy.mock.calls.length;
      unmount();

      // The sync request carried no AbortSignal, so unmounting cannot abort it,
      // and nothing issues a cancel on the way out.
      const syncCall = spy.mock.calls.find(
        ([reqUrl, init]) =>
          urlOf(reqUrl!).endsWith('/api/sync') &&
          (init as RequestInit | undefined)?.method === 'POST',
      );
      expect((syncCall![1] as RequestInit).signal ?? null).toBeNull();
      expect(
        spy.mock.calls
          .slice(callsBefore)
          .filter(([reqUrl]) => urlOf(reqUrl!).includes('/sync')),
      ).toHaveLength(0);
    });

    it('surfaces a retry affordance when POST /api/sync fails, without blocking Continue', async () => {
      const { spy } = mockApi({ syncFails: true });
      renderStep();
      await connect();
      await waitFor(() => {
        expect(screen.getByTestId('space-option-ENG')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('space-option-ENG'));
      fireEvent.click(screen.getByTestId('start-sync-btn'));

      await waitFor(() => {
        expect(screen.getByTestId('sync-error')).toBeInTheDocument();
      });
      // The error names the problem and the recovery.
      expect(screen.getByTestId('sync-error')).toHaveTextContent('Sync already in progress');
      expect(screen.getByTestId('sync-error')).toHaveTextContent('Settings → Spaces');
      expect(screen.queryByTestId('sync-progress')).not.toBeInTheDocument();

      // A failed sync must never trap the admin in the wizard.
      expect(screen.getByTestId('confluence-next-btn')).not.toBeDisabled();

      const before = spy.mock.calls.filter(
        ([reqUrl, init]) =>
          urlOf(reqUrl!).endsWith('/api/sync') &&
          (init as RequestInit | undefined)?.method === 'POST',
      ).length;

      fireEvent.click(screen.getByTestId('retry-sync-btn'));

      await waitFor(() => {
        const after = spy.mock.calls.filter(
          ([reqUrl, init]) =>
            urlOf(reqUrl!).endsWith('/api/sync') &&
            (init as RequestInit | undefined)?.method === 'POST',
        ).length;
        expect(after).toBe(before + 1);
      });
    });

    it('teaches the empty case when the PAT can see no spaces', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = urlOf(input);
        if (
          url.includes('/settings/test-confluence') &&
          methodOf(init as RequestInit | undefined) === 'POST'
        ) {
          return jsonResponse({ success: true, message: 'Connection successful' });
        }
        if (url.includes('/sync/status')) return jsonResponse({ userId: 'u1', status: 'idle' });
        return jsonResponse([]);
      });

      renderStep();
      await connect();

      await waitFor(() => {
        expect(screen.getByTestId('spaces-empty')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('space-picker')).not.toBeInTheDocument();
    });

    it('keeps "Skip for Now" working verbatim once the picker is showing', async () => {
      const { onNext } = renderStep();
      await connect();
      await waitFor(() => {
        expect(screen.getByTestId('space-option-ENG')).toBeInTheDocument();
      });

      const skip = screen.getByTestId('skip-confluence-btn');
      expect(skip).toHaveTextContent('Skip for Now');
      expect(skip).not.toBeDisabled();

      fireEvent.click(skip);
      expect(onNext).toHaveBeenCalledTimes(1);
    });
  });
});
