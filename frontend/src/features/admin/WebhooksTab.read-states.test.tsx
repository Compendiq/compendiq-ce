import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, domMax } from 'framer-motion';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnterpriseProvider } from '../../shared/enterprise/context';
import { WebhooksTab } from './WebhooksTab';

const row = { id: 'wh_1', label: 'Example endpoint', url: 'https://example.com/hook', eventTypes: ['page.created'], active: true, secretHint: 'abcd', hasSecondarySecret: false, secretSecondaryAddedAt: null, createdAt: '2026-04-01T00:00:00.000Z', updatedAt: '2026-04-01T00:00:00.000Z' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function setup(list: () => Promise<Response>, features = ['webhook_push']) {
  const requests: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    requests.push(`${init?.method ?? 'GET'} ${url}`);
    if (url === '/api/admin/license') return json({ edition: 'enterprise', valid: true, features });
    if (url === '/api/admin/webhooks') return list();
    if (url.includes('/deliveries?limit=1')) return json({ deliveries: [] });
    return json({ message: 'Unexpected request' }, 404);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><EnterpriseProvider><LazyMotion features={domMax}><WebhooksTab /></LazyMotion></EnterpriseProvider></QueryClientProvider>);
  return { client, requests };
}

describe('webhook list read states', () => {
  it('keeps the retry focused while pending and recovers to an actual empty result', async () => {
    const { promise, resolve } = Promise.withResolvers<Response>();
    let count = 0;
    setup(() => ++count === 1 ? Promise.resolve(json({ message: 'Unavailable' }, 500)) : promise);
    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(screen.queryByTestId('webhooks-empty')).not.toBeInTheDocument();
    expect(screen.getByTestId('webhooks-signing-notice')).toBeInTheDocument();
    retry.focus();
    fireEvent.click(retry);
    expect(screen.getByRole('button', { name: 'Retrying…' })).toHaveAttribute('aria-disabled', 'true');
    expect(retry).toHaveFocus();
    fireEvent.click(retry);
    expect(count).toBe(2);
    await act(async () => { resolve(json({ subscriptions: [] })); });
    await screen.findByTestId('webhooks-empty');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Webhook endpoints' })).toHaveFocus());
    expect(screen.queryByTestId('webhooks-read-error')).not.toBeInTheDocument();
  });

  it('retains loaded rows when a refresh fails and recovers on retry', async () => {
    let count = 0;
    const { client } = setup(async () => ++count === 2 ? json({ message: 'Unavailable' }, 500) : json({ subscriptions: [row] }));
    await screen.findByText('Example endpoint');
    await act(async () => { await client.invalidateQueries({ queryKey: ['admin', 'webhooks'] }); });
    expect(screen.getByText('Example endpoint')).toBeInTheDocument();
    expect(screen.getByTestId('webhooks-read-error')).toHaveTextContent('Showing the last loaded list');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByTestId('webhooks-read-error')).not.toBeInTheDocument());
    expect(screen.getByText('Example endpoint')).toBeInTheDocument();
  });

  it('does not request the list without the feature', async () => {
    const { requests } = setup(async () => json({ subscriptions: [] }), []);
    await waitFor(() => expect(requests).toContain('GET /api/admin/license'));
    expect(screen.getByTestId('webhooks-not-licensed')).toBeInTheDocument();
    expect(requests).not.toContain('GET /api/admin/webhooks');
  });
});
