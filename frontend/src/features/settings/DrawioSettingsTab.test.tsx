import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DrawioSettingsTab } from './DrawioSettingsTab';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

function mockFetchWith(settings: Record<string, unknown>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = init?.method ?? (input as Request)?.method ?? 'GET';
    if (url.includes('/admin/settings')) {
      if (method === 'PUT') {
        return new Response(JSON.stringify({ message: 'Updated' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify(settings), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('Not found', { status: 404 });
  });
}

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('DrawioSettingsTab', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders with existing drawioEmbedUrl from admin settings', async () => {
    mockFetchWith({ drawioEmbedUrl: 'https://drawio.internal.example.com' });
    render(<DrawioSettingsTab />, { wrapper: createWrapper() });

    const input = await screen.findByTestId('admin-drawio-url-input');
    expect((input as HTMLInputElement).value).toBe('https://drawio.internal.example.com');
    expect(screen.getByTestId('admin-drawio-save-btn')).toBeDisabled();
  });

  it('saves new drawioEmbedUrl on submit', async () => {
    const fetchSpy = mockFetchWith({ drawioEmbedUrl: null });
    render(<DrawioSettingsTab />, { wrapper: createWrapper() });

    const input = await screen.findByTestId('admin-drawio-url-input');
    fireEvent.change(input, { target: { value: 'https://diagrams.company.net' } });

    const saveBtn = screen.getByTestId('admin-drawio-save-btn');
    expect(saveBtn).not.toBeDisabled();
    fireEvent.click(saveBtn);

    await waitFor(() => {
      const putCall = fetchSpy.mock.calls.find(
        ([target, init]) =>
          String(target).includes('/admin/settings') &&
          ((init as RequestInit | undefined)?.method === 'PUT' || (target as Request)?.method === 'PUT'),
      );
      expect(putCall).toBeDefined();
    });
  });

  it('sends null when URL is cleared', async () => {
    const fetchSpy = mockFetchWith({ drawioEmbedUrl: 'https://diagrams.company.net' });
    render(<DrawioSettingsTab />, { wrapper: createWrapper() });

    const input = await screen.findByTestId('admin-drawio-url-input');
    fireEvent.change(input, { target: { value: '   ' } });

    const saveBtn = screen.getByTestId('admin-drawio-save-btn');
    fireEvent.click(saveBtn);

    await waitFor(() => {
      const putCall = fetchSpy.mock.calls.find(
        ([target, init]) =>
          String(target).includes('/admin/settings') &&
          ((init as RequestInit | undefined)?.method === 'PUT' || (target as Request)?.method === 'PUT'),
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse((putCall![1] as RequestInit).body as string);
      expect(body.drawioEmbedUrl).toBeNull();
    });
  });
});
