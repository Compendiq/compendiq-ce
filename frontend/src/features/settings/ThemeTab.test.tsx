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
  theme: 'void-indigo',
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
    useThemeStore.setState({ theme: 'void-indigo' });
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

  it('does not render the Account tab button', () => {
    render(<SettingsPage />, { wrapper: createWrapper() });
    expect(screen.queryByTestId('tab-account')).not.toBeInTheDocument();
  });

  it('renders theme category sections', async () => {
    render(<SettingsPage />, { wrapper: createWrapper() });
    await navigateToThemeTab();

    expect(screen.getByTestId('theme-category-dark')).toBeInTheDocument();
    expect(screen.getByTestId('theme-category-light')).toBeInTheDocument();
  });

  it('renders all 4 theme options across categories', async () => {
    render(<SettingsPage />, { wrapper: createWrapper() });
    await navigateToThemeTab();

    // Dark themes
    expect(screen.getByTestId('theme-void-indigo')).toBeInTheDocument();
    expect(screen.getByTestId('theme-obsidian-violet')).toBeInTheDocument();

    // Light themes
    expect(screen.getByTestId('theme-polar-slate')).toBeInTheDocument();
    expect(screen.getByTestId('theme-parchment-glow')).toBeInTheDocument();
  });

  it('shows active badge on the current theme', async () => {
    render(<SettingsPage />, { wrapper: createWrapper() });
    await navigateToThemeTab();

    const activeBadge = screen.getByTestId('theme-active-badge');
    expect(activeBadge).toBeInTheDocument();
    expect(activeBadge).toHaveTextContent('Active');

    // Active badge should be within the void-indigo theme card
    const voidIndigoCard = screen.getByTestId('theme-void-indigo');
    expect(voidIndigoCard.querySelector('[data-testid="theme-active-badge"]')).toBeInTheDocument();
  });

  it('switches theme when clicking a different theme card', async () => {
    render(<SettingsPage />, { wrapper: createWrapper() });
    await navigateToThemeTab();

    fireEvent.click(screen.getByTestId('theme-obsidian-violet'));

    expect(useThemeStore.getState().theme).toBe('obsidian-violet');
  });

  it('switches to a light theme', async () => {
    render(<SettingsPage />, { wrapper: createWrapper() });
    await navigateToThemeTab();

    fireEvent.click(screen.getByTestId('theme-polar-slate'));

    expect(useThemeStore.getState().theme).toBe('polar-slate');
  });

  it('calls onSave with the selected theme id', async () => {
    render(<SettingsPage />, { wrapper: createWrapper() });
    await navigateToThemeTab();

    fireEvent.click(screen.getByTestId('theme-parchment-glow'));

    await waitFor(() => {
      // Verify fetch was called with a PUT containing the theme
      const putCalls = fetchSpy.mock.calls.filter((call: unknown[]) => {
        const opts = call[1] as RequestInit | undefined;
        return opts?.method === 'PUT';
      });
      expect(putCalls.length).toBeGreaterThan(0);
      const body = JSON.parse((putCalls[0][1] as RequestInit).body as string);
      expect(body).toEqual({ theme: 'parchment-glow' });
    });
  });

  it('displays theme labels and descriptions', async () => {
    render(<SettingsPage />, { wrapper: createWrapper() });
    await navigateToThemeTab();

    expect(screen.getByText('Void')).toBeInTheDocument();
    expect(screen.getByText('Inky graphite with indigo accents — Linear \u00d7 GitHub')).toBeInTheDocument();
    expect(screen.getByText('Obsidian')).toBeInTheDocument();
    expect(screen.getByText('Polar Slate')).toBeInTheDocument();
    expect(screen.getByText('Parchment Glow')).toBeInTheDocument();
  });

  it('displays category headers', async () => {
    render(<SettingsPage />, { wrapper: createWrapper() });
    await navigateToThemeTab();

    expect(screen.getByText('Dark')).toBeInTheDocument();
    expect(screen.getByText('Light')).toBeInTheDocument();
  });
});
