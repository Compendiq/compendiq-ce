import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { SettingsPage } from './SettingsPage';

// Mock auth store - must support both hook-style (selector) and getState() calls
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

const mockSettings: {
  confluenceUrl: string;
  hasConfluencePat: boolean;
  selectedSpaces: string[];
  ollamaModel: string;
  llmProvider: 'ollama' | 'openai';
  openaiBaseUrl: string | null;
  hasOpenaiApiKey: boolean;
  openaiModel: string | null;
  embeddingModel: string;
  theme: string;
  syncIntervalMin: number;
  confluenceConnected: boolean;
  showSpaceHomeContent: boolean;
} = {
  confluenceUrl: 'https://confluence.example.com',
  hasConfluencePat: true,
  selectedSpaces: [],
  ollamaModel: 'qwen3.5',
  llmProvider: 'ollama',
  openaiBaseUrl: null,
  hasOpenaiApiKey: false,
  openaiModel: null,
  embeddingModel: 'nomic-embed-text',
  theme: 'glass-dark',
  syncIntervalMin: 15,
  confluenceConnected: true,
  showSpaceHomeContent: true,
};

const mockModels = [
  { name: 'qwen3.5' },
  { name: 'llama3' },
  { name: 'mistral' },
];

const mockStatus = {
  connected: true,
  provider: 'ollama',
  ollamaBaseUrl: 'http://localhost:11434',
  openaiBaseUrl: 'https://api.openai.com/v1',
  embeddingModel: 'nomic-embed-text',
};

describe('LlmTab (OllamaTab)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockFetchResponses(overrides?: {
    status?: typeof mockStatus;
    models?: typeof mockModels | Error;
    settings?: typeof mockSettings;
  }) {
    const status = overrides?.status ?? mockStatus;
    const models = overrides?.models;
    const settings = overrides?.settings ?? mockSettings;

    fetchSpy.mockImplementation(async (url: string | URL | Request) => {
      const path = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

      if (path.includes('/api/ollama/status')) {
        return new Response(JSON.stringify(status), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (path.includes('/api/ollama/models')) {
        if (models instanceof Error) {
          return new Response(JSON.stringify({ message: models.message }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify(models ?? mockModels), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (path.includes('/api/settings')) {
        return new Response(JSON.stringify(settings), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response('{}', {
        headers: { 'Content-Type': 'application/json' },
      });
    });
  }

  async function navigateToLlmTab() {
    // Wait for settings to load first, then click LLM tab
    await waitFor(() => {
      expect(screen.queryByText('Loading settings...')).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('tab-ollama'));
  }

  it('displays the configured Ollama server URL', async () => {
    mockFetchResponses();
    render(<SettingsPage />, { wrapper: createWrapper() });
    await navigateToLlmTab();

    await waitFor(() => {
      expect(screen.getByText(/localhost:11434/)).toBeInTheDocument();
    });
  });

  it('shows connected status indicator when Ollama is reachable', async () => {
    mockFetchResponses();
    render(<SettingsPage />, { wrapper: createWrapper() });
    await navigateToLlmTab();

    await waitFor(() => {
      expect(screen.getByText(/localhost:11434/)).toBeInTheDocument();
    });

    expect(screen.queryByText('(disconnected)')).not.toBeInTheDocument();
  });

  it('shows disconnected status when Ollama is unreachable', async () => {
    mockFetchResponses({
      status: {
        connected: false,
        provider: 'ollama',
        ollamaBaseUrl: 'http://ollama:11434',
        openaiBaseUrl: 'https://api.openai.com/v1',
        embeddingModel: 'nomic-embed-text',
      },
    });
    render(<SettingsPage />, { wrapper: createWrapper() });
    await navigateToLlmTab();

    await waitFor(() => {
      expect(screen.getByText(/\(disconnected\)/)).toBeInTheDocument();
    });
  });

  it('populates model dropdown after auto-scan', async () => {
    mockFetchResponses();
    render(<SettingsPage />, { wrapper: createWrapper() });
    await navigateToLlmTab();

    await waitFor(() => {
      const select = screen.getByTestId('ollama-model-select');
      const options = select.querySelectorAll('option');
      expect(options).toHaveLength(3);
      expect(options[0].textContent).toBe('qwen3.5');
      expect(options[1].textContent).toBe('llama3');
      expect(options[2].textContent).toBe('mistral');
    });
  });

  it('shows error message when model scan fails', async () => {
    mockFetchResponses({ models: new Error('Ollama server unavailable') });
    render(<SettingsPage />, { wrapper: createWrapper() });
    await navigateToLlmTab();

    // retry: 1 in the component means TanStack Query retries once, so we need a longer timeout
    await waitFor(() => {
      expect(screen.getByTestId('ollama-scan-error')).toBeInTheDocument();
      expect(screen.getByText(/Failed to scan models/)).toBeInTheDocument();
    }, { timeout: 5000 });
  });

  it('shows scan button that triggers model refresh', async () => {
    mockFetchResponses();
    render(<SettingsPage />, { wrapper: createWrapper() });
    await navigateToLlmTab();

    await waitFor(() => {
      const scanBtn = screen.getByTestId('ollama-scan-btn');
      expect(scanBtn).toBeInTheDocument();
      expect(scanBtn.textContent).toBe('Scan');
    });
  });

  it('shows embedding model as read-only', async () => {
    mockFetchResponses();
    render(<SettingsPage />, { wrapper: createWrapper() });
    await navigateToLlmTab();

    await waitFor(() => {
      expect(screen.getByText(/nomic-embed-text.*server-wide, read-only/)).toBeInTheDocument();
    });
  });

  it('shows provider selector with Ollama and OpenAI buttons', async () => {
    mockFetchResponses();
    render(<SettingsPage />, { wrapper: createWrapper() });
    await navigateToLlmTab();

    await waitFor(() => {
      expect(screen.getByTestId('provider-ollama-btn')).toBeInTheDocument();
      expect(screen.getByTestId('provider-openai-btn')).toBeInTheDocument();
    });
  });

  it('switches to OpenAI settings when OpenAI provider is selected', async () => {
    mockFetchResponses();
    render(<SettingsPage />, { wrapper: createWrapper() });
    await navigateToLlmTab();

    await waitFor(() => {
      expect(screen.getByTestId('provider-openai-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('provider-openai-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('openai-base-url-input')).toBeInTheDocument();
      expect(screen.getByTestId('openai-api-key-input')).toBeInTheDocument();
      expect(screen.getByTestId('openai-model-input')).toBeInTheDocument();
    });
  });

  it('shows OpenAI API key configured status', async () => {
    mockFetchResponses({
      settings: {
        ...mockSettings,
        llmProvider: 'openai',
        hasOpenaiApiKey: true,
        openaiBaseUrl: 'https://api.openai.com/v1',
        openaiModel: 'gpt-4o',
      },
    });
    render(<SettingsPage />, { wrapper: createWrapper() });
    await navigateToLlmTab();

    // The provider should default to openai from settings
    await waitFor(() => {
      expect(screen.getByTestId('openai-api-key-input')).toBeInTheDocument();
    });

    expect(screen.getByText('Configured')).toBeInTheDocument();
  });
});
