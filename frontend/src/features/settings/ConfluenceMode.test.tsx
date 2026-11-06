import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Toaster } from 'sonner';
import { SettingsLayout } from './SettingsLayout';
import { SettingsPanelRoute } from './SettingsPanelRoute';
import { useAuthStore } from '../../stores/auth-store';

const clients: QueryClient[] = [];
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

function settingsServer(initial: boolean | undefined) {
  let enabled = initial;
  const writes: Array<{ body: Record<string, unknown>; resolve: (response: Response) => void }> = [];
  let holdReads = false;
  const reads: Array<(response: Response) => void> = [];
  const currentSettings = () => ({ confluenceEnabled: enabled, confluenceUrl: 'https://confluence.example.test', hasConfluencePat: true });
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === '/api/settings' && init?.method === 'PUT') {
      const { promise, resolve } = Promise.withResolvers<Response>();
      writes.push({ body: JSON.parse(String(init.body)), resolve });
      return promise;
    }
    if (url === '/api/settings') {
      if (holdReads) {
        const { promise, resolve } = Promise.withResolvers<Response>();
        reads.push(resolve);
        return promise;
      }
      return reply(currentSettings());
    }
    if (url === '/api/settings/test-confluence') return reply({ success: true, message: 'Connected (fixture)' });
    throw new Error(`Unexpected network request: ${url}`);
  });
  return {
    writes,
    fetch,
    reads,
    holdReads() { holdReads = true; },
    async settleRead(index: number, success = true) {
      await act(async () => {
        reads[index](success ? reply(currentSettings()) : reply({ error: 'Confirmation unavailable (fixture)' }, 500));
      });
    },
    setConfirmed(value: boolean) { enabled = value; },
    async acknowledge(index: number) {
      // The write already committed; only its HTTP response was delayed.
      await act(async () => { writes[index].resolve(reply({ success: true })); });
    },
    async settle(index: number, success: boolean) {
      await act(async () => {
        const write = writes[index];
        if (success && typeof write.body.confluenceEnabled === 'boolean') enabled = write.body.confluenceEnabled;
        write.resolve(success ? reply({ success: true }) : reply({ error: 'Mode save rejected (fixture)' }, 500));
      });
    },
  };
}

function openSettings(client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })) {
  clients.push(client);
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/settings/personal/confluence']}>
        <Routes>
          <Route path="/settings" element={<SettingsLayout />}>
            <Route path=":category/:item" element={<SettingsPanelRoute />} />
          </Route>
        </Routes>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  );
  return { ...view, client };
}

beforeEach(() => {
  useAuthStore.setState({ user: { id: 'mode-test-user', username: 'mode-test', role: 'user' }, accessToken: 'fixture-token', isAuthenticated: true });
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  useAuthStore.setState({ user: null, accessToken: null, isAuthenticated: false });
  vi.restoreAllMocks();
});

describe('Confluence mode through the real settings route and mutation', () => {
  it.each([false, true])('keeps confirmed %s through a failed save, then permits a successful retry', async (initial) => {
    const server = settingsServer(initial);
    openSettings();
    const control = await screen.findByRole('switch', { name: 'Sync with Confluence' });
    control.focus();
    fireEvent.click(control);
    fireEvent.click(control);
    await waitFor(() => expect(server.writes).toHaveLength(1));
    expect(server.writes[0].body).toEqual({ confluenceEnabled: !initial });
    expect(control).toHaveAttribute('aria-checked', String(initial));
    expect(control).toHaveAttribute('aria-disabled', 'true');
    expect(control).not.toBeDisabled();
    expect(control).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent('Saving mode');
    expect(screen.queryByText('Settings saved')).not.toBeInTheDocument();
    expect(Boolean(screen.queryByLabelText('Confluence URL'))).toBe(initial);

    await server.settle(0, false);
    await waitFor(() => expect(control).toHaveAttribute('aria-disabled', 'false'));
    expect(control).toHaveAttribute('aria-checked', String(initial));
    expect(screen.getByRole('status')).toHaveTextContent('Could not save the mode');
    expect(Boolean(screen.queryByLabelText('Confluence URL'))).toBe(initial);
    expect(screen.queryByText('Settings saved')).not.toBeInTheDocument();

    fireEvent.click(control);
    await waitFor(() => expect(server.writes).toHaveLength(2));
    await server.settle(1, true);
    await waitFor(() => expect(control).toHaveAttribute('aria-checked', String(!initial)));
    expect(control).toHaveAttribute('aria-disabled', 'false');
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(Boolean(screen.queryByLabelText('Confluence URL'))).toBe(!initial);
    expect(await screen.findByText('Settings saved')).toBeInTheDocument();
    expect(server.fetch.mock.calls.every(([url]) => String(url) === '/api/settings')).toBe(true);
  });

  it.each([false, true])('blocks further writes while confirming a change from %s', async (initial) => {
    const server = settingsServer(initial);
    openSettings();
    const control = await screen.findByRole('switch');
    server.holdReads();
    control.focus();
    fireEvent.click(control);
    await waitFor(() => expect(server.writes).toHaveLength(1));
    await server.settle(0, true);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Confirming the current mode'));
    expect(server.reads).toHaveLength(1);
    expect(control).toHaveAttribute('aria-disabled', 'true');
    expect(control).toHaveAttribute('aria-checked', String(initial));
    expect(control).toHaveFocus();
    expect(Boolean(screen.queryByLabelText('Confluence URL'))).toBe(initial);
    fireEvent.click(control);
    expect(server.writes).toHaveLength(1);
    await server.settleRead(0);
    await waitFor(() => expect(control).toHaveAttribute('aria-disabled', 'false'));
    expect(control).toHaveAttribute('aria-checked', String(!initial));
    expect(Boolean(screen.queryByLabelText('Confluence URL'))).toBe(!initial);
    fireEvent.click(control);
    await waitFor(() => expect(server.writes[1]?.body).toEqual({ confluenceEnabled: initial }));
    await server.settle(1, true);
    await waitFor(() => expect(server.reads).toHaveLength(2));
    await server.settleRead(1);
    await waitFor(() => expect(control).toHaveAttribute('aria-disabled', 'false'));
  });

  it.each([false, true])('keeps confirmed %s locked after failed confirmation and retries only the read', async (initial) => {
    const server = settingsServer(initial);
    openSettings();
    const control = await screen.findByRole('switch');
    server.holdReads();
    fireEvent.click(control);
    await waitFor(() => expect(server.writes).toHaveLength(1));
    await server.settle(0, true);
    await waitFor(() => expect(server.reads).toHaveLength(1));
    await server.settleRead(0, false);
    const retry = await screen.findByRole('button', { name: 'Retry confirmation' });
    expect(screen.getByRole('status')).toHaveTextContent('Mode was saved, but the current mode could not be read');
    expect(control).toHaveAttribute('aria-checked', String(initial));
    expect(control).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(control);
    expect(server.writes).toHaveLength(1);
    retry.focus();
    fireEvent.click(retry);
    fireEvent.click(retry);
    await waitFor(() => expect(server.reads).toHaveLength(2));
    expect(retry).toHaveTextContent('Retrying confirmation');
    expect(retry).toHaveAttribute('aria-disabled', 'true');
    expect(retry).not.toBeDisabled();
    expect(retry).toHaveFocus();
    await server.settleRead(1, false);
    await waitFor(() => expect(retry).toHaveAttribute('aria-disabled', 'false'));
    expect(retry).toHaveFocus();
    fireEvent.click(retry);
    await waitFor(() => expect(server.reads).toHaveLength(3));
    await server.settleRead(2);
    await waitFor(() => expect(control).toHaveAttribute('aria-disabled', 'false'));
    expect(control).toHaveAttribute('aria-checked', String(!initial));
    expect(control).toHaveFocus();
    expect(screen.queryByRole('button', { name: /Retry.*confirmation/ })).not.toBeInTheDocument();
    expect(server.writes).toHaveLength(1);
  });

  it('reads a missing legacy flag as enabled and writes explicit false', async () => {
    const server = settingsServer(undefined);
    openSettings();
    const control = await screen.findByRole('switch');
    expect(control).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(control);
    await waitFor(() => expect(server.writes[0]?.body).toEqual({ confluenceEnabled: false }));
    await server.settle(0, true);
    await waitFor(() => expect(control).toHaveAttribute('aria-checked', 'false'));
  });

  it('does not restore an old snapshot over a newer confirmed settings read on failure', async () => {
    const server = settingsServer(true);
    const { client } = openSettings();
    const control = await screen.findByRole('switch');
    fireEvent.click(control);
    await waitFor(() => expect(server.writes).toHaveLength(1));
    server.setConfirmed(false);
    await act(async () => { await client.invalidateQueries({ queryKey: ['settings'] }); });
    await waitFor(() => expect(control).toHaveAttribute('aria-checked', 'false'));
    await server.settle(0, false);
    await waitFor(() => expect(control).toHaveAttribute('aria-disabled', 'false'));
    expect(control).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByLabelText('Confluence URL')).not.toBeInTheDocument();
  });

  it.each([false, true])('keeps a newer confirmed %s when an older successful response arrives late', async (latest) => {
    const server = settingsServer(latest);
    const { client } = openSettings();
    const control = await screen.findByRole('switch');
    fireEvent.click(control);
    await waitFor(() => expect(server.writes[0]?.body).toEqual({ confluenceEnabled: !latest }));

    // The first PUT commits, but its response is held. Another writer then
    // commits the opposite choice before this tab reads settings again.
    server.setConfirmed(!latest);
    server.setConfirmed(latest);
    await act(async () => { await client.invalidateQueries({ queryKey: ['settings'] }); });
    expect(control).toHaveAttribute('aria-checked', String(latest));
    expect(control).toHaveAttribute('aria-disabled', 'true');

    await server.acknowledge(0);
    await waitFor(() => expect(control).toHaveAttribute('aria-disabled', 'false'));
    expect(control).toHaveAttribute('aria-checked', String(latest));
    expect(Boolean(screen.queryByLabelText('Confluence URL'))).toBe(latest);
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('keeps a newer confirmed choice when an older request fails after leaving and reopening settings', async () => {
    const server = settingsServer(true);
    const first = openSettings();
    fireEvent.click(await screen.findByRole('switch'));
    await waitFor(() => expect(server.writes).toHaveLength(1));
    first.unmount();
    openSettings(first.client);
    const control = await screen.findByRole('switch');
    fireEvent.click(control);
    await waitFor(() => expect(server.writes).toHaveLength(2));
    await server.settle(1, true);
    await waitFor(() => expect(control).toHaveAttribute('aria-checked', 'false'));
    await server.settle(0, false);
    expect(control).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByLabelText('Confluence URL')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('retains credential drafts when their now-awaitable save rejects', async () => {
    const server = settingsServer(true);
    openSettings();
    const pat = await screen.findByLabelText(/Personal Access Token/);
    fireEvent.change(pat, { target: { value: 'synthetic-draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test Connection' }));
    const save = screen.getByRole('button', { name: 'Save' });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    await waitFor(() => expect(server.writes).toHaveLength(1));
    expect(server.writes[0].body).toEqual({ confluenceUrl: 'https://confluence.example.test', confluencePat: 'synthetic-draft' });
    await server.settle(0, false);
    expect(pat).toHaveValue('synthetic-draft');
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByText('Settings saved')).not.toBeInTheDocument();
  });
});
