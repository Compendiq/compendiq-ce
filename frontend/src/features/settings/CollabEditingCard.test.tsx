import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CollabEditingCard } from './CollabEditingCard';

const apiFetch = vi.fn();

vi.mock('../../shared/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function wrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('CollabEditingCard', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/admin/settings' && init?.method === 'PUT') {
        return { collabEditingEnabled: JSON.parse(String(init.body)).collabEditingEnabled };
      }
      return { collabEditingEnabled: false };
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders muted help, not amber, and is off at rest', async () => {
    render(<CollabEditingCard />, { wrapper: wrapper() });

    const help = await screen.findByText(/Confluence nodes/i);
    expect(help.className).toMatch(/text-muted-foreground/);
    expect(help.className).not.toMatch(/warning|amber|destructive/);
    expect(screen.getByTestId('collab-editing-card').className).not.toMatch(/warning|amber/);

    const toggle = screen.getByTestId('collab-editing-toggle');
    expect(toggle).toHaveAttribute('data-state', 'unchecked');
  });

  it('PUTs only collabEditingEnabled when saved', async () => {
    render(<CollabEditingCard />, { wrapper: wrapper() });
    await screen.findByTestId('collab-editing-toggle');

    fireEvent.click(screen.getByTestId('collab-editing-toggle'));
    fireEvent.click(screen.getByTestId('collab-editing-save'));

    await waitFor(() => {
      const put = apiFetch.mock.calls.find(
        ([path, init]) => path === '/admin/settings' && (init as RequestInit | undefined)?.method === 'PUT',
      );
      expect(put).toBeDefined();
      expect(JSON.parse(String((put![1] as RequestInit).body))).toEqual({
        collabEditingEnabled: true,
      });
    });
  });
});
