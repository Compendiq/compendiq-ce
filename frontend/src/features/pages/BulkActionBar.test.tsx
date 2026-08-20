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
  // The shape every /pages/bulk/* handler actually returns.
  apiFetchMock.mockResolvedValue({ succeeded: 3, failed: 0, errors: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BulkActionBar', () => {
  it('renders no action bar with an empty selection', () => {
    render(
      <BulkActionBar selectedIds={[]} confluenceCount={0} onClear={vi.fn()} />,
      { wrapper: createWrapper() },
    );
    expect(screen.queryByTestId('bulk-action-bar')).not.toBeInTheDocument();
    expect(screen.queryByTestId('bulk-selection-count')).not.toBeInTheDocument();
  });

  it('keeps an empty live region mounted before anything is selected', () => {
    // A live region that appears at the same moment as its own text is not
    // announced — it has to already exist and then change. Mounting it with
    // the bar made the first selection, the one that reveals the bar, silent.
    const { rerender } = render(
      <BulkActionBar selectedIds={[]} confluenceCount={0} onClear={vi.fn()} />,
      { wrapper: createWrapper() },
    );

    const live = screen.getByTestId('bulk-selection-live');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toBeEmptyDOMElement();

    rerender(<BulkActionBar selectedIds={['1']} confluenceCount={0} onClear={vi.fn()} />);

    // Same node, new text — that is what gets announced.
    expect(screen.getByTestId('bulk-selection-live')).toBe(live);
    expect(live).toHaveTextContent('1 page selected');
  });

  it('does not mark the visible count as a second live region', () => {
    // Two live regions with the same text announce it twice.
    render(
      <BulkActionBar selectedIds={['1', '2']} confluenceCount={0} onClear={vi.fn()} />,
      { wrapper: createWrapper() },
    );
    expect(screen.getByTestId('bulk-selection-count')).not.toHaveAttribute('aria-live');
    expect(screen.getByTestId('bulk-selection-live')).toHaveTextContent('2 pages selected');
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

  it('uses ghost row actions, not a filled accent bar', () => {
    render(
      <BulkActionBar selectedIds={['1']} confluenceCount={1} onClear={vi.fn()} />,
      { wrapper: createWrapper() },
    );
    expect(screen.getByTestId('bulk-action-bar').className).not.toContain('border-action');
    expect(screen.getByTestId('bulk-embed-btn').className).toContain('nm-button-ghost');
    expect(screen.getByTestId('bulk-delete-btn').className).toContain('nm-action-destructive');
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

  // `{ succeeded, failed, errors }` is what all four routes actually return —
  // `errors` is the only place a partial failure is ever described. An earlier
  // revision watched for a `notFoundIds` array that no handler sends, so every
  // partial failure was reported to the user as an unqualified success.
  it('warns, with the server’s reason, when part of the selection failed', async () => {
    apiFetchMock.mockResolvedValue({
      succeeded: 1,
      failed: 1,
      errors: ['Page 9: not the owner'],
    });

    render(
      <BulkActionBar selectedIds={['1', '9']} confluenceCount={0} onClear={vi.fn()} />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByTestId('bulk-delete-btn'));
    fireEvent.click(await screen.findByRole('button', { name: 'Move 2 pages to trash' }));

    await waitFor(() => {
      expect(toastMock.warning).toHaveBeenCalledWith(
        '1 page could not be moved to trash — Page 9: not the owner',
      );
    });
    // The page that did succeed is still reported.
    expect(toastMock.success).toHaveBeenCalledWith('1 page moved to trash');
  });

  it('reports only the failure when nothing succeeded', async () => {
    apiFetchMock.mockResolvedValue({ succeeded: 0, failed: 2, errors: [] });

    render(
      <BulkActionBar selectedIds={['1', '2']} confluenceCount={0} onClear={vi.fn()} />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByTestId('bulk-quality-btn'));

    await waitFor(() => {
      expect(toastMock.warning).toHaveBeenCalledWith(
        '2 pages could not be queued for quality analysis.',
      );
    });
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it('says so when the server accepted the request and acted on nothing', async () => {
    // Re-embed skips pages with no confluence_id, so a standalone-only
    // selection comes back all zeroes. Staying silent would read as success.
    apiFetchMock.mockResolvedValue({ succeeded: 0, failed: 0, errors: [] });

    render(
      <BulkActionBar selectedIds={['1']} confluenceCount={0} onClear={vi.fn()} />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByTestId('bulk-embed-btn'));

    await waitFor(() => {
      expect(toastMock.warning).toHaveBeenCalledWith('No pages were queued for embedding.');
    });
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it('reports the count the server acted on, not the count that was selected', async () => {
    apiFetchMock.mockResolvedValue({ succeeded: 2, failed: 0, errors: [] });

    render(
      <BulkActionBar selectedIds={['1', '2', '3']} confluenceCount={0} onClear={vi.fn()} />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByTestId('bulk-embed-btn'));

    await waitFor(() => {
      expect(toastMock.success).toHaveBeenCalledWith('2 pages queued for embedding');
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
