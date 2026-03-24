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

function setUserRole(role: 'user' | 'admin') {
  authState.user = { role };
}

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
  customPrompts?: Record<string, string>;
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

const mockAdminSettings = {
  llmProvider: 'ollama' as const,
  ollamaModel: 'qwen3.5',
  openaiBaseUrl: null,
  hasOpenaiApiKey: false,
  openaiModel: null,
  embeddingChunkSize: 500,
  embeddingChunkOverlap: 50,
};

const mockModels = [
  { name: 'qwen3.5' },
  { name: 'llama3' },
  { name: 'mistral' },
];

const mockStatus: {
  connected: boolean;
  provider: string;
  ollamaBaseUrl: string;
  openaiBaseUrl: string;
  embeddingModel: string;
  error?: string;
} = {
  connected: true,
  provider: 'ollama',
  ollamaBaseUrl: 'http://localhost:11434',
  openaiBaseUrl: 'https://api.openai.com/v1',
  embeddingModel: 'nomic-embed-text',
};

describe('LlmTab (OllamaTab)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setUserRole('admin');
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockFetchResponses(overrides?: {
    status?: typeof mockStatus;
    models?: typeof mockModels | Error;
    settings?: typeof mockSettings;
    adminSettings?: typeof mockAdminSettings;
  }) {
    const status = overrides?.status ?? mockStatus;
    const models = overrides?.models;
    const settings = overrides?.settings ?? mockSettings;
    const adminSettings = overrides?.adminSettings ?? mockAdminSettings;

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

      if (path.includes('/api/admin/settings')) {
        return new Response(JSON.stringify(adminSettings), {
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

  it('hides the LLM tab for non-admin users', async () => {
    setUserRole('user');
    mockFetchResponses();
    render(<SettingsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.queryByTestId('tab-ollama')).not.toBeInTheDocument();
    });
  });

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

  it('shows embedding model with helper text', async () => {
    mockFetchResponses();
    render(<SettingsPage />, { wrapper: createWrapper() });
    await navigateToLlmTab();

    await waitFor(() => {
      expect(screen.getByText(/Shared across all users/)).toBeInTheDocument();
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

  it('shows test connection button', async () => {
    mockFetchResponses();
    render(<SettingsPage />, { wrapper: createWrapper() });
    await navigateToLlmTab();

    await waitFor(() => {
      expect(screen.getByTestId('llm-test-btn')).toBeInTheDocument();
      expect(screen.getByTestId('llm-test-btn').textContent).toBe('Test Connection');
    });
  });

  it('shows success when test connection succeeds', async () => {
    mockFetchResponses();
    render(<SettingsPage />, { wrapper: createWrapper() });
    await navigateToLlmTab();

    await waitFor(() => {
      expect(screen.getByTestId('llm-test-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('llm-test-btn'));

    await waitFor(() => {
      const result = screen.getByTestId('llm-test-result');
      expect(result).toBeInTheDocument();
      expect(result.textContent).toContain('Connected to');
    });
  });

  it('shows error when test connection fails', async () => {
    mockFetchResponses({
      status: {
        connected: false,
        error: 'Connection refused',
        provider: 'ollama',
        ollamaBaseUrl: 'http://localhost:11434',
        openaiBaseUrl: 'https://api.openai.com/v1',
        embeddingModel: 'nomic-embed-text',
      },
    });
    render(<SettingsPage />, { wrapper: createWrapper() });
    await navigateToLlmTab();

    await waitFor(() => {
      expect(screen.getByTestId('llm-test-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('llm-test-btn'));

    await waitFor(() => {
      const result = screen.getByTestId('llm-test-result');
      expect(result).toBeInTheDocument();
      expect(result.textContent).toContain('Connection refused');
    });
  });

  it('clears test result when switching providers', async () => {
    mockFetchResponses();
    render(<SettingsPage />, { wrapper: createWrapper() });
    await navigateToLlmTab();

    await waitFor(() => {
      expect(screen.getByTestId('llm-test-btn')).toBeInTheDocument();
    });

    // Test connection first
    fireEvent.click(screen.getByTestId('llm-test-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('llm-test-result')).toBeInTheDocument();
    });

    // Switch provider - result should clear
    fireEvent.click(screen.getByTestId('provider-openai-btn'));
    expect(screen.queryByTestId('llm-test-result')).not.toBeInTheDocument();
  });

  it('shows OpenAI API key configured status', async () => {
    mockFetchResponses({
      adminSettings: {
        ...mockAdminSettings,
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

describe('EmbeddingTab (admin-only chunk settings)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setUserRole('admin');
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockFetchForEmbeddingTab(adminSettingsOverride?: Partial<typeof mockAdminSettings>) {
    const adminSettings = { ...mockAdminSettings, ...adminSettingsOverride };
    fetchSpy.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      const path = typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;

      if (path.includes('/api/admin/settings')) {
        if (init?.method === 'PUT') {
          return new Response(JSON.stringify({ message: 'Admin settings updated' }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify(adminSettings), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (path.includes('/api/ollama/status')) {
        return new Response(JSON.stringify(mockStatus), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (path.includes('/api/ollama/models')) {
        return new Response(JSON.stringify(mockModels), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (path.includes('/api/settings')) {
        return new Response(JSON.stringify(mockSettings), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    });
  }

  async function navigateToEmbeddingTab() {
    await waitFor(() => {
      expect(screen.queryByText('Loading settings...')).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('tab-embedding'));
  }

  it('renders chunk size input with default value from admin settings', async () => {
    mockFetchForEmbeddingTab();
    render(<SettingsPage />, { wrapper: createWrapper() });
    await navigateToEmbeddingTab();

    await waitFor(() => {
      const input = screen.getByTestId('admin-chunk-size-input') as HTMLInputElement;
      expect(input).toBeInTheDocument();
      expect(input.value).toBe('500');
    });
  });

  it('renders chunk overlap input with default value from admin settings', async () => {
    mockFetchForEmbeddingTab();
    render(<SettingsPage />, { wrapper: createWrapper() });
    await navigateToEmbeddingTab();

    await waitFor(() => {
      const input = screen.getByTestId('admin-chunk-overlap-input') as HTMLInputElement;
      expect(input).toBeInTheDocument();
      expect(input.value).toBe('50');
    });
  });

  it('renders chunk size input with non-default value from admin settings', async () => {
    mockFetchForEmbeddingTab({ embeddingChunkSize: 256, embeddingChunkOverlap: 32 });
    render(<SettingsPage />, { wrapper: createWrapper() });
    await navigateToEmbeddingTab();

    await waitFor(() => {
      const sizeInput = screen.getByTestId('admin-chunk-size-input') as HTMLInputElement;
      expect(sizeInput.value).toBe('256');
      const overlapInput = screen.getByTestId('admin-chunk-overlap-input') as HTMLInputElement;
      expect(overlapInput.value).toBe('32');
    });
  });

  it('shows warning banner when chunk size is changed from saved value', async () => {
    mockFetchForEmbeddingTab();
    render(<SettingsPage />, { wrapper: createWrapper() });
    await navigateToEmbeddingTab();

    await waitFor(() => {
      expect(screen.getByTestId('admin-chunk-size-input')).toBeInTheDocument();
    });

    // Warning should not be visible initially
    expect(screen.queryByTestId('admin-chunk-change-warning')).not.toBeInTheDocument();

    // Change chunk size
    fireEvent.change(screen.getByTestId('admin-chunk-size-input'), { target: { value: '256' } });

    // Warning should now appear
    expect(screen.getByTestId('admin-chunk-change-warning')).toBeInTheDocument();
  });

  it('shows warning banner when chunk overlap is changed from saved value', async () => {
    mockFetchForEmbeddingTab();
    render(<SettingsPage />, { wrapper: createWrapper() });
    await navigateToEmbeddingTab();

    await waitFor(() => {
      expect(screen.getByTestId('admin-chunk-overlap-input')).toBeInTheDocument();
    });

    expect(screen.queryByTestId('admin-chunk-change-warning')).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId('admin-chunk-overlap-input'), { target: { value: '25' } });

    expect(screen.getByTestId('admin-chunk-change-warning')).toBeInTheDocument();
  });

  it('does not show warning banner when chunk values are unchanged', async () => {
    mockFetchForEmbeddingTab();
    render(<SettingsPage />, { wrapper: createWrapper() });
    await navigateToEmbeddingTab();

    await waitFor(() => {
      expect(screen.getByTestId('admin-chunk-size-input')).toBeInTheDocument();
    });

    // Change and then revert
    fireEvent.change(screen.getByTestId('admin-chunk-size-input'), { target: { value: '256' } });
    expect(screen.getByTestId('admin-chunk-change-warning')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('admin-chunk-size-input'), { target: { value: '500' } });
    expect(screen.queryByTestId('admin-chunk-change-warning')).not.toBeInTheDocument();
  });

  it('includes chunk settings in PUT /admin/settings payload', async () => {
    const putCalls: Array<{ url: string; body: string }> = [];

    fetchSpy.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      const path = typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;

      if (path.includes('/api/admin/settings')) {
        if (init?.method === 'PUT') {
          putCalls.push({ url: path, body: init.body as string });
          return new Response(JSON.stringify({ message: 'Admin settings updated' }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify(mockAdminSettings), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (path.includes('/api/settings')) {
        return new Response(JSON.stringify(mockSettings), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (path.includes('/api/ollama/status')) {
        return new Response(JSON.stringify(mockStatus), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (path.includes('/api/ollama/models')) {
        return new Response(JSON.stringify(mockModels), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    });

    render(<SettingsPage />, { wrapper: createWrapper() });
    await navigateToEmbeddingTab();

    await waitFor(() => {
      expect(screen.getByTestId('admin-chunk-size-input')).toBeInTheDocument();
    });

    // Change chunk size then save
    fireEvent.change(screen.getByTestId('admin-chunk-size-input'), { target: { value: '256' } });
    fireEvent.click(screen.getByTestId('admin-chunk-save-btn'));

    await waitFor(() => {
      expect(putCalls).toHaveLength(1);
    });

    const payload = JSON.parse(putCalls[0].body);
    expect(payload.embeddingChunkSize).toBe(256);
    expect(payload.embeddingChunkOverlap).toBeUndefined(); // only changed field is sent
  });
});
