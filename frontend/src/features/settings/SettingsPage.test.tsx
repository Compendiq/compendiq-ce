import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { SettingsPage } from './SettingsPage';

// Mock auth store
const authState = { user: { role: 'user' }, accessToken: 'test-token', setAuth: vi.fn(), clearAuth: vi.fn() };
vi.mock('../../stores/auth-store', () => ({
  useAuthStore: Object.assign(
    (selector: (state: typeof authState) => unknown) => selector(authState),
    { getState: () => authState },
  ),
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          {children}
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

const mockSettings = {
  confluenceUrl: 'https://confluence.example.com',
  hasConfluencePat: true,
  selectedSpaces: [],
  ollamaModel: 'qwen3.5',
  llmProvider: 'ollama' as const,
  openaiBaseUrl: null,
  hasOpenaiApiKey: false,
  openaiModel: null,
  embeddingModel: 'bge-m3',
  theme: 'glass-dark',
  syncIntervalMin: 15,
  confluenceConnected: true,
  showSpaceHomeContent: true,
};

describe('SettingsPage — ConfluenceTab', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = typeof url === 'string' ? url : (url as Request).url;
      if (path.includes('/settings')) {
        return new Response(JSON.stringify(mockSettings), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({}), {
        headers: { 'Content-Type': 'application/json' },
      });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('wraps Confluence URL and PAT inputs in a <form> element', async () => {
    render(<SettingsPage />, { wrapper: createWrapper() });

    // Wait for the Confluence tab to load
    const urlInput = await screen.findByPlaceholderText('https://confluence.company.com');
    expect(urlInput).toBeInTheDocument();

    // The input should be inside a <form> element
    const form = urlInput.closest('form');
    expect(form).toBeTruthy();

    // The PAT input should also be inside the same form
    const patInput = screen.getByPlaceholderText(/Enter PAT|••••/);
    expect(patInput.closest('form')).toBe(form);
  });

  it('calls onSave via form submission when the form is submitted', async () => {
    render(<SettingsPage />, { wrapper: createWrapper() });

    const urlInput = await screen.findByPlaceholderText('https://confluence.company.com');
    const form = urlInput.closest('form')!;

    // Submit the form
    fireEvent.submit(form);

    // Wait for the PUT request (the mutation fires asynchronously)
    await waitFor(() => {
      const putCalls = fetchSpy.mock.calls.filter(
        ([, opts]) => opts && typeof opts === 'object' && 'method' in opts && opts.method === 'PUT',
      );
      expect(putCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('Save button has type="submit" and Test Connection has type="button"', async () => {
    render(<SettingsPage />, { wrapper: createWrapper() });

    await screen.findByPlaceholderText('https://confluence.company.com');

    const saveBtn = screen.getByText('Save');
    const testBtn = screen.getByText('Test Connection');

    expect(saveBtn.getAttribute('type')).toBe('submit');
    expect(testBtn.getAttribute('type')).toBe('button');
  });
});
