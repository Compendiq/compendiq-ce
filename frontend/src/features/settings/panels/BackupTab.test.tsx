import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BackupStatusResponse } from '@compendiq/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import backupTabSource from './BackupTab.tsx?raw';
import { BackupTab } from './BackupTab';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const STATUS: BackupStatusResponse = {
  hasMasterKey: true,
  lockHeld: false,
  s3: {
    enabled: false,
    endpoint: '',
    bucket: '',
    region: 'us-east-1',
    accessKey: '',
    secretKey: '',
    prefix: 'compendiq-backups/',
    forcePathStyle: true,
    hasAccessKey: false,
    hasSecretKey: false,
  },
  schedule: {
    enabled: false,
    intervalHours: 24,
    retentionCount: 7,
    retentionDays: 30,
    lastRunAt: null,
  },
  history: [],
};

const READY_STATUS: BackupStatusResponse = {
  ...STATUS,
  s3: {
    ...STATUS.s3,
    enabled: true,
    endpoint: 'https://s3.example.com',
    bucket: 'compendiq-backups',
    accessKey: '••••••••',
    secretKey: '••••••••',
    hasAccessKey: true,
    hasSecretKey: true,
  },
};
const DOWNLOAD_URL = `/api/backup/download/${'a'.repeat(64)}`;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function requestUrl(input: RequestInfo | URL) {
  return typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
}

function mockFetch(status: BackupStatusResponse = STATUS) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/admin/backup/export-ticket') && method === 'POST') {
      return jsonResponse({ downloadUrl: DOWNLOAD_URL });
    }
    if (url.includes('/admin/backup') && method === 'PUT') {
      return jsonResponse({ s3: status.s3, schedule: status.schedule });
    }
    if (url.includes('/admin/backup')) return jsonResponse(status);
    return new Response('Not found', { status: 404 });
  });
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function wrapper(queryClient = createQueryClient()) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function withStatus(
  overrides: Partial<BackupStatusResponse> & { s3?: Partial<BackupStatusResponse['s3']> },
): BackupStatusResponse {
  return {
    ...READY_STATUS,
    ...overrides,
    s3: { ...READY_STATUS.s3, ...overrides.s3 },
  };
}

const RUN_DISABLED_CASES: Array<[string, BackupStatusResponse, string]> = [
  [
    'the master key is absent',
    withStatus({ hasMasterKey: false }),
    'Configure BACKUP_ENCRYPTION_KEY before running an S3 backup.',
  ],
  [
    'S3 is disabled',
    withStatus({ s3: { enabled: false } }),
    'Enable and save S3 uploads before running a backup.',
  ],
  [
    'the endpoint is missing',
    withStatus({ s3: { endpoint: '' } }),
    'Save an S3 endpoint before running a backup.',
  ],
  [
    'the bucket is missing',
    withStatus({ s3: { bucket: '' } }),
    'Save an S3 bucket before running a backup.',
  ],
  [
    'credentials are missing',
    withStatus({
      s3: {
        accessKey: '',
        secretKey: '',
        hasAccessKey: false,
        hasSecretKey: false,
      },
    }),
    'Save S3 access and secret keys before running a backup.',
  ],
];

describe('BackupTab (#1420)', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders the download control', async () => {
    mockFetch();
    render(<BackupTab />, { wrapper: wrapper() });
    expect(await screen.findByTestId('backup-download-btn')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Download backup' })).toBeInTheDocument();
  });

  it('creates an export ticket with the passphrase only in its body and navigates to the returned URL', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    const spy = mockFetch();
    render(<BackupTab />, { wrapper: wrapper() });

    const passphrase = 'correct horse battery staple';
    const input = await screen.findByTestId('backup-passphrase');
    fireEvent.change(input, { target: { value: passphrase } });
    fireEvent.click(screen.getByTestId('backup-download-btn'));

    await waitFor(() => expect(assign).toHaveBeenCalledOnce());
    const ticketRequest = spy.mock.calls.find(
      ([target, init]) =>
        requestUrl(target).endsWith('/admin/backup/export-ticket') &&
        (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(ticketRequest).toBeDefined();
    expect(JSON.parse((ticketRequest![1] as RequestInit).body as string)).toEqual({ passphrase });
    expect(spy.mock.calls.every(([target]) => !requestUrl(target).includes(passphrase))).toBe(true);
    expect(assign).toHaveBeenCalledWith(DOWNLOAD_URL);
    expect(input).toHaveValue('');
  });

  it('does not buffer backup bytes in browser memory', () => {
    expect(backupTabSource).not.toMatch(/res\.blob|createObjectURL|\bBlob\b/);
  });

  it('shows a retryable alert when the initial status request fails', async () => {
    let gets = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (!requestUrl(input).includes('/admin/backup')) return new Response('Not found', { status: 404 });
      gets += 1;
      return gets === 1
        ? jsonResponse({ message: 'Database unavailable' }, 500)
        : jsonResponse(STATUS);
    });
    render(<BackupTab />, { wrapper: wrapper() });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Backup settings could not be loaded. Retry to restore the controls.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByTestId('backup-download-btn')).toBeInTheDocument();
    expect(gets).toBe(2);
  });

  it('keeps cached controls visible when a background status refresh fails', async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(['admin', 'backup'], READY_STATUS);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ message: 'Backup service unavailable' }, 500),
    );

    render(<BackupTab />, { wrapper: wrapper(queryClient) });

    expect(await screen.findByTestId('backup-s3-endpoint')).toHaveValue('https://s3.example.com');
    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent(
      'Backup settings could not be refreshed. The displayed settings may be out of date. Retry.',
    );
    expect(screen.getByTestId('backup-test-s3-btn')).toBeInTheDocument();
  });

  it('requires changed S3 fields to be saved before testing the connection', async () => {
    mockFetch(READY_STATUS);
    render(<BackupTab />, { wrapper: wrapper() });

    const endpoint = await screen.findByTestId('backup-s3-endpoint');
    const testButton = screen.getByTestId('backup-test-s3-btn');
    expect(testButton).toBeEnabled();

    fireEvent.change(endpoint, { target: { value: 'https://new-s3.example.com' } });
    expect(testButton).toBeDisabled();
    expect(screen.getByText('Save changes before testing.')).toBeVisible();

    fireEvent.change(endpoint, { target: { value: READY_STATUS.s3.endpoint } });
    expect(testButton).toBeEnabled();
    expect(screen.queryByText('Save changes before testing.')).not.toBeInTheDocument();
  });

  it.each([
    ['access key', 'Access key', 's3AccessKey'],
    ['secret key', 'Secret key', 's3SecretKey'],
  ] as const)(
    'treats a stored %s editor as unchanged after typing and clearing it',
    async (_credential, label, formKey) => {
      const fetchSpy = mockFetch(READY_STATUS);
      render(<BackupTab />, { wrapper: wrapper() });

      const input = await screen.findByLabelText(label);
      const testButton = screen.getByTestId('backup-test-s3-btn');
      expect(input).toHaveValue('');
      expect(testButton).toBeEnabled();

      fireEvent.change(input, { target: { value: 'rotated-credential' } });
      expect(testButton).toBeDisabled();

      fireEvent.change(input, { target: { value: '' } });
      expect(testButton).toBeEnabled();
      expect(screen.queryByText('Save changes before testing.')).not.toBeInTheDocument();

      fireEvent.click(screen.getByTestId('backup-save-btn'));
      await waitFor(() => {
        const saveRequest = fetchSpy.mock.calls.find(
          ([target, init]) =>
            requestUrl(target).endsWith('/admin/backup') &&
            (init as RequestInit | undefined)?.method === 'PUT',
        );
        expect(saveRequest).toBeDefined();
        expect(JSON.parse((saveRequest![1] as RequestInit).body as string)).not.toHaveProperty(
          formKey,
        );
      });
    },
  );

  it.each(RUN_DISABLED_CASES)(
    'disables Run now with a visible reason when %s',
    async (_case, status, reason) => {
      mockFetch(status);
      render(<BackupTab />, { wrapper: wrapper() });

      expect(await screen.findByTestId('backup-run-now-btn')).toBeDisabled();
      expect(screen.getByText(reason)).toBeVisible();
    },
  );

  it('enables Run now when every saved prerequisite is present', async () => {
    mockFetch(READY_STATUS);
    render(<BackupTab />, { wrapper: wrapper() });
    expect(await screen.findByTestId('backup-run-now-btn')).toBeEnabled();
  });

  it('polls after enqueue while history is running and stops after it reaches a terminal state', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let statusGets = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = requestUrl(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/admin/backup/run') && method === 'POST') {
        return jsonResponse({ jobId: 'job-1' });
      }
      if (url.endsWith('/admin/backup') && method === 'GET') {
        statusGets += 1;
        if (statusGets === 1) return jsonResponse(READY_STATUS);
        const running = statusGets === 2;
        return jsonResponse({
          ...READY_STATUS,
          history: [
            {
              id: 'run-1',
              createdAt: '2026-08-28T10:00:00.000Z',
              finishedAt: running ? null : '2026-08-28T10:00:03.000Z',
              destination: 's3',
              status: running ? 'running' : 'success',
              bytes: running ? null : 1024,
              objectKey: running ? null : 'compendiq-backups/run-1.enc',
              error: null,
              triggeredBy: 'admin-1',
            },
          ],
        });
      }
      return new Response('Not found', { status: 404 });
    });

    render(<BackupTab />, { wrapper: wrapper() });
    fireEvent.click(await screen.findByTestId('backup-run-now-btn'));
    await waitFor(() => expect(statusGets).toBeGreaterThanOrEqual(2));
    expect(screen.getByTestId('backup-history')).toHaveTextContent('running');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    await waitFor(() => expect(screen.getByTestId('backup-history')).toHaveTextContent('success'));
    const settledGets = statusGets;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(statusGets).toBe(settledGets);
  });

  it('saves S3 endpoint via PUT', async () => {
    const spy = mockFetch();
    render(<BackupTab />, { wrapper: wrapper() });
    const endpoint = await screen.findByTestId('backup-s3-endpoint');
    fireEvent.change(endpoint, { target: { value: 'https://s3.amazonaws.com' } });
    fireEvent.click(screen.getByTestId('backup-save-btn'));
    await waitFor(() => {
      const put = spy.mock.calls.find(
        ([target, init]) =>
          requestUrl(target).includes('/admin/backup') &&
          (init as RequestInit | undefined)?.method === 'PUT',
      );
      expect(put).toBeDefined();
      const body = JSON.parse((put![1] as RequestInit).body as string);
      expect(body.s3Endpoint).toBe('https://s3.amazonaws.com');
    });
  });
});
