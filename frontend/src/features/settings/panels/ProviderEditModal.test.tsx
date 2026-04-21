import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProviderEditModal } from './ProviderEditModal';
import { useAuthStore } from '../../../stores/auth-store';

function createWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

const savedProvider = {
  id: '00000000-0000-0000-0000-000000000001',
  name: 'A',
  baseUrl: 'http://x/v1',
  authType: 'bearer',
  verifySsl: true,
  defaultModel: null,
  isDefault: false,
  hasApiKey: false,
  keyPreview: null,
  createdAt: '2026-04-20T00:00:00.000Z',
  updatedAt: '2026-04-20T00:00:00.000Z',
};

describe('ProviderEditModal — create', () => {
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

  it('renders fields and submits valid input', async () => {
    const onSaved = vi.fn();
    const Wrapper = createWrapper();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(savedProvider), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    render(<ProviderEditModal mode="create" open onClose={() => {}} onSaved={onSaved} />, { wrapper: Wrapper });
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'A' } });
    fireEvent.change(screen.getByLabelText(/base url/i), { target: { value: 'http://x/v1' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/admin/llm-providers'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('disables save when name is empty', () => {
    const Wrapper = createWrapper();
    render(<ProviderEditModal mode="create" open onClose={() => {}} onSaved={() => {}} />, { wrapper: Wrapper });
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
  });

  it('disables save when baseUrl is not http(s)', () => {
    const Wrapper = createWrapper();
    render(<ProviderEditModal mode="create" open onClose={() => {}} onSaved={() => {}} />, { wrapper: Wrapper });
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'A' } });
    fireEvent.change(screen.getByLabelText(/base url/i), { target: { value: 'ftp://bad' } });
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
  });

  it('does not render when open is false', () => {
    const Wrapper = createWrapper();
    render(<ProviderEditModal mode="create" open={false} onClose={() => {}} onSaved={() => {}} />, { wrapper: Wrapper });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('ProviderEditModal — edit', () => {
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

  it('pre-fills fields from initial and PATCHes on save', async () => {
    const onSaved = vi.fn();
    const Wrapper = createWrapper();
    const initial = { ...savedProvider, name: 'Existing', baseUrl: 'https://existing/v1', hasApiKey: true, keyPreview: 'sk-****abcd' };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ...initial, name: 'Renamed' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    render(
      <ProviderEditModal mode="edit" initial={initial} open onClose={() => {}} onSaved={onSaved} />,
      { wrapper: Wrapper },
    );
    expect((screen.getByLabelText(/name/i) as HTMLInputElement).value).toBe('Existing');
    expect(screen.getByText(/configured/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining(`/api/admin/llm-providers/${initial.id}`),
      expect.objectContaining({ method: 'PATCH' }),
    );
  });
});
