import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientInferenceTab } from './ClientInferenceTab';

const apiFetch = vi.fn();

vi.mock('../../../shared/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

vi.mock('../../../shared/lib/client-inference/client-inference-manager', () => ({
  getClientInferenceManager: () => ({
    lastProbe: () => null,
    lastErrorCategory: () => null,
  }),
}));

function renderTab(): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ClientInferenceTab />
    </QueryClientProvider>,
  );
  return queryClient;
}

const missingOnnx = {
  enabled: false,
  activeModelId: null,
  models: [{
    id: 'qwen2.5-0.5b-instruct-q4',
    kind: 'onnx' as const,
    bytes: 0,
    installed: false,
    available: false,
    files: [],
  }],
};

const installedOnnx = {
  enabled: true,
  activeModelId: 'onnx-community--Qwen2.5-0.5B-Instruct',
  models: [{
    id: 'onnx-community--Qwen2.5-0.5B-Instruct',
    kind: 'onnx' as const,
    bytes: 10,
    installed: true,
    available: true,
    files: [],
    repo: 'onnx-community/Qwen2.5-0.5B-Instruct',
    active: true,
  }],
};

describe('ClientInferenceTab', () => {
  beforeEach(() => {
    apiFetch.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('disables the enable switch until an ONNX model is installed', async () => {
    apiFetch.mockImplementation(async (path: string) => {
      if (path === '/admin/settings') return { clientInferenceEnabled: false };
      if (path === '/models/client-assets') return missingOnnx;
      if (path.startsWith('/admin/client-assets/search')) {
        return { models: [{ repo: 'onnx-community/Qwen2.5-0.5B-Instruct', downloads: 0, likes: 0, recommended: true }] };
      }
      throw new Error(`unexpected ${path}`);
    });
    renderTab();
    const sw = await screen.findByRole('switch', { name: 'Enable on-device suggestions' });
    expect(sw).toHaveAttribute('data-disabled');
    expect(await screen.findByRole('button', { name: 'Download model' })).toBeInTheDocument();
    expect(await screen.findByLabelText('On-device model')).toBeInTheDocument();
  });

  it('invalidates the manifest after the admin flag is saved', async () => {
    apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/admin/settings' && init?.method === 'PUT') return {};
      if (path === '/admin/settings') return { clientInferenceEnabled: false };
      if (path === '/models/client-assets') return installedOnnx;
      if (path.startsWith('/admin/client-assets/search')) {
        return { models: [{ repo: 'onnx-community/Qwen2.5-0.5B-Instruct', downloads: 0, likes: 0, recommended: true }] };
      }
      throw new Error(`unexpected ${path}`);
    });
    const client = renderTab();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    expect(await screen.findByText(/Settings → Editor/)).toBeInTheDocument();
    const sw = await screen.findByRole('switch', { name: 'Enable on-device suggestions' });
    await waitFor(() => {
      expect(sw).not.toHaveAttribute('data-disabled');
    });
    fireEvent.click(sw);
    await waitFor(() => {
      const keys = invalidate.mock.calls.map((c) => JSON.stringify(c[0]));
      expect(keys.some((k) => k.includes('admin-settings'))).toBe(true);
      expect(keys.some((k) => k.includes('client-assets-manifest'))).toBe(true);
    });
  });

  it('searches Hub and starts a download', async () => {
    apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/admin/settings') return { clientInferenceEnabled: false };
      if (path === '/models/client-assets') return missingOnnx;
      if (path.startsWith('/admin/client-assets/search')) {
        const q = new URL(path, 'http://local').searchParams.get('q');
        if (q === 'smol') {
          return { models: [{ repo: 'HuggingFaceTB/SmolLM2-135M-Instruct', downloads: 1, likes: 0, recommended: true }] };
        }
        return { models: [{ repo: 'onnx-community/Qwen2.5-0.5B-Instruct', downloads: 0, likes: 0, recommended: true }] };
      }
      if (path.startsWith('/admin/client-assets/inspect')) {
        return { repo: 'HuggingFaceTB/SmolLM2-135M-Instruct', hasQ4: true, bytes: 50, ok: true };
      }
      if (path === '/admin/client-assets/install' && init?.method === 'POST') return {};
      if (path === '/admin/client-assets/install') {
        return { status: 'complete', loaded: 50, total: 50, error: null };
      }
      throw new Error(`unexpected ${path} ${init?.method ?? ''}`);
    });
    renderTab();
    const input = await screen.findByLabelText('On-device model');
    fireEvent.change(input, { target: { value: 'smol' } });
    expect(await screen.findByRole('option', { name: /SmolLM2-135M-Instruct/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: /SmolLM2-135M-Instruct/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Download model' }));
    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith('/admin/client-assets/install', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ repo: 'HuggingFaceTB/SmolLM2-135M-Instruct' }),
      }));
    });
  });

  it('says the list could not be read instead of rendering an empty volume', async () => {
    apiFetch.mockImplementation(async (path: string) => {
      if (path === '/admin/settings') return { clientInferenceEnabled: false };
      if (path.startsWith('/admin/client-assets/search')) return { models: [] };
      throw new Error('boom');
    });
    renderTab();
    expect(await screen.findByText(/could not read installed assets/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: /installed assets/i })).not.toBeInTheDocument();
  });

  it('polls install status until complete then refreshes the manifest', async () => {
    let installGets = 0;
    apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/admin/settings') return { clientInferenceEnabled: false };
      if (path === '/models/client-assets') return missingOnnx;
      if (path.startsWith('/admin/client-assets/search')) {
        return { models: [{ repo: 'onnx-community/Qwen2.5-0.5B-Instruct', downloads: 0, likes: 0, recommended: true }] };
      }
      if (path.startsWith('/admin/client-assets/inspect')) {
        return { repo: 'onnx-community/Qwen2.5-0.5B-Instruct', hasQ4: true, bytes: 50, ok: true };
      }
      if (path === '/admin/client-assets/install' && init?.method === 'POST') {
        return { status: 'running', loaded: 0, total: 50, error: null };
      }
      if (path === '/admin/client-assets/install') {
        installGets += 1;
        if (installGets < 2) {
          return { status: 'running', loaded: 10, total: 50, error: null };
        }
        return { status: 'complete', loaded: 50, total: 50, error: null };
      }
      throw new Error(`unexpected ${path} ${init?.method ?? ''}`);
    });
    renderTab();
    fireEvent.click(await screen.findByRole('option', { name: /Qwen2.5-0.5B-Instruct/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Download model' }));
    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith('/admin/client-assets/install', expect.objectContaining({
        method: 'POST',
      }));
    });
    await waitFor(() => {
      expect(installGets).toBeGreaterThan(0);
    });
  });

  it('debounces Hub search until typing settles', async () => {
    apiFetch.mockImplementation(async (path: string) => {
      if (path === '/admin/settings') return { clientInferenceEnabled: false };
      if (path === '/models/client-assets') return missingOnnx;
      if (path.startsWith('/admin/client-assets/search')) {
        return { models: [{ repo: 'onnx-community/Qwen2.5-0.5B-Instruct', downloads: 0, likes: 0, recommended: true }] };
      }
      throw new Error(`unexpected ${path}`);
    });
    renderTab();
    const input = await screen.findByLabelText('On-device model');
    fireEvent.change(input, { target: { value: 'smol' } });
    expect(apiFetch.mock.calls.filter(([p]) => String(p).includes('search?q=smol'))).toHaveLength(0);
    await waitFor(() => {
      expect(apiFetch.mock.calls.some(([p]) => String(p).includes('search?q=smol'))).toBe(true);
    });
  });

  it('says when an upload fails', async () => {
    apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/admin/settings') return { clientInferenceEnabled: false };
      if (path === '/models/client-assets') return missingOnnx;
      if (path.startsWith('/admin/client-assets/search')) return { models: [] };
      if (typeof path === 'string' && path.includes('/files/') && init?.method === 'PUT') {
        throw new Error('disk full');
      }
      throw new Error(`unexpected ${path}`);
    });
    renderTab();
    const input = await screen.findByLabelText('Upload');
    fireEvent.change(input, { target: { files: [new File(['x'], 'config.json')] } });
    expect(await screen.findByText(/disk full/i)).toBeInTheDocument();
  });
});

