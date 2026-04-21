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

  it('renders nothing when pending is null', () => {
    const Wrapper = createWrapper();
    const { container } = render(
      <EmbeddingReembedBanner currentDimensions={1024} pending={null} />,
      { wrapper: Wrapper },
    );
    expect(container.firstChild).toBeNull();
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
        pending={{ providerId: 'p1', model: 'bge-m3' }}
      />,
      { wrapper: Wrapper },
    );
    fireEvent.click(screen.getByRole('button', { name: /probe/i }));
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
        pending={{ providerId: 'p1', model: 'other-model' }}
      />,
      { wrapper: Wrapper },
    );
    fireEvent.click(screen.getByRole('button', { name: /probe/i }));
    await screen.findByText(/delete all existing embeddings/i);
    expect(screen.getByText(/1024 → 768/)).toBeTruthy();
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
        pending={{ providerId: 'p1', model: 'other-model' }}
      />,
      { wrapper: Wrapper },
    );
    fireEvent.click(screen.getByRole('button', { name: /probe/i }));
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
        pending={{ providerId: 'p1', model: 'bge-m3-instruct' }}
      />,
      { wrapper: Wrapper },
    );
    fireEvent.click(screen.getByRole('button', { name: /probe/i }));
    await screen.findByText(/inconsistent until re-embedded/i);
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
});
