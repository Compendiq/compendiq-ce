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
  embeddingModel: 'bge-m3',
  theme: 'graphite-honey',
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
    useThemeStore.setState({ theme: 'graphite-honey' });
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockImplementation(async (url: string | URL | Request) => {
      const path = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

      if (path.includes('/api/settings') && !path.includes('test-confluence')) {
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

  it('renders both theme options across categories', async () => {
    render(<SettingsPage />, { wrapper: createWrapper() });
    await navigateToThemeTab();

    expect(screen.getByTestId('theme-graphite-honey')).toBeInTheDocument();
    expect(screen.getByTestId('theme-honey-linen')).toBeInTheDocument();
  });

  it('shows active badge on the current theme', async () => {
    render(<SettingsPage />, { wrapper: createWrapper() });
    await navigateToThemeTab();

    const activeBadge = screen.getByTestId('theme-active-badge');
    expect(activeBadge).toBeInTheDocument();
    expect(activeBadge).toHaveTextContent('Active');

    const emberDuskCard = screen.getByTestId('theme-graphite-honey');
    expect(emberDuskCard.querySelector('[data-testid="theme-active-badge"]')).toBeInTheDocument();
  });

  it('switches theme when clicking a different theme card', async () => {
    render(<SettingsPage />, { wrapper: createWrapper() });
    await navigateToThemeTab();

    fireEvent.click(screen.getByTestId('theme-honey-linen'));

    expect(useThemeStore.getState().theme).toBe('honey-linen');
  });

  it('switches to honey-linen (light theme)', async () => {
    render(<SettingsPage />, { wrapper: createWrapper() });
    await navigateToThemeTab();

    fireEvent.click(screen.getByTestId('theme-honey-linen'));

    expect(useThemeStore.getState().theme).toBe('honey-linen');
  });

  it('calls onSave with the selected theme id', async () => {
    render(<SettingsPage />, { wrapper: createWrapper() });
    await navigateToThemeTab();

    fireEvent.click(screen.getByTestId('theme-honey-linen'));

    await waitFor(() => {
      const putCalls = fetchSpy.mock.calls.filter((call: unknown[]) => {
        const opts = call[1] as RequestInit | undefined;
        return opts?.method === 'PUT';
      });
      expect(putCalls.length).toBeGreaterThan(0);
      const body = JSON.parse((putCalls[0][1] as RequestInit).body as string);
      expect(body).toEqual({ theme: 'honey-linen' });
    });
  });

  it('displays theme labels and descriptions', async () => {
    render(<SettingsPage />, { wrapper: createWrapper() });
    await navigateToThemeTab();

    expect(screen.getByText('Graphite Honey')).toBeInTheDocument();
    expect(screen.getByText('Honey Linen')).toBeInTheDocument();
    expect(
      screen.getByText('Graphite surfaces with honey accent — neumorphic dark'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Linen cream with honey accent — neumorphic light'),
    ).toBeInTheDocument();
  });

  it('displays category headers', async () => {
    render(<SettingsPage />, { wrapper: createWrapper() });
    await navigateToThemeTab();

    expect(screen.getByText('Dark')).toBeInTheDocument();
    expect(screen.getByText('Light')).toBeInTheDocument();
  });
});
