import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { EmbeddingShadowMigrationCard } from './EmbeddingShadowMigrationCard';
import { useAuthStore } from '../../../stores/auth-store';

// #1116 admin surface for the zero-downtime re-embed. Fetch is mocked at the
// network boundary; the card drives the real component logic.

beforeEach(() => {
  useAuthStore.getState().setAuth('t', { id: '1', username: 'admin', role: 'admin' });
});
afterEach(() => {
  vi.restoreAllMocks();
  useAuthStore.getState().clearAuth();
});

const PENDING = { providerId: '2c0c8a92-98a8-4f8c-a6a1-000000000001', model: 'qwen3-embedding:4b' };

type Status = {
  active: boolean;
  migration: null | {
    phase: 'backfilling' | 'ready' | 'swapped';
    model: string;
    dimensions: number;
    totalPages: number;
    backfilledPages: number;
    stragglerPages: number;
  };
};

function mockApi(status: Status, capture?: Array<{ url: string; method: string }>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const method = init?.method ?? 'GET';
    capture?.push({ url, method });
    if (url.includes('/admin/embedding/shadow-migration') && method === 'GET') {
      return new Response(JSON.stringify(status), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/admin/embedding/shadow-migration')) {
      return new Response(JSON.stringify({ dimensions: 2560, pageCount: 42, jobId: 'shadow-reembed' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
  });
}

describe('EmbeddingShadowMigrationCard (#1116)', () => {
  it('renders nothing with no pending change and no active migration', async () => {
    mockApi({ active: false, migration: null });
    const { container } = render(<EmbeddingShadowMigrationCard pending={null} />);
    await waitFor(() => expect(container.querySelector('[data-testid="shadow-migration-card"]')).toBeNull());
  });

  it('offers the zero-downtime path for a pending model change and starts it', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    mockApi({ active: false, migration: null }, calls);
    render(<EmbeddingShadowMigrationCard pending={PENDING} />);

    const startBtn = await screen.findByRole('button', { name: /zero-downtime re-embed/i });
    fireEvent.click(startBtn);

    await waitFor(() => {
      expect(
        calls.some(
          (c) => c.method === 'POST' && c.url.includes('/admin/embedding/shadow-migration') && !c.url.match(/swap|rollback|cleanup/),
        ),
      ).toBe(true);
    });
  });

  it('shows backfill progress and an abort control while backfilling', async () => {
    mockApi({
      active: true,
      migration: { phase: 'backfilling', model: 'qwen3-embedding:4b', dimensions: 2560, totalPages: 40, backfilledPages: 10, stragglerPages: 30 },
    });
    render(<EmbeddingShadowMigrationCard pending={null} />);

    expect(await screen.findByTestId('shadow-migration-card')).toHaveTextContent('10/40');
    expect(screen.getByRole('button', { name: /abort/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^swap/i })).not.toBeInTheDocument();
  });

  it('enables the swap only when ready', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    mockApi(
      {
        active: true,
        migration: { phase: 'ready', model: 'qwen3-embedding:4b', dimensions: 2560, totalPages: 40, backfilledPages: 40, stragglerPages: 0 },
      },
      calls,
    );
    render(<EmbeddingShadowMigrationCard pending={null} />);

    const swapBtn = await screen.findByRole('button', { name: /^swap/i });
    fireEvent.click(swapBtn);
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.url.includes('/swap'))).toBe(true);
    });
  });

  it('after the swap, cleanup demands an explicit confirmation naming the loss', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    mockApi(
      {
        active: true,
        migration: { phase: 'swapped', model: 'qwen3-embedding:4b', dimensions: 2560, totalPages: 40, backfilledPages: 40, stragglerPages: 0 },
      },
      calls,
    );
    render(<EmbeddingShadowMigrationCard pending={null} />);

    fireEvent.click(await screen.findByRole('button', { name: /clean up/i }));
    // First click arms the confirmation — nothing is posted yet.
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/cleanup'))).toBe(false);
    expect(screen.getByText(/permanently deletes the old vectors/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /confirm cleanup/i }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.url.includes('/cleanup'))).toBe(true);
    });
  });

  it('offers rollback after the swap', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    mockApi(
      {
        active: true,
        migration: { phase: 'swapped', model: 'qwen3-embedding:4b', dimensions: 2560, totalPages: 40, backfilledPages: 40, stragglerPages: 0 },
      },
      calls,
    );
    render(<EmbeddingShadowMigrationCard pending={null} />);

    fireEvent.click(await screen.findByRole('button', { name: /roll back/i }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.url.includes('/rollback'))).toBe(true);
    });
  });
});
