import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BulkActionBar } from './BulkActionBar';

const apiFetchMock = vi.fn();
vi.mock('../../shared/lib/api', async () =>
  (await import('../../test-utils')).apiModuleMock(() => apiFetchMock));

// Declared via vi.hoisted so the factory below can reference it — vi.mock is
// hoisted above ordinary top-level consts.
const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: toastMock }));

function createWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  apiFetchMock.mockResolvedValue({ succeeded: 3 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BulkActionBar', () => {
  it('renders nothing with an empty selection', () => {
    const { container } = render(
      <BulkActionBar selectedIds={[]} confluenceCount={0} onClear={vi.fn()} />,
      { wrapper: createWrapper() },
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('reports the selection count with correct pluralisation', () => {
    const { rerender } = render(
      <BulkActionBar selectedIds={['1']} confluenceCount={0} onClear={vi.fn()} />,
      { wrapper: createWrapper() },
    );
    expect(screen.getByTestId('bulk-selection-count')).toHaveTextContent('1 page selected');

    rerender(<BulkActionBar selectedIds={['1', '2']} confluenceCount={0} onClear={vi.fn()} />);
    expect(screen.getByTestId('bulk-selection-count')).toHaveTextContent('2 pages selected');
  });

  it('posts the selected ids to the embed endpoint', async () => {
    render(
      <BulkActionBar selectedIds={['1', '2', '3']} confluenceCount={0} onClear={vi.fn()} />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByTestId('bulk-embed-btn'));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith('/pages/bulk/embed', {
        method: 'POST',
        body: JSON.stringify({ ids: ['1', '2', '3'] }),
      });
    });
  });

  it('posts to the quality endpoint', async () => {
    render(
      <BulkActionBar selectedIds={['7']} confluenceCount={0} onClear={vi.fn()} />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByTestId('bulk-quality-btn'));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith('/pages/bulk/quality', expect.anything());
    });
  });

  it('hides re-sync when nothing selected came from Confluence', () => {
    // A permanently greyed control on a local-only knowledge base is noise.
    render(
      <BulkActionBar selectedIds={['1']} confluenceCount={0} onClear={vi.fn()} />,
      { wrapper: createWrapper() },
    );
    expect(screen.queryByTestId('bulk-sync-btn')).not.toBeInTheDocument();
  });

  it('shows re-sync and qualifies it when the selection is mixed', () => {
    render(
      <BulkActionBar selectedIds={['1', '2', '3']} confluenceCount={2} onClear={vi.fn()} />,
      { wrapper: createWrapper() },
    );
    expect(screen.getByTestId('bulk-sync-btn')).toHaveTextContent('Re-sync (2)');
  });

  it('does not qualify re-sync when every selected page is from Confluence', () => {
    render(
      <BulkActionBar selectedIds={['1', '2']} confluenceCount={2} onClear={vi.fn()} />,
      { wrapper: createWrapper() },
    );
    expect(screen.getByTestId('bulk-sync-btn')).toHaveTextContent('Re-sync');
    expect(screen.getByTestId('bulk-sync-btn')).not.toHaveTextContent('(2)');
  });

  it('confirms before deleting, naming the reversibility window', async () => {
    render(
      <BulkActionBar selectedIds={['1', '2']} confluenceCount={0} onClear={vi.fn()} />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByTestId('bulk-delete-btn'));

    expect(await screen.findByText('Move 2 pages to trash?')).toBeInTheDocument();
    expect(screen.getByText(/restored from Trash for 30 days/)).toBeInTheDocument();
    // Nothing sent until the user confirms.
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('deletes only after confirmation', async () => {
    render(
      <BulkActionBar selectedIds={['1', '2']} confluenceCount={0} onClear={vi.fn()} />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByTestId('bulk-delete-btn'));
    fireEvent.click(await screen.findByRole('button', { name: 'Move 2 pages to trash' }));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith('/pages/bulk/delete', {
        method: 'POST',
        body: JSON.stringify({ ids: ['1', '2'] }),
      });
    });
  });

  it('sends nothing when the delete dialog is cancelled', async () => {
    render(
      <BulkActionBar selectedIds={['1']} confluenceCount={0} onClear={vi.fn()} />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByTestId('bulk-delete-btn'));
    fireEvent.click(await screen.findByRole('button', { name: /cancel/i }));

    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('clears the selection once an action succeeds', async () => {
    const onClear = vi.fn();
    render(
      <BulkActionBar selectedIds={['1']} confluenceCount={0} onClear={onClear} />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByTestId('bulk-embed-btn'));

    await waitFor(() => expect(onClear).toHaveBeenCalled());
  });

  it('warns when the server reports part of the selection was stale', async () => {
    apiFetchMock.mockResolvedValue({ succeeded: 1, notFoundIds: ['9'] });

    render(
      <BulkActionBar selectedIds={['1', '9']} confluenceCount={0} onClear={vi.fn()} />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByTestId('bulk-embed-btn'));

    await waitFor(() => {
      expect(toastMock.warning).toHaveBeenCalledWith(expect.stringContaining('1 page could not be found'));
    });
  });

  it('surfaces a failed bulk request instead of reporting success', async () => {
    apiFetchMock.mockRejectedValue(new Error('Embedding already in progress'));

    render(
      <BulkActionBar selectedIds={['1']} confluenceCount={0} onClear={vi.fn()} />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByTestId('bulk-embed-btn'));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith('Embedding already in progress');
    });
    expect(toastMock.success).not.toHaveBeenCalled();
  });
});
