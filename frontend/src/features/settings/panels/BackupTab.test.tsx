import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BackupTab } from './BackupTab';
import type { BackupStatusResponse } from '@compendiq/contracts';

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

function mockFetch(status: BackupStatusResponse = STATUS) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = init?.method ?? 'GET';
    if (url.includes('/admin/backup/export') && method === 'POST') {
      return new Response(new Blob(['ENC']), {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment; filename="compendiq-backup-test.enc"',
        },
      });
    }
    if (url.includes('/admin/backup') && method === 'PUT') {
      return new Response(JSON.stringify({ s3: status.s3, schedule: status.schedule }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/admin/backup')) {
      return new Response(JSON.stringify(status), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('Not found', { status: 404 });
  });
}

function wrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('BackupTab (#1420)', () => {
  beforeEach(() => {
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:backup'),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders the download control', async () => {
    mockFetch();
    render(<BackupTab />, { wrapper: wrapper() });
    expect(await screen.findByTestId('backup-download-btn')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Download backup' })).toBeInTheDocument();
  });

  it('POSTs /admin/backup/export when Download is clicked', async () => {
    const spy = mockFetch();
    render(<BackupTab />, { wrapper: wrapper() });
    fireEvent.click(await screen.findByTestId('backup-download-btn'));
    await waitFor(() => {
      expect(
        spy.mock.calls.some(
          ([target, init]) =>
            String(target).includes('/admin/backup/export') &&
            (init as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true);
    });
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
          String(target).includes('/admin/backup') &&
          (init as RequestInit | undefined)?.method === 'PUT',
      );
      expect(put).toBeDefined();
      const body = JSON.parse((put![1] as RequestInit).body as string);
      expect(body.s3Endpoint).toBe('https://s3.amazonaws.com');
    });
  });
});
