import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EmbeddingReembedBanner } from './EmbeddingReembedBanner';
import { useAuthStore } from '../../../stores/auth-store';

function createWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe('EmbeddingReembedBanner', () => {
  beforeEach(() => {
    useAuthStore.getState().setAuth('test-token', {
      id: '1',
      username: 'admin',
      role: 'admin',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useAuthStore.getState().clearAuth();
  });

  it('renders nothing when there is no live pair and nothing pending', () => {
    const Wrapper = createWrapper();
    const { container } = render(
      <EmbeddingReembedBanner currentDimensions={1024} pending={null} live={null} />,
      { wrapper: Wrapper },
    );
    expect(container.firstChild).toBeNull();
  });

  it('does not offer Wipe while an unsaved model change is pending', () => {
    const Wrapper = createWrapper();
    const { container } = render(
      <EmbeddingReembedBanner
        currentDimensions={1024}
        pending={{ providerId: 'p1', model: 'qwen3-embedding:4b' }}
        live={{ providerId: 'p0', model: 'bge-m3' }}
      />,
      { wrapper: Wrapper },
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole('button', { name: /wipe current index/i })).toBeNull();
  });

  it('clicking probe-and-reembed fires probe call', async () => {
    const Wrapper = createWrapper();
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.includes('/admin/embedding/probe')) {
        return new Response(JSON.stringify({ dimensions: 1024 }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/admin/embedding/reembed')) {
        return new Response(JSON.stringify({ jobId: 'reembed-1', pageCount: 5 }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    });
    render(
      <EmbeddingReembedBanner
        currentDimensions={1024}
        pending={null}
        live={{ providerId: 'p1', model: 'bge-m3' }}
      />,
      { wrapper: Wrapper },
    );
    const wipe = screen.getByRole('button', { name: /^Wipe current index$/i });
    expect(wipe).toHaveClass('nm-action-destructive');
    fireEvent.click(wipe);
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('/admin/embedding/probe'),
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  it('shows heavy-warning confirmation when probed dimensions differ', async () => {
    const Wrapper = createWrapper();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.includes('/admin/embedding/probe')) {
        return new Response(JSON.stringify({ dimensions: 768 }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    });
    render(
      <EmbeddingReembedBanner
        currentDimensions={1024}
        pending={null}
        live={{ providerId: 'p1', model: 'other-model' }}
      />,
      { wrapper: Wrapper },
    );
    fireEvent.click(screen.getByRole('button', { name: /^Wipe current index$/i }));
    await screen.findByText(/delete all existing embeddings/i);
    expect(screen.getByText(/1024 → 768/)).toBeTruthy();
  });

  // Plan §2.9 — the "worker not yet implemented" warning block was dropped
  // by Phase 5 of #257 now that the BullMQ worker actually runs. The dialog
  // should now contain neither the old warning text nor a link to #257.
  it('heavy-warning dialog no longer carries the "worker not implemented" alert', async () => {
    const Wrapper = createWrapper();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.includes('/admin/embedding/probe')) {
        return new Response(JSON.stringify({ dimensions: 768 }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    });
    render(
      <EmbeddingReembedBanner
        currentDimensions={1024}
        pending={null}
        live={{ providerId: 'p1', model: 'other-model' }}
      />,
      { wrapper: Wrapper },
    );
    fireEvent.click(screen.getByRole('button', { name: /^Wipe current index$/i }));
    await screen.findByText(/delete all existing embeddings/i);

    expect(screen.queryByText(/re-embed worker not yet implemented/i)).toBeNull();
    expect(screen.queryByRole('link', { name: /issue #257/i })).toBeNull();
  });

  it('on confirm with heavy change, POSTs reembed with newDimensions', async () => {
    const Wrapper = createWrapper();
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.includes('/admin/embedding/probe')) {
        return new Response(JSON.stringify({ dimensions: 768 }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/admin/embedding/reembed')) {
        return new Response(JSON.stringify({ jobId: 'reembed-1', pageCount: 5 }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    });
    render(
      <EmbeddingReembedBanner
        currentDimensions={1024}
        pending={null}
        live={{ providerId: 'p1', model: 'other-model' }}
      />,
      { wrapper: Wrapper },
    );
    fireEvent.click(screen.getByRole('button', { name: /^Wipe current index$/i }));
    await screen.findByText(/delete all existing embeddings/i);
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    await waitFor(() => {
      const reembedCall = spy.mock.calls.find(
        ([input]) =>
          typeof input === 'string' && input.includes('/admin/embedding/reembed'),
      );
      expect(reembedCall).toBeTruthy();
      expect(JSON.parse((reembedCall![1] as RequestInit).body as string)).toEqual({
        newDimensions: 768,
      });
    });
  });

  it('on confirm with matching dimensions, POSTs reembed without newDimensions', async () => {
    const Wrapper = createWrapper();
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.includes('/admin/embedding/probe')) {
        return new Response(JSON.stringify({ dimensions: 1024 }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/admin/embedding/reembed')) {
        return new Response(JSON.stringify({ jobId: 'reembed-1', pageCount: 5 }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    });
    render(
      <EmbeddingReembedBanner
        currentDimensions={1024}
        pending={null}
        live={{ providerId: 'p1', model: 'bge-m3-instruct' }}
      />,
      { wrapper: Wrapper },
    );
    fireEvent.click(screen.getByRole('button', { name: /^Wipe current index$/i }));
    await screen.findByText(/dimension stays at 1024/i);
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    await waitFor(() => {
      const reembedCall = spy.mock.calls.find(
        ([input]) =>
          typeof input === 'string' && input.includes('/admin/embedding/reembed'),
      );
      expect(reembedCall).toBeTruthy();
      expect(JSON.parse((reembedCall![1] as RequestInit).body as string)).toEqual({});
    });
  });

  // RED #14 (plan §4.10) — surfaces the waiting-on-user-locks phase.
  it('surfaces the waiting-on-user-locks progress phase when the GET polls return it', async () => {
    const Wrapper = createWrapper();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.includes('/admin/embedding/probe')) {
        return new Response(JSON.stringify({ dimensions: 1024 }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/admin/embedding/reembed')) {
        return new Response(
          JSON.stringify({ jobId: 'reembed-all', pageCount: 5, heldBy: ['alice'] }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/admin/embedding/reembed/reembed-all')) {
        return new Response(
          JSON.stringify({
            jobId: 'reembed-all',
            state: 'active',
            progress: {
              phase: 'waiting-on-user-locks',
              heldBy: ['alice'],
              waitedMs: 4000,
            },
            heldBy: ['alice'],
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    });

    render(
      <EmbeddingReembedBanner
        currentDimensions={1024}
        pending={null}
        live={{ providerId: 'p1', model: 'bge-m3-instruct' }}
      />,
      { wrapper: Wrapper },
    );

    fireEvent.click(screen.getByRole('button', { name: /^Wipe current index$/i }));
    await screen.findByText(/dimension stays at 1024/i);
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));

    // Wait for the 2-second poll interval to fire at least once and the
    // progress phase to hit the DOM.
    const banner = await waitFor(
      () => screen.getByTestId('reembed-progress-banner'),
      { timeout: 5000 },
    );
    await waitFor(() => {
      expect(banner.textContent ?? '').toMatch(/waiting for alice/i);
    }, { timeout: 5000 });
  });

  // The banner's border tint is gone. It came from `--color-status-embedding`,
  // which resolves to body ink now, and its 30% measures 1.941:1 (Paper) /
  // 2.431:1 (Graphite) against Pane where an ordinary card's `--color-border`
  // hairline measures 1.414 / 1.264 — the banner would have out-drawn every
  // card around it. The determinate bar is the replacement signal, so the bar
  // is what is asserted, and only for the one phase that reports both numbers.
  it('draws a determinate bar for the embedding phase and none without a page pair', async () => {
    const Wrapper = createWrapper();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.includes('/admin/embedding/probe')) {
        return new Response(JSON.stringify({ dimensions: 1024 }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/admin/embedding/reembed')) {
        return new Response(JSON.stringify({ jobId: 'reembed-all', pageCount: 40 }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/admin/embedding/reembed/reembed-all')) {
        return new Response(
          JSON.stringify({
            jobId: 'reembed-all',
            state: 'active',
            progress: { phase: 'embedding', processed: 10, total: 40 },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    });

    render(
      <EmbeddingReembedBanner
        currentDimensions={1024}
        pending={null}
        live={{ providerId: 'p1', model: 'bge-m3-instruct' }}
      />,
      { wrapper: Wrapper },
    );
    fireEvent.click(screen.getByRole('button', { name: /^Wipe current index$/i }));
    await screen.findByText(/dimension stays at 1024/i);
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));

    const banner = await waitFor(() => screen.getByTestId('reembed-progress-banner'), {
      timeout: 5000,
    });
    // The sentence still carries the raw pair.
    await waitFor(() => expect(banner.textContent ?? '').toMatch(/10\/40 pages/), {
      timeout: 5000,
    });
    // No border utility: the banner wears `nm-card`'s own hairline.
    expect(banner.className.split(/\s+/).filter((c) => c.startsWith('border'))).toEqual([]);
    // 10 of 40 → 25%, announced once through the sentence, drawn once here.
    const bar = screen.getByTestId('reembed-progress-bar');
    expect(bar).toHaveAttribute('aria-valuenow', '25');
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('25%');
  });
});
