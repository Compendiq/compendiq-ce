import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SpaceSettingsPage } from './SpaceSettingsPage';

const space = { key: 'NOTES', name: 'My Notes', description: 'Original', icon: null, pageCount: 0, createdBy: null, createdAt: '2026-01-01T00:00:00Z', source: 'local' };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function renderPage(key = 'NOTES') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/spaces/${key}/settings`]}><Routes><Route path="/spaces/:key/settings" element={<SpaceSettingsPage />} /></Routes></MemoryRouter></QueryClientProvider>);
  return client;
}

afterEach(() => vi.restoreAllMocks());

describe('local space read states', () => {
  it('loads, reports a failure and retries to a real list', async () => {
    const { promise, resolve } = Promise.withResolvers<Response>();
    const retry = Promise.withResolvers<Response>();
    const fetch = vi.spyOn(globalThis, 'fetch').mockReturnValueOnce(promise).mockReturnValueOnce(retry.promise);
    renderPage();
    expect(screen.getByRole('status')).toHaveTextContent('Loading local spaces');
    expect(screen.queryByText(/Space not found/)).not.toBeInTheDocument();
    await act(async () => resolve(response({ error: 'unavailable' }, 500)));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load local spaces');
    expect(screen.queryByText(/Space not found/)).not.toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Try again' });
    button.focus();
    fireEvent.click(button);
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveTextContent('Trying again');
    fireEvent.click(button);
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(async () => retry.resolve(response([space])));
    expect(await screen.findByLabelText('Space Name')).toHaveValue('My Notes');
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(document.activeElement).toHaveClass('max-w-lg');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('reports missing only after a successful list excludes the key', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response([space]));
    renderPage('MISSING');
    expect(await screen.findByText('Space not found or is not a local space.')).toBeInTheDocument();
  });

  it('keeps unsaved edits through failed and successful refetches', async () => {
    const retry = Promise.withResolvers<Response>();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response([space])).mockResolvedValueOnce(response({ error: 'unavailable' }, 500)).mockReturnValueOnce(retry.promise);
    const client = renderPage();
    const name = await screen.findByLabelText('Space Name');
    fireEvent.change(name, { target: { value: 'Unsaved name' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Unsaved description' } });
    await act(async () => { await client.refetchQueries({ queryKey: ['local-spaces'] }); });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not refresh');
    expect(name).toHaveValue('Unsaved name');
    const button = screen.getByRole('button', { name: 'Try again' });
    button.focus();
    fireEvent.click(button);
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    name.focus();
    await act(async () => retry.resolve(response([{ ...space, name: 'Changed remotely', pageCount: 1 }])));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(name).toHaveFocus();
    expect(name).toHaveValue('Unsaved name');
    expect(screen.getByLabelText('Description')).toHaveValue('Unsaved description');
  });
});
