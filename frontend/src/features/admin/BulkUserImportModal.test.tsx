import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BulkUserImportModal } from './BulkUserImportModal';
import { useAuthStore } from '../../stores/auth-store';

// ── Sonner toast mocks ────────────────────────────────────────────────────
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

// ── Enterprise hook mock ──────────────────────────────────────────────────
let mockHasFeature: (f: string) => boolean = () => true;
vi.mock('../../shared/enterprise/use-enterprise', () => ({
  useEnterprise: () => ({
    isEnterprise: true,
    hasFeature: (f: string) => mockHasFeature(f),
    ui: null,
    license: null,
    isLoading: false,
  }),
}));

// ── Test wrapper ──────────────────────────────────────────────────────────
function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

interface MockOptions {
  previewStatus?: number;
  previewBody?: unknown;
  importStatus?: number;
  importBody?: unknown;
  capturedImport?: { current: { url: string; init?: RequestInit } | null };
}

function mockFetch(options: MockOptions = {}) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url.includes('/admin/users/bulk/preview') && method === 'POST') {
        if (options.previewStatus && options.previewStatus >= 400) {
          return new Response(
            JSON.stringify(options.previewBody ?? { error: 'preview_failed' }),
            {
              status: options.previewStatus,
              headers: { 'Content-Type': 'application/json' },
            },
          );
        }
        return new Response(
          JSON.stringify(
            options.previewBody ?? {
              rows: [
                {
                  row: {
                    username: 'alice',
                    email: 'alice@corp.com',
                    role: 'user',
                    sendInvitation: true,
                  },
                  errors: [],
                  existing: 'none',
                },
                {
                  row: null,
                  errors: ['email: Invalid email address'],
                  existing: 'none',
                },
                {
                  row: {
                    username: 'bob',
                    email: 'bob@corp.com',
                    role: 'admin',
                    sendInvitation: true,
                  },
                  errors: [],
                  existing: 'username',
                },
              ],
              summary: {
                total: 3,
                valid: 2,
                invalid: 1,
                wouldCreate: 1,
                wouldUpdate: 1,
                wouldSkip: 0,
              },
            },
          ),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }

      if (url.includes('/admin/users/bulk/import') && method === 'POST') {
        if (options.capturedImport) {
          options.capturedImport.current = { url, init };
        }
        if (options.importStatus && options.importStatus >= 400) {
          return new Response(
            JSON.stringify(options.importBody ?? { error: 'import_failed' }),
            {
              status: options.importStatus,
              headers: { 'Content-Type': 'application/json' },
            },
          );
        }
        return new Response(
          JSON.stringify(
            options.importBody ?? { created: 1, updated: 1, skipped: 0 },
          ),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }

      return new Response('Not found', { status: 404 });
    });
}

// Helper to simulate a CSV file upload via the hidden input.
function uploadCsv(text: string) {
  const file = new File([text], 'users.csv', { type: 'text/csv' });
  const input = screen.getByTestId('bulk-import-file-input') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [file] });
  fireEvent.change(input);
}

const SAMPLE_CSV =
  'username,email,role\nalice,alice@corp.com,user\nbroken,not-an-email,user\nbob,bob@corp.com,admin\n';

describe('BulkUserImportModal', () => {
  beforeEach(() => {
    useAuthStore.getState().setAuth('test-token', {
      id: '1',
      username: 'admin',
      role: 'admin',
    });
    mockHasFeature = () => true;
    toastSuccess.mockClear();
    toastError.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useAuthStore.getState().clearAuth();
  });

  it('returns null when bulk_user_operations feature is not licensed', () => {
    mockHasFeature = () => false;
    const { container } = render(
      <BulkUserImportModal open={true} onClose={() => {}} />,
      { wrapper: createWrapper() },
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('bulk-import-modal')).not.toBeInTheDocument();
  });

  it('renders the file picker when feature is licensed and modal is open', () => {
    render(<BulkUserImportModal open={true} onClose={() => {}} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByTestId('bulk-import-modal')).toBeInTheDocument();
    expect(screen.getByTestId('bulk-import-pick')).toBeInTheDocument();
  });

  it('uploads CSV and renders preview rows + summary chips', async () => {
    mockFetch();
    render(<BulkUserImportModal open={true} onClose={() => {}} />, {
      wrapper: createWrapper(),
    });

    uploadCsv(SAMPLE_CSV);

    await waitFor(() => {
      expect(screen.getByTestId('bulk-import-preview')).toBeInTheDocument();
    });

    // Summary chips
    const summary = screen.getByTestId('bulk-import-summary');
    expect(summary).toHaveTextContent('2 valid');
    expect(summary).toHaveTextContent('1 invalid');
    expect(summary).toHaveTextContent('1 will update');
    expect(summary).toHaveTextContent('1 new');

    // Three rows rendered
    expect(screen.getByTestId('bulk-import-row-0')).toBeInTheDocument();
    expect(screen.getByTestId('bulk-import-row-1')).toBeInTheDocument();
    expect(screen.getByTestId('bulk-import-row-2')).toBeInTheDocument();

    // Invalid row carries error text
    expect(screen.getByTestId('bulk-import-row-1-invalid')).toHaveTextContent(
      'Invalid email',
    );

    // Duplicate-username row marked as such
    expect(screen.getByTestId('bulk-import-row-2-dup')).toHaveTextContent(
      'existing username',
    );
  });

  it('submits import with the chosen mode and CSV body', async () => {
    const captured: { current: { url: string; init?: RequestInit } | null } = {
      current: null,
    };
    mockFetch({ capturedImport: captured });

    const onClose = vi.fn();
    render(<BulkUserImportModal open={true} onClose={onClose} />, {
      wrapper: createWrapper(),
    });

    uploadCsv(SAMPLE_CSV);
    await waitFor(() => screen.getByTestId('bulk-import-preview'));

    // Switch to upsert mode
    fireEvent.click(screen.getByTestId('bulk-import-mode-upsert'));

    fireEvent.click(screen.getByTestId('bulk-import-submit'));

    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith('Bulk import complete');
    });
    expect(onClose).toHaveBeenCalled();

    // Verify the request body
    expect(captured.current).not.toBeNull();
    expect(captured.current!.url).toContain('/admin/users/bulk/import');
    const sent = JSON.parse(captured.current!.init!.body as string);
    expect(sent.mode).toBe('upsert');
    expect(sent.csv).toBe(SAMPLE_CSV);
  });

  it('shows inline error on 400 from preview', async () => {
    mockFetch({
      previewStatus: 400,
      previewBody: { error: 'csv_too_large', message: 'CSV exceeds 50k rows' },
    });

    render(<BulkUserImportModal open={true} onClose={() => {}} />, {
      wrapper: createWrapper(),
    });

    uploadCsv(SAMPLE_CSV);

    await waitFor(() => {
      expect(screen.getByTestId('bulk-import-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('bulk-import-error')).toHaveTextContent(
      'CSV exceeds 50k rows',
    );
    // Should NOT be the missing-overlay branch
    expect(
      screen.queryByTestId('bulk-import-requires-enterprise'),
    ).not.toBeInTheDocument();
  });

  it('shows "requires Enterprise" when preview route 404s (CE-only mode)', async () => {
    mockFetch({
      previewStatus: 404,
      previewBody: { error: 'route_not_found' },
    });

    render(<BulkUserImportModal open={true} onClose={() => {}} />, {
      wrapper: createWrapper(),
    });

    uploadCsv(SAMPLE_CSV);

    await waitFor(() => {
      expect(
        screen.getByTestId('bulk-import-requires-enterprise'),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('bulk-import-requires-enterprise'),
    ).toHaveTextContent('require Enterprise');
  });
});
