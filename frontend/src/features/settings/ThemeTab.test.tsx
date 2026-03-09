import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { SettingsPage } from './SettingsPage';
import { useThemeStore } from '../../stores/theme-store';

// Mock auth store
const authState = { user: { role: 'user' }, accessToken: 'test-token', setAuth: vi.fn(), clearAuth: vi.fn() };
vi.mock('../../stores/auth-store', () => ({
  useAuthStore: Object.assign(
    (selector: (state: typeof authState) => unknown) => selector(authState),
    { getState: () => authState },
  ),
}));

const mockSettings = {
  confluenceUrl: 'https://confluence.example.com',
  hasConfluencePat: true,
  selectedSpaces: [],
  ollamaModel: 'qwen3.5',
  embeddingModel: 'nomic-embed-text',
  theme: 'midnight-blue',
  syncIntervalMin: 15,
  confluenceConnected: true,
};

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

describe('ThemeTab', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    useThemeStore.setState({ theme: 'midnight-blue' });
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockImplementation(async (url: string | URL | Request) => {
      const path = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

      if (path.includes('/api/settings') && !path.includes('test-confluence')) {
        // Check if it's a PUT request
        return new Response(JSON.stringify(mockSettings), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response('{}', {
        headers: { 'Content-Type': 'application/json' },
      });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function navigateToThemeTab() {
    await waitFor(() => {
      expect(screen.queryByText('Loading settings...')).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('tab-theme'));
  }

  it('displays the Theme tab button', async () => {
    render(<SettingsPage />, { wrapper: createWrapper() });
    expect(screen.getByTestId('tab-theme')).toBeInTheDocument();
    expect(screen.getByTestId('tab-theme')).toHaveTextContent('Theme');
  });

  it('renders all 10 theme options', async () => {
    render(<SettingsPage />, { wrapper: createWrapper() });
    await navigateToThemeTab();

    const grid = screen.getByTestId('theme-grid');
    expect(grid).toBeInTheDocument();

    expect(screen.getByTestId('theme-midnight-blue')).toBeInTheDocument();
    expect(screen.getByTestId('theme-ocean-depth')).toBeInTheDocument();
    expect(screen.getByTestId('theme-emerald-dark')).toBeInTheDocument();
    expect(screen.getByTestId('theme-rose-noir')).toBeInTheDocument();
    expect(screen.getByTestId('theme-amber-night')).toBeInTheDocument();
    expect(screen.getByTestId('theme-arctic-frost')).toBeInTheDocument();
    expect(screen.getByTestId('theme-violet-storm')).toBeInTheDocument();
    expect(screen.getByTestId('theme-cyber-teal')).toBeInTheDocument();
    expect(screen.getByTestId('theme-sunset-glow')).toBeInTheDocument();
    expect(screen.getByTestId('theme-slate-minimal')).toBeInTheDocument();
  });

  it('shows active badge on the current theme', async () => {
    render(<SettingsPage />, { wrapper: createWrapper() });
    await navigateToThemeTab();

    const activeBadge = screen.getByTestId('theme-active-badge');
    expect(activeBadge).toBeInTheDocument();
    expect(activeBadge).toHaveTextContent('Active');

    // Active badge should be within the midnight-blue theme card
    const midnightCard = screen.getByTestId('theme-midnight-blue');
    expect(midnightCard.querySelector('[data-testid="theme-active-badge"]')).toBeInTheDocument();
  });

  it('switches theme when clicking a different theme card', async () => {
    render(<SettingsPage />, { wrapper: createWrapper() });
    await navigateToThemeTab();

    fireEvent.click(screen.getByTestId('theme-ocean-depth'));

    expect(useThemeStore.getState().theme).toBe('ocean-depth');
  });

  it('calls onSave with the selected theme id', async () => {
    render(<SettingsPage />, { wrapper: createWrapper() });
    await navigateToThemeTab();

    fireEvent.click(screen.getByTestId('theme-emerald-dark'));

    await waitFor(() => {
      // Verify fetch was called with a PUT containing the theme
      const putCalls = fetchSpy.mock.calls.filter((call: unknown[]) => {
        const opts = call[1] as RequestInit | undefined;
        return opts?.method === 'PUT';
      });
      expect(putCalls.length).toBeGreaterThan(0);
      const body = JSON.parse((putCalls[0][1] as RequestInit).body as string);
      expect(body).toEqual({ theme: 'emerald-dark' });
    });
  });

  it('displays theme labels and descriptions', async () => {
    render(<SettingsPage />, { wrapper: createWrapper() });
    await navigateToThemeTab();

    expect(screen.getByText('Midnight Blue')).toBeInTheDocument();
    expect(screen.getByText('Deep blue-violet with electric blue accents')).toBeInTheDocument();
    expect(screen.getByText('Ocean Depth')).toBeInTheDocument();
    expect(screen.getByText('Slate Minimal')).toBeInTheDocument();
  });
});
