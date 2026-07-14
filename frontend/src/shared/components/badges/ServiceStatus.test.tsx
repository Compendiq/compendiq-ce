import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ServiceStatus } from './ServiceStatus';
import { useAuthStore } from '../../../stores/auth-store';

// Wrap in LazyMotion for framer-motion
import { LazyMotion, domAnimation } from 'framer-motion';

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <MemoryRouter>
      <LazyMotion features={domAnimation}>{children}</LazyMotion>
    </MemoryRouter>
  );
}

describe('ServiceStatus', () => {
  beforeEach(() => {
    // #1052: the detail fetch to /api/health carries the admin token so the
    // backend returns the per-service `services` payload that drives alerts.
    useAuthStore.setState({
      user: { id: 'u1', username: 'admin', role: 'admin' },
      accessToken: 'tok',
      isAuthenticated: true,
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'ok', llmProvider: 'LMStudio', services: { postgres: true, redis: true, llm: true } }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useAuthStore.setState({ user: null, accessToken: null, isAuthenticated: false });
  });

  it('sends the access token on the /api/health detail fetch (#1052)', async () => {
    render(<ServiceStatus />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/health',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
        }),
      );
    });
    // The reachability probe stays a bare, unauthenticated GET.
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/health/ready');
  });

  it('renders nothing when all services are healthy', async () => {
    render(<ServiceStatus />, { wrapper: Wrapper });

    // Wait for health check to complete
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalled();
    });

    // No alerts should be visible
    expect(screen.queryByText(/LLM provider/)).not.toBeInTheDocument();
    expect(screen.queryByText('Redis is unavailable')).not.toBeInTheDocument();
  });

  it('names the configured provider when the LLM is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'degraded',
          llmProvider: 'LMStudio',
          services: { postgres: true, redis: true, llm: false },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(<ServiceStatus />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText('LLM provider "LMStudio" is unreachable')).toBeInTheDocument();
    });

    const settingsLink = screen.getByRole('link', { name: 'Check LLM settings' });
    expect(settingsLink).toHaveAttribute('href', '/settings/ai/models');
  });

  it('falls back to a generic label when no provider name is reported', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'degraded',
          services: { postgres: true, redis: true, llm: false },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(<ServiceStatus />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText('LLM provider is unreachable')).toBeInTheDocument();
    });
  });

  it('shows alert when Redis is disconnected', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'degraded',
          llmProvider: 'LMStudio',
          services: { postgres: true, redis: false, llm: true },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(<ServiceStatus />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText('Redis is unavailable')).toBeInTheDocument();
    });

    // Unlike the LLM alert, the Redis alert has no settings page to link to —
    // it must render without any link.
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('shows network error when fetch fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

    render(<ServiceStatus />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText('Network connection lost')).toBeInTheDocument();
    });
  });

  it('shows multiple alerts when multiple services are down', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'degraded',
          llmProvider: 'LMStudio',
          services: { postgres: true, redis: false, llm: false },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(<ServiceStatus />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText('LLM provider "LMStudio" is unreachable')).toBeInTheDocument();
      expect(screen.getByText('Redis is unavailable')).toBeInTheDocument();
    });
  });

  it('dismisses alert when close button is clicked', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'degraded',
          llmProvider: 'LMStudio',
          services: { postgres: true, redis: true, llm: false },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(<ServiceStatus />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText('LLM provider "LMStudio" is unreachable')).toBeInTheDocument();
    });

    const dismissBtn = screen.getByLabelText('Dismiss LLM provider alert');
    fireEvent.click(dismissBtn);

    await waitFor(() => {
      expect(screen.queryByText('LLM provider "LMStudio" is unreachable')).not.toBeInTheDocument();
    });
  });

  it('shows API unreachable when response is not ok', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 500 }),
    );

    render(<ServiceStatus />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText('API server is unreachable')).toBeInTheDocument();
    });
  });
});
