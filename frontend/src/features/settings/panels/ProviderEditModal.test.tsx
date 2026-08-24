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
});
