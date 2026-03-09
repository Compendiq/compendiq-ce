import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { DashboardPage } from './DashboardPage';

describe('DashboardPage (deprecated)', () => {
  it('renders null (merged into PagesPage)', () => {
    const { container } = render(<DashboardPage />);
    expect(container.innerHTML).toBe('');
  });

  it('shows embedded pages ratio in stats', async () => {
    const { unmount } = render(<DashboardPage />, { wrapper: createWrapper() });
    // Wait for embedding status data to load - "37 / 42" from embeddedPages/totalPages
    const ratio = await screen.findByText('37 / 42');
    expect(ratio).toBeInTheDocument();
    unmount();
  });

  it('shows Embed Now button when dirty pages exist', async () => {
    const { unmount } = render(<DashboardPage />, { wrapper: createWrapper() });
    const embedButton = await screen.findByText('Embed Now');
    expect(embedButton).toBeInTheDocument();
    unmount();
  });

  it('shows dirty pages count in embedding trigger section', async () => {
    const { unmount } = render(<DashboardPage />, { wrapper: createWrapper() });
    const dirtyText = await screen.findByText(/5 pages need embedding/);
    expect(dirtyText).toBeInTheDocument();
    unmount();
  });

  it('calls embedding process endpoint when Embed Now is clicked', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { unmount } = render(<DashboardPage />, { wrapper: createWrapper() });

    const embedButton = await screen.findByText('Embed Now');
    fireEvent.click(embedButton);

    // Check that POST /api/embeddings/process was called
    await vi.waitFor(() => {
      const calls = fetchSpy.mock.calls;
      const processCall = calls.find((call) => {
        const url = typeof call[0] === 'string' ? call[0] : '';
        return url.includes('/api/embeddings/process');
      });
      expect(processCall).toBeDefined();
    });
    unmount();
  });

  it('does not show embedding trigger when no dirty pages', async () => {
    // Override fetch to return 0 dirty pages
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;

      if (url.includes('/api/embeddings/status')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ totalPages: 42, embeddedPages: 42, dirtyPages: 0, totalEmbeddings: 200, isProcessing: false }),
            { headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }

      // Return default responses for other endpoints
      if (url.includes('/api/spaces')) {
        return Promise.resolve(
          new Response(JSON.stringify([]), { headers: { 'Content-Type': 'application/json' } }),
        );
      }
      if (url.includes('/api/pages')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ items: [], total: 0, page: 1, limit: 1, totalPages: 0 }),
            { headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }

      return Promise.resolve(
        new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } }),
      );
    });

    const { unmount } = render(<DashboardPage />, { wrapper: createWrapper() });

    // Wait for data to load
    await screen.findByText('42 / 42');

    // The "Embed Now" button should not be present
    expect(screen.queryByText('Embed Now')).not.toBeInTheDocument();
    unmount();
  });
});
