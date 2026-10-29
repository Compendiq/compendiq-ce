import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, domMax } from 'framer-motion';
import { toast } from 'sonner';
import { ConfluenceStep } from './ConfluenceStep';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const A = { url: 'https://setup-a.example.invalid', pat: 'synthetic-setup-a' };
const B = { url: 'https://setup-b.example.invalid', pat: 'synthetic-setup-b' };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function deferredResponse(body: unknown) {
  const response = Promise.withResolvers<Response>();
  return {
    body,
    promise: response.promise,
    async respond(payload: unknown = {}, status = 200) {
      await act(async () => { response.resolve(json(payload, status)); });
    },
  };
}

/** Only the HTTP boundary is replaced; the real form, API client and picker run. */
function boundary({ holdSaves = false, holdSpaces = false } = {}) {
  const saves: ReturnType<typeof deferredResponse>[] = [];
  const probes: ReturnType<typeof deferredResponse>[] = [];
  const spaces: ReturnType<typeof deferredResponse>[] = [];
  let persisted: Record<string, unknown> = {};
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === '/api/settings' && init?.method === 'PUT') {
      const save = deferredResponse(JSON.parse(init.body as string));
      saves.push(save);
      const response = holdSaves ? await save.promise : json({});
      if (response.ok) persisted = { ...persisted, ...save.body as object };
      return response;
    }
    if (url === '/api/settings/test-confluence') {
      const probe = deferredResponse(JSON.parse(init?.body as string));
      probes.push(probe);
      return probe.promise;
    }
    if (url === '/api/spaces/available') {
      const discovery = deferredResponse({ ...persisted });
      spaces.push(discovery);
      return holdSpaces ? discovery.promise : json([]);
    }
    if (url === '/api/sync/status') return json({ userId: 'setup-user', status: 'idle' });
    if (url === '/api/spaces') return json([]);
    throw new Error(`Unexpected synthetic setup request: ${init?.method ?? 'GET'} ${url}`);
  });
  return { saves, probes, spaces, persisted: () => persisted };
}

function mountStep(queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
})) {
  const onNext = vi.fn();
  const onBack = vi.fn();
  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <LazyMotion features={domMax}>
          <ConfluenceStep onNext={onNext} onBack={onBack} />
        </LazyMotion>
      </QueryClientProvider>,
    ),
    onNext,
    onBack,
    queryClient,
  };
}

function enter(pair = A) {
  fireEvent.change(screen.getByLabelText('Confluence Base URL'), { target: { value: pair.url } });
  fireEvent.change(screen.getByLabelText('Personal Access Token (PAT)'), { target: { value: pair.pat } });
}

function testConnection() {
  fireEvent.click(screen.getByRole('button', { name: 'Test Connection' }));
}

function expectUnverified() {
  expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  expect(screen.queryByTestId('space-sync-panel')).not.toBeInTheDocument();
  expect(screen.queryByTestId('confluence-test-result')).not.toBeInTheDocument();
}

afterEach(() => { vi.restoreAllMocks(); });

describe('setup credential identity (#1807)', () => {
  it.each(['url', 'pat'] as const)('discards success after editing %s, then persists and verifies the new exact pair', async (field) => {
    const api = boundary();
    const view = mountStep();
    enter();
    testConnection();
    await waitFor(() => expect(api.probes).toHaveLength(1));
    const current = { ...A, [field]: B[field] };
    enter(current);
    await api.probes[0]!.respond({ success: true });
    expectUnverified();
    expect(api.spaces).toHaveLength(0);
    expect(toast.success).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(view.onNext).not.toHaveBeenCalled();

    testConnection();
    await waitFor(() => expect(api.probes).toHaveLength(2));
    expect(api.probes[1]!.body).toEqual(current);
    expect(api.persisted()).toEqual({
      confluenceUrl: current.url, confluencePat: current.pat, confluenceEnabled: true,
    });
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await api.probes[1]!.respond({ success: true });
    await waitFor(() => expect(api.spaces).toHaveLength(1));
    expect(api.spaces[0]!.body).toEqual(api.persisted());
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(view.onNext).toHaveBeenCalledTimes(1);
  });

  it('does not resurrect verification when edits return to the original values', async () => {
    const api = boundary();
    mountStep();
    enter();
    testConnection();
    await waitFor(() => expect(api.probes).toHaveLength(1));
    enter(B);
    enter(A);
    await api.probes[0]!.respond({ success: true });
    expectUnverified();
    expect(api.spaces).toHaveLength(0);
  });

  it.each([
    { success: true, status: 200 },
    { success: false, status: 200 },
    { success: false, status: 500 },
  ])('ignores an older completion ($success/$status) while the newer probe is pending', async ({ success, status }) => {
    const api = boundary();
    mountStep();
    enter();
    testConnection();
    await waitFor(() => expect(api.probes).toHaveLength(1));
    enter(B);
    testConnection();
    await waitFor(() => expect(api.probes).toHaveLength(2));
    await api.probes[0]!.respond({ success, message: 'Old synthetic verdict' }, status);
    expectUnverified();
    expect(screen.getByRole('button', { name: 'Testing...' })).toBeDisabled();
    expect(api.spaces).toHaveLength(0);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    await api.probes[1]!.respond({ success: true });
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it('keeps a newer failure authoritative when an older success arrives last', async () => {
    const api = boundary();
    mountStep();
    enter();
    testConnection();
    await waitFor(() => expect(api.probes).toHaveLength(1));
    enter(B);
    testConnection();
    await waitFor(() => expect(api.probes).toHaveLength(2));
    await api.probes[1]!.respond({ success: false, message: 'Current pair refused' });
    await api.probes[0]!.respond({ success: true });
    expect(screen.getByTestId('confluence-test-result')).toHaveTextContent('Connection failed');
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    expect(api.spaces).toHaveLength(0);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('Current pair refused');
  });

  it('keeps a newer success authoritative when an older error arrives last', async () => {
    const api = boundary();
    mountStep();
    enter();
    testConnection();
    await waitFor(() => expect(api.probes).toHaveLength(1));
    enter(B);
    testConnection();
    await waitFor(() => expect(api.probes).toHaveLength(2));
    await api.probes[1]!.respond({ success: true });
    await api.probes[0]!.respond({ message: 'Old synthetic failure' }, 500);
    expect(screen.getByTestId('confluence-test-result')).toHaveTextContent('Connection successful');
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('serializes saves and skips the superseded probe after editing during persistence', async () => {
    const api = boundary({ holdSaves: true });
    mountStep();
    enter();
    testConnection();
    await waitFor(() => expect(api.saves).toHaveLength(1));
    enter(B);
    testConnection();
    expect(api.saves).toHaveLength(1);
    await api.saves[0]!.respond();
    await waitFor(() => expect(api.saves).toHaveLength(2));
    expect(api.probes).toHaveLength(0);
    expectUnverified();
    await api.saves[1]!.respond();
    await waitFor(() => expect(api.probes).toHaveLength(1));
    expect(api.probes[0]!.body).toEqual(B);
    await api.probes[0]!.respond({ success: true });
    expect(api.persisted().confluenceUrl).toBe(B.url);
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it('does not probe or discover spaces when persistence fails', async () => {
    const api = boundary({ holdSaves: true });
    mountStep();
    enter();
    testConnection();
    await waitFor(() => expect(api.saves).toHaveLength(1));
    await api.saves[0]!.respond({ message: 'Synthetic save failure' }, 500);
    expect(screen.getByTestId('confluence-test-result')).toHaveTextContent('Connection failed');
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    expect(api.probes).toHaveLength(0);
    expect(api.spaces).toHaveLength(0);
  });

  it.each(['back', 'unmount', 'standalone'] as const)('discards a pending probe on %s navigation', async (navigation) => {
    const api = boundary();
    const view = mountStep();
    enter();
    testConnection();
    await waitFor(() => expect(api.probes).toHaveLength(1));
    if (navigation === 'unmount') view.unmount();
    else fireEvent.click(screen.getByRole('button', {
      name: navigation === 'back' ? 'Back' : 'Use Standalone Mode',
    }));
    await api.probes[0]!.respond({ success: true });
    if (navigation !== 'unmount') expectUnverified();
    expect(api.spaces).toHaveLength(0);
    expect(toast.success).not.toHaveBeenCalled();
    if (navigation === 'back') expect(view.onBack).toHaveBeenCalledTimes(1);
    if (navigation === 'standalone') {
      await waitFor(() => expect(view.onNext).toHaveBeenCalledTimes(1));
      expect(api.persisted().confluenceEnabled).toBe(false);
    }
  });

  it('orders standalone after a pending credential save without starting the obsolete probe', async () => {
    const api = boundary({ holdSaves: true });
    const view = mountStep();
    enter();
    testConnection();
    await waitFor(() => expect(api.saves).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Use Standalone Mode' }));
    expect(api.saves).toHaveLength(1);
    expectUnverified();
    await api.saves[0]!.respond();
    await waitFor(() => expect(api.saves).toHaveLength(2));
    expect(api.saves[1]!.body).toEqual({ confluenceEnabled: false });
    await api.saves[1]!.respond();
    expect(api.probes).toHaveLength(0);
    expect(api.persisted().confluenceEnabled).toBe(false);
    expect(view.onNext).toHaveBeenCalledTimes(1);
  });

  it('keeps writes ordered across unmount and a fresh visit', async () => {
    const api = boundary({ holdSaves: true });
    const first = mountStep();
    enter();
    testConnection();
    await waitFor(() => expect(api.saves).toHaveLength(1));
    first.unmount();
    mountStep(first.queryClient);
    enter(B);
    testConnection();
    expect(api.saves).toHaveLength(1);
    await api.saves[0]!.respond();
    await waitFor(() => expect(api.saves).toHaveLength(2));
    await api.saves[1]!.respond();
    await waitFor(() => expect(api.probes).toHaveLength(1));
    expect(api.probes[0]!.body).toEqual(B);
    await api.probes[0]!.respond({ success: true });
    expect(api.persisted().confluenceUrl).toBe(B.url);
  });

  it('discards the prior pair’s cached and in-flight spaces on a newly verified pair', async () => {
    const api = boundary({ holdSpaces: true });
    const view = mountStep();
    view.queryClient.setQueryData(['spaces', 'available'], [{ key: 'OLD', name: 'Old cached space' }]);
    enter();
    testConnection();
    await waitFor(() => expect(api.probes).toHaveLength(1));
    await api.probes[0]!.respond({ success: true });
    await waitFor(() => expect(api.spaces).toHaveLength(1));
    expect(screen.queryByText('Old cached space')).not.toBeInTheDocument();
    enter(B);
    expectUnverified();
    testConnection();
    await waitFor(() => expect(api.probes).toHaveLength(2));
    await api.probes[1]!.respond({ success: true });
    await waitFor(() => expect(api.spaces).toHaveLength(2));
    await api.spaces[1]!.respond([{ key: 'NEW', name: 'Current pair space', type: 'global' }]);
    await api.spaces[0]!.respond([{ key: 'OLD', name: 'Old delayed space', type: 'global' }]);
    expect(await screen.findByText('Current pair space')).toBeInTheDocument();
    expect(screen.queryByText('Old delayed space')).not.toBeInTheDocument();
  });
});
