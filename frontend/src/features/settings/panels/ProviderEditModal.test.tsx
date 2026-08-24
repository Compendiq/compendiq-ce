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

describe('ProviderEditModal — dismissal & focus', () => {
  beforeEach(() => {
    useAuthStore.getState().setAuth('test-token', { id: '1', username: 'admin', role: 'admin' });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    useAuthStore.getState().clearAuth();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    const Wrapper = createWrapper();
    render(<ProviderEditModal mode="create" open onClose={onClose} onSaved={() => {}} />, { wrapper: Wrapper });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when the backdrop is clicked', () => {
    const onClose = vi.fn();
    const Wrapper = createWrapper();
    render(<ProviderEditModal mode="create" open onClose={onClose} onSaved={() => {}} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByTestId('provider-modal-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close when the dialog body is clicked', () => {
    const onClose = vi.fn();
    const Wrapper = createWrapper();
    render(<ProviderEditModal mode="create" open onClose={onClose} onSaved={() => {}} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('focuses the name field when opened', () => {
    const Wrapper = createWrapper();
    render(<ProviderEditModal mode="create" open onClose={() => {}} onSaved={() => {}} />, { wrapper: Wrapper });
    expect(screen.getByLabelText(/name/i)).toHaveFocus();
  });
});

function presetSelect() {
  return screen.getByRole('combobox', { name: /^preset$/i }) as HTMLSelectElement;
}

function baseUrlInput() {
  return screen.getByLabelText(/base url/i) as HTMLInputElement;
}

function defaultModelInput() {
  return screen.getByLabelText(/default model/i) as HTMLInputElement;
}

function apiKeyInput() {
  return screen.getByLabelText(/api key/i) as HTMLInputElement;
}

describe('ProviderEditModal — presets', () => {
  beforeEach(() => {
    useAuthStore.getState().setAuth('test-token', { id: '1', username: 'admin', role: 'admin' });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    useAuthStore.getState().clearAuth();
  });

  it('lists the closed D6 preset set, defaulting to Custom', () => {
    const Wrapper = createWrapper();
    render(<ProviderEditModal mode="create" open onClose={() => {}} onSaved={() => {}} />, { wrapper: Wrapper });
    const options = Array.from(presetSelect().options).map((o) => o.textContent);
    expect(options).toEqual([
      'OpenAI',
      'DeepSeek',
      'Groq',
      'Mistral',
      'OpenRouter',
      'Together',
      'Fireworks',
      'Azure OpenAI',
      'Custom',
    ]);
    expect(presetSelect().value).toBe('custom');
  });

  it('fills OpenAI URL, bearer auth, and suggested model', () => {
    const Wrapper = createWrapper();
    render(<ProviderEditModal mode="create" open onClose={() => {}} onSaved={() => {}} />, { wrapper: Wrapper });
    fireEvent.change(presetSelect(), { target: { value: 'openai' } });
    expect(baseUrlInput().value).toBe('https://api.openai.com/v1');
    expect((screen.getByRole('radio', { name: /bearer/i }) as HTMLInputElement).checked).toBe(true);
    expect(defaultModelInput().value).toBe('gpt-4.1-mini');
  });

  it('fills DeepSeek URL, bearer auth, and deepseek-chat', () => {
    const Wrapper = createWrapper();
    render(<ProviderEditModal mode="create" open onClose={() => {}} onSaved={() => {}} />, { wrapper: Wrapper });
    fireEvent.change(presetSelect(), { target: { value: 'deepseek' } });
    expect(baseUrlInput().value).toBe('https://api.deepseek.com/v1');
    expect((screen.getByRole('radio', { name: /bearer/i }) as HTMLInputElement).checked).toBe(true);
    expect(defaultModelInput().value).toBe('deepseek-chat');
  });

  it('fills Groq URL and leaves the model empty until listed', () => {
    const Wrapper = createWrapper();
    render(<ProviderEditModal mode="create" open onClose={() => {}} onSaved={() => {}} />, { wrapper: Wrapper });
    fireEvent.change(presetSelect(), { target: { value: 'groq' } });
    expect(baseUrlInput().value).toBe('https://api.groq.com/openai/v1');
    expect(defaultModelInput().value).toBe('');
  });

  it('keeps Azure URL empty and names the resource host in helper copy', () => {
    const Wrapper = createWrapper();
    render(<ProviderEditModal mode="create" open onClose={() => {}} onSaved={() => {}} />, { wrapper: Wrapper });
    fireEvent.change(presetSelect(), { target: { value: 'azure-openai' } });
    expect(baseUrlInput().value).toBe('');
    expect(screen.getByText(/\{resource\}\.openai\.azure\.com/)).toBeTruthy();
  });

  it('preserves the local placeholder and helper on Custom', () => {
    const Wrapper = createWrapper();
    render(<ProviderEditModal mode="create" open onClose={() => {}} onSaved={() => {}} />, { wrapper: Wrapper });
    expect(baseUrlInput().placeholder).toBe('http://host.docker.internal:1234/v1');
    expect(screen.getByText(/host\.docker\.internal:1234\/v1/)).toBeTruthy();
    expect(screen.getByText(/LM Studio, vLLM/)).toBeTruthy();
  });

  it('does not send a vendor field when saving a filled OpenAI preset', async () => {
    const onSaved = vi.fn();
    const Wrapper = createWrapper();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(savedProvider), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    render(<ProviderEditModal mode="create" open onClose={() => {}} onSaved={onSaved} />, { wrapper: Wrapper });
    fireEvent.change(presetSelect(), { target: { value: 'openai' } });
    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: 'Prod OpenAI' } });
    fireEvent.change(apiKeyInput(), { target: { value: 'sk-test-not-a-real-key' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      name: 'Prod OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      authType: 'bearer',
      verifySsl: true,
      defaultModel: 'gpt-4.1-mini',
      apiKey: 'sk-test-not-a-real-key',
    });
    expect(body).not.toHaveProperty('vendor');
  });

  it('does not overwrite a typed URL until the operator confirms', () => {
    const Wrapper = createWrapper();
    render(<ProviderEditModal mode="create" open onClose={() => {}} onSaved={() => {}} />, { wrapper: Wrapper });
    fireEvent.change(baseUrlInput(), { target: { value: 'http://localhost:11434/v1' } });
    fireEvent.change(presetSelect(), { target: { value: 'openai' } });
    expect(baseUrlInput().value).toBe('http://localhost:11434/v1');
    expect(screen.getByTestId('preset-overwrite-confirm')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /keep current/i }));
    expect(baseUrlInput().value).toBe('http://localhost:11434/v1');
    expect(presetSelect().value).toBe('custom');
    expect(screen.queryByTestId('preset-overwrite-confirm')).toBeNull();
  });

  it('replaces a typed URL after confirm and never clears a typed API key', () => {
    const Wrapper = createWrapper();
    render(<ProviderEditModal mode="create" open onClose={() => {}} onSaved={() => {}} />, { wrapper: Wrapper });
    fireEvent.change(baseUrlInput(), { target: { value: 'http://localhost:11434/v1' } });
    fireEvent.change(apiKeyInput(), { target: { value: 'sk-keep-me' } });
    fireEvent.change(presetSelect(), { target: { value: 'deepseek' } });
    fireEvent.click(screen.getByRole('button', { name: /use preset/i }));
    expect(baseUrlInput().value).toBe('https://api.deepseek.com/v1');
    expect(defaultModelInput().value).toBe('deepseek-chat');
    expect(apiKeyInput().value).toBe('sk-keep-me');
    expect(screen.queryByTestId('preset-overwrite-confirm')).toBeNull();
  });

  it('does not overwrite a typed model without confirm', () => {
    const Wrapper = createWrapper();
    render(<ProviderEditModal mode="create" open onClose={() => {}} onSaved={() => {}} />, { wrapper: Wrapper });
    fireEvent.change(defaultModelInput(), { target: { value: 'qwen3:4b' } });
    fireEvent.change(presetSelect(), { target: { value: 'openai' } });
    expect(defaultModelInput().value).toBe('qwen3:4b');
    fireEvent.click(screen.getByRole('button', { name: /keep current/i }));
    expect(defaultModelInput().value).toBe('qwen3:4b');
  });

  it('applies a second preset without confirm when fields still match the last fill', () => {
    const Wrapper = createWrapper();
    render(<ProviderEditModal mode="create" open onClose={() => {}} onSaved={() => {}} />, { wrapper: Wrapper });
    fireEvent.change(presetSelect(), { target: { value: 'openai' } });
    fireEvent.change(presetSelect(), { target: { value: 'deepseek' } });
    expect(screen.queryByTestId('preset-overwrite-confirm')).toBeNull();
    expect(baseUrlInput().value).toBe('https://api.deepseek.com/v1');
    expect(defaultModelInput().value).toBe('deepseek-chat');
  });

  it('does not steal focus from the preset select when confirm appears', () => {
    const Wrapper = createWrapper();
    render(<ProviderEditModal mode="create" open onClose={() => {}} onSaved={() => {}} />, { wrapper: Wrapper });
    fireEvent.change(baseUrlInput(), { target: { value: 'http://localhost:11434/v1' } });
    presetSelect().focus();
    fireEvent.change(presetSelect(), { target: { value: 'openai' } });
    expect(screen.getByTestId('preset-overwrite-confirm')).toBeTruthy();
    expect(presetSelect()).toHaveFocus();
  });

  it('returns focus to the preset select after Keep current from the confirm buttons', () => {
    const Wrapper = createWrapper();
    render(<ProviderEditModal mode="create" open onClose={() => {}} onSaved={() => {}} />, { wrapper: Wrapper });
    fireEvent.change(baseUrlInput(), { target: { value: 'http://localhost:11434/v1' } });
    fireEvent.change(presetSelect(), { target: { value: 'openai' } });
    const keep = screen.getByRole('button', { name: /keep current/i });
    keep.focus();
    fireEvent.click(keep);
    expect(screen.queryByTestId('preset-overwrite-confirm')).toBeNull();
    expect(presetSelect()).toHaveFocus();
  });

  it('returns focus to the preset select after Use preset from the confirm buttons', () => {
    const Wrapper = createWrapper();
    render(<ProviderEditModal mode="create" open onClose={() => {}} onSaved={() => {}} />, { wrapper: Wrapper });
    fireEvent.change(baseUrlInput(), { target: { value: 'http://localhost:11434/v1' } });
    fireEvent.change(presetSelect(), { target: { value: 'deepseek' } });
    const usePreset = screen.getByRole('button', { name: /use preset/i });
    usePreset.focus();
    fireEvent.click(usePreset);
    expect(baseUrlInput().value).toBe('https://api.deepseek.com/v1');
    expect(presetSelect()).toHaveFocus();
  });

  it('labels the overwrite confirm as a group with a heading, not a live status, and does not make Use preset primary', () => {
    const Wrapper = createWrapper();
    render(<ProviderEditModal mode="create" open onClose={() => {}} onSaved={() => {}} />, { wrapper: Wrapper });
    fireEvent.change(baseUrlInput(), { target: { value: 'http://localhost:11434/v1' } });
    fireEvent.change(presetSelect(), { target: { value: 'openai' } });
    const confirm = screen.getByTestId('preset-overwrite-confirm');
    expect(confirm).not.toHaveAttribute('role', 'status');
    expect(screen.getByRole('group', { name: /replace the url or model you typed/i })).toBe(confirm);
    expect(confirm.querySelector('h3')).toBeTruthy();
    expect(screen.getByRole('button', { name: /use preset/i }).className).not.toMatch(/bg-primary/);
  });
});

describe('ProviderEditModal — edit presets', () => {
  beforeEach(() => {
    useAuthStore.getState().setAuth('test-token', { id: '1', username: 'admin', role: 'admin' });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    useAuthStore.getState().clearAuth();
  });

  it('does not overwrite a stored local URL until Use preset', () => {
    const Wrapper = createWrapper();
    const initial = {
      ...savedProvider,
      name: 'Local Ollama',
      baseUrl: 'http://localhost:11434/v1',
      defaultModel: 'qwen3:4b',
      hasApiKey: false,
      keyPreview: null,
    };
    render(
      <ProviderEditModal mode="edit" initial={initial} open onClose={() => {}} onSaved={() => {}} />,
      { wrapper: Wrapper },
    );
    expect(baseUrlInput().value).toBe('http://localhost:11434/v1');
    fireEvent.change(presetSelect(), { target: { value: 'openai' } });
    expect(baseUrlInput().value).toBe('http://localhost:11434/v1');
    expect(defaultModelInput().value).toBe('qwen3:4b');
    expect(screen.getByTestId('preset-overwrite-confirm')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /keep current/i }));
    expect(baseUrlInput().value).toBe('http://localhost:11434/v1');
    expect(presetSelect().value).toBe('custom');
    fireEvent.change(presetSelect(), { target: { value: 'openai' } });
    fireEvent.click(screen.getByRole('button', { name: /use preset/i }));
    expect(baseUrlInput().value).toBe('https://api.openai.com/v1');
    expect(defaultModelInput().value).toBe('gpt-4.1-mini');
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function testConnectionButton() {
  return screen.getByRole('button', { name: /test connection/i });
}

describe('ProviderEditModal — Test connection', () => {
  beforeEach(() => {
    useAuthStore.getState().setAuth('test-token', { id: '1', username: 'admin', role: 'admin' });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    useAuthStore.getState().clearAuth();
  });

  it('success lists models into a select that writes defaultModel, then Save sends that id', async () => {
    const onSaved = vi.fn();
    const Wrapper = createWrapper();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/admin/llm-providers/test') && (init as RequestInit)?.method === 'POST') {
        return jsonResponse({
          connected: true,
          models: ['gpt-4o', 'gpt-4.1-mini'],
          sampleModelsCount: 2,
        });
      }
      return jsonResponse({ ...savedProvider, defaultModel: 'gpt-4o' }, 201);
    });
    render(<ProviderEditModal mode="create" open onClose={() => {}} onSaved={onSaved} />, { wrapper: Wrapper });
    fireEvent.change(presetSelect(), { target: { value: 'openai' } });
    fireEvent.change(apiKeyInput(), { target: { value: 'sk-dummy-not-a-real-key' } });
    fireEvent.click(testConnectionButton());
    const listed = await screen.findByRole('combobox', { name: /listed models/i });
    expect(screen.getByTestId('provider-test-result')).toHaveAttribute('data-state', 'success');
    expect(screen.getByTestId('provider-test-result')).toHaveTextContent(/connected/i);
    fireEvent.change(listed, { target: { value: 'gpt-4o' } });
    expect(defaultModelInput().value).toBe('gpt-4o');
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const saveCall = fetchSpy.mock.calls.find(
      ([url, init]) =>
        String(url).includes('/admin/llm-providers') &&
        !String(url).includes('/test') &&
        (init as RequestInit)?.method === 'POST',
    );
    expect(saveCall).toBeTruthy();
    const body = JSON.parse(String((saveCall![1] as RequestInit).body));
    expect(body.defaultModel).toBe('gpt-4o');
    expect(body).not.toHaveProperty('vendor');
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('/admin/llm-usecases'))).toBe(false);
  });

  it('401 shows a sanitized bad-key failure and never echoes the API key', async () => {
    const Wrapper = createWrapper();
    const key = 'sk-secret-should-never-render';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/admin/llm-providers/test') && (init as RequestInit)?.method === 'POST') {
        return jsonResponse({
          connected: false,
          error: 'The API key was rejected. Check the key and try again.',
          models: [],
          sampleModelsCount: 0,
        });
      }
      return jsonResponse({ message: 'unmocked' }, 404);
    });
    render(<ProviderEditModal mode="create" open onClose={() => {}} onSaved={() => {}} />, { wrapper: Wrapper });
    fireEvent.change(presetSelect(), { target: { value: 'openai' } });
    fireEvent.change(apiKeyInput(), { target: { value: key } });
    fireEvent.click(testConnectionButton());
    const result = screen.getByTestId('provider-test-result');
    await waitFor(() => expect(result).toHaveAttribute('data-state', 'error'));
    expect(result).toHaveTextContent(/api key was rejected/i);
    expect(result).not.toHaveTextContent(key);
    expect(screen.queryByRole('combobox', { name: /listed models/i })).toBeNull();
    expect(document.body.textContent).not.toContain(key);
  });

  it('timeout shows a sanitized unreachable failure, not the raw upstream body', async () => {
    const Wrapper = createWrapper();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/admin/llm-providers/test') && (init as RequestInit)?.method === 'POST') {
        return jsonResponse({
          connected: false,
          error: 'The provider did not respond in time.',
          models: [],
          sampleModelsCount: 0,
        });
      }
      return jsonResponse({ message: 'unmocked' }, 404);
    });
    render(<ProviderEditModal mode="create" open onClose={() => {}} onSaved={() => {}} />, { wrapper: Wrapper });
    fireEvent.change(presetSelect(), { target: { value: 'openai' } });
    fireEvent.change(apiKeyInput(), { target: { value: 'sk-dummy-timeout' } });
    fireEvent.click(testConnectionButton());
    const result = screen.getByTestId('provider-test-result');
    await waitFor(() => expect(result).toHaveAttribute('data-state', 'error'));
    expect(result).toHaveTextContent(/did not respond in time/i);
    expect(result.innerHTML).not.toMatch(/<script/i);
    expect(screen.queryByRole('combobox', { name: /listed models/i })).toBeNull();
  });

  it('keeps the type-one default-model input when the host lists no models, and does not block Save', async () => {
    const onSaved = vi.fn();
    const Wrapper = createWrapper();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/admin/llm-providers/test') && (init as RequestInit)?.method === 'POST') {
        return jsonResponse({ connected: true, models: [], sampleModelsCount: 0 });
      }
      return jsonResponse({ ...savedProvider, defaultModel: 'qwen3:4b' }, 201);
    });
    render(<ProviderEditModal mode="create" open onClose={() => {}} onSaved={onSaved} />, { wrapper: Wrapper });
    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: 'Local vLLM' } });
    fireEvent.change(baseUrlInput(), { target: { value: 'http://host.docker.internal:1234/v1' } });
    fireEvent.click(screen.getByRole('radio', { name: /none/i }));
    fireEvent.click(testConnectionButton());
    await waitFor(() =>
      expect(screen.getByTestId('provider-test-result')).toHaveAttribute('data-state', 'success'),
    );
    expect(screen.queryByRole('combobox', { name: /listed models/i })).toBeNull();
    fireEvent.change(defaultModelInput(), { target: { value: 'qwen3:4b' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('edit mode with a stored key tests via providerId and does not require re-pasting the secret', async () => {
    const Wrapper = createWrapper();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/admin/llm-providers/test') && (init as RequestInit)?.method === 'POST') {
        return jsonResponse({ connected: true, models: ['mistral-small'], sampleModelsCount: 1 });
      }
      return jsonResponse(savedProvider);
    });
    const initial = {
      ...savedProvider,
      name: 'Existing',
      baseUrl: 'https://api.mistral.ai/v1',
      hasApiKey: true,
      keyPreview: 'sk-****abcd',
    };
    render(
      <ProviderEditModal mode="edit" initial={initial} open onClose={() => {}} onSaved={() => {}} />,
      { wrapper: Wrapper },
    );
    expect(screen.getByText(/configured/i)).toBeTruthy();
    expect(screen.getByText(/sk-\*\*\*\*abcd/)).toBeTruthy();
    fireEvent.click(testConnectionButton());
    await screen.findByRole('combobox', { name: /listed models/i });
    const testCall = fetchSpy.mock.calls.find(
      ([url, init]) => String(url).includes('/admin/llm-providers/test') && (init as RequestInit)?.method === 'POST',
    );
    const body = JSON.parse(String((testCall![1] as RequestInit).body));
    expect(body.providerId).toBe(initial.id);
    expect(body.apiKey).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/sk-/);
  });

  it('does not enable Test connection until bearer auth has a key (or a stored one)', () => {
    const Wrapper = createWrapper();
    render(<ProviderEditModal mode="create" open onClose={() => {}} onSaved={() => {}} />, { wrapper: Wrapper });
    fireEvent.change(presetSelect(), { target: { value: 'openai' } });
    expect(testConnectionButton()).toBeDisabled();
    fireEvent.change(apiKeyInput(), { target: { value: 'sk-dummy' } });
    expect(testConnectionButton()).not.toBeDisabled();
  });

  it('Custom local URL with auth none can test without a key', () => {
    const Wrapper = createWrapper();
    render(<ProviderEditModal mode="create" open onClose={() => {}} onSaved={() => {}} />, { wrapper: Wrapper });
    fireEvent.change(baseUrlInput(), { target: { value: 'http://localhost:11434/v1' } });
    fireEvent.click(screen.getByRole('radio', { name: /none/i }));
    expect(testConnectionButton()).not.toBeDisabled();
  });

  it('names D4 on a hosted preset: saving does not assign embedding / rerank / image_embedding', () => {
    const Wrapper = createWrapper();
    render(<ProviderEditModal mode="create" open onClose={() => {}} onSaved={() => {}} />, { wrapper: Wrapper });
    fireEvent.change(presetSelect(), { target: { value: 'openai' } });
    expect(screen.getByText(/do not assign/i).textContent).toMatch(/embedding/i);
    expect(screen.getByText(/do not assign/i).textContent).toMatch(/rerank/i);
    expect(screen.getByText(/do not assign/i).textContent).toMatch(/image embedding/i);
  });

  it('keeps a live status region for the dialog life and announces listed models in it', async () => {
    const Wrapper = createWrapper();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/admin/llm-providers/test') && (init as RequestInit)?.method === 'POST') {
        return jsonResponse({
          connected: true,
          models: ['gpt-4o', 'gpt-4.1-mini'],
          sampleModelsCount: 2,
        });
      }
      return jsonResponse({ message: 'unmocked' }, 404);
    });
    render(<ProviderEditModal mode="create" open onClose={() => {}} onSaved={() => {}} />, { wrapper: Wrapper });
    const status = screen.getByTestId('provider-test-result');
    expect(status).toHaveAttribute('role', 'status');
    expect(status).toHaveTextContent('');
    fireEvent.change(presetSelect(), { target: { value: 'openai' } });
    fireEvent.change(apiKeyInput(), { target: { value: 'sk-dummy' } });
    fireEvent.click(testConnectionButton());
    await waitFor(() => expect(status).toHaveTextContent(/connected/i));
    expect(status).toHaveTextContent(/2 models listed/i);
    expect(status.querySelector('select')).toBeNull();
    expect(screen.getByRole('combobox', { name: /listed models/i })).toBeTruthy();
  });

  it('ignores a stale Test connection after the URL or key changes', async () => {
    const Wrapper = createWrapper();
    let finishFirst: ((value: Response) => void) | undefined;
    const first = new Promise<Response>((resolve) => {
      finishFirst = resolve;
    });
    let testCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/admin/llm-providers/test') && (init as RequestInit)?.method === 'POST') {
        testCalls += 1;
        if (testCalls === 1) return first;
        return jsonResponse({ connected: true, models: ['qwen3:4b'], sampleModelsCount: 1 });
      }
      return jsonResponse({ message: 'unmocked' }, 404);
    });
    render(<ProviderEditModal mode="create" open onClose={() => {}} onSaved={() => {}} />, { wrapper: Wrapper });
    fireEvent.change(presetSelect(), { target: { value: 'openai' } });
    fireEvent.change(apiKeyInput(), { target: { value: 'sk-dummy' } });
    fireEvent.click(testConnectionButton());
    await waitFor(() => expect(baseUrlInput()).toBeDisabled());
    expect(apiKeyInput()).toBeDisabled();
    fireEvent.change(baseUrlInput(), { target: { value: 'http://localhost:11434/v1' } });
    finishFirst!(
      jsonResponse({
        connected: true,
        models: ['gpt-4o-from-first-host'],
        sampleModelsCount: 1,
      }),
    );
    await waitFor(() => expect(testConnectionButton()).not.toBeDisabled());
    expect(screen.queryByRole('combobox', { name: /listed models/i })).toBeNull();
    expect(screen.queryByText('gpt-4o-from-first-host')).toBeNull();
    expect(screen.getByTestId('provider-test-result')).not.toHaveTextContent(/connected/i);
  });
});
