import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BulkActionBar, type BulkAiPolicySelection } from './BulkActionBar';
import { useAuthStore } from '../../stores/auth-store';

/**
 * #283 — the Library's bulk AI-policy action at the FETCH boundary: the real
 * `apiFetch`, the real `useBulkUpdateAiPolicy`, a mocked `fetch`. What is
 * pinned is the wire contract (internal numeric page ids + per-row
 * `expectedRevision`, all-or-nothing) and the honest reporting of the
 * server's typed refusals: nothing changed, counts not titles, selection
 * and draft kept.
 */
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function mount(children: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
  return client;
}

const selection: BulkAiPolicySelection = {
  items: [
    { pageId: 11, expectedRevision: 3, aiPolicy: 'all' },
    { pageId: 12, expectedRevision: 0, aiPolicy: 'local_only' },
  ],
  missing: 0,
};

beforeEach(() => {
  useAuthStore.getState().setAuth('test-token', { id: '1', username: 'u', role: 'user' });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useAuthStore.getState().clearAuth();
});

describe('BulkActionBar — AI policy (#283)', () => {
  it('posts the all-or-nothing body with per-row revisions and clears the selection on commit', async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (init?.method === 'POST') {
        posts.push({ url: String(url), body: JSON.parse(String(init.body)) });
        return json({ ok: true });
      }
      return json([]);
    });
    const onClear = vi.fn();
    mount(<BulkActionBar selectedIds={['11', '12']} confluenceCount={0} policySelection={selection} onClear={onClear} />);

    fireEvent.click(screen.getByTestId('bulk-ai-policy-btn'));
    const select = await screen.findByTestId('bulk-ai-policy-select');
    fireEvent.change(select, { target: { value: 'local_only' } });
    fireEvent.click(screen.getByTestId('bulk-ai-policy-apply'));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toContain('/api/pages/bulk/ai-policy');
    expect(posts[0]!.body).toEqual({
      aiPolicy: 'local_only',
      items: [{ pageId: 11, expectedRevision: 3 }, { pageId: 12, expectedRevision: 0 }],
    });
    await waitFor(() => expect(onClear).toHaveBeenCalled());
  });

  it('reports a 403 denial as nothing-changed with a count, keeps the selection, and names no page', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) =>
      init?.method === 'POST' ? json({ error: 'ai_policy_denied', pageIds: [12] }, 403) : json([]));
    const onClear = vi.fn();
    mount(<BulkActionBar selectedIds={['11', '12']} confluenceCount={0} policySelection={selection} onClear={onClear} />);

    fireEvent.click(screen.getByTestId('bulk-ai-policy-btn'));
    fireEvent.change(await screen.findByTestId('bulk-ai-policy-select'), { target: { value: 'all' } });
    fireEvent.click(screen.getByTestId('bulk-ai-policy-apply'));

    const notice = await screen.findByTestId('bulk-ai-policy-notice');
    expect(notice).toHaveTextContent(/^No policy was changed\./);
    expect(notice).toHaveTextContent('1 of the 2 selected pages');
    expect(notice.textContent).not.toMatch(/\b12\b/);
    expect(onClear).not.toHaveBeenCalled();
    // The panel and the chosen draft stay for review.
    expect(screen.getByTestId('bulk-ai-policy-select')).toHaveValue('all');
  });

  it('reports a 409 stale revision without claiming any page changed', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) =>
      init?.method === 'POST' ? json({ error: 'ai_policy_conflict', reason: 'stale_revision', pageIds: [11, 12] }, 409) : json([]));
    mount(<BulkActionBar selectedIds={['11', '12']} confluenceCount={0} policySelection={selection} onClear={vi.fn()} />);

    fireEvent.click(screen.getByTestId('bulk-ai-policy-btn'));
    fireEvent.click(await screen.findByTestId('bulk-ai-policy-apply'));
    const notice = await screen.findByTestId('bulk-ai-policy-notice');
    expect(notice).toHaveTextContent('No policy was changed');
    expect(notice).toHaveTextContent('2 of the 2 selected pages changed since the list was read');
  });

  it('confirms the real no-AI removals before posting', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ ok: true }));
    mount(<BulkActionBar selectedIds={['11', '12']} confluenceCount={0} policySelection={selection} onClear={vi.fn()} />);

    fireEvent.click(screen.getByTestId('bulk-ai-policy-btn'));
    fireEvent.change(await screen.findByTestId('bulk-ai-policy-select'), { target: { value: 'none' } });
    fireEvent.click(screen.getByTestId('bulk-ai-policy-apply'));
    // The confirmation dialog, not the policy panel (which is `aria-modal="false"`).
    const dialog = await screen.findByRole('dialog', { name: /No AI allowed/ });
    expect(dialog).toHaveTextContent('Historical conversations are not erased');
    expect(dialog).toHaveTextContent('cannot be recalled');
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });

  it('refuses to send a partial request when a selected row carries no revision, and says why accessibly', () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ ok: true }));
    mount(
      <BulkActionBar
        selectedIds={['11', '99']}
        confluenceCount={0}
        policySelection={{ items: selection.items.slice(0, 1), missing: 1 }}
        onClear={vi.fn()}
      />,
    );
    const trigger = screen.getByTestId('bulk-ai-policy-btn');
    expect(trigger).toHaveAttribute('aria-disabled', 'true');
    expect(trigger).toHaveAttribute('aria-describedby', 'bulk-ai-policy-unavailable');
    expect(document.getElementById('bulk-ai-policy-unavailable')).toHaveTextContent('1 selected row does not carry a current policy revision');
    fireEvent.click(trigger);
    expect(screen.queryByTestId('bulk-ai-policy-panel')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('is not offered at all when the caller supplies no policy data', () => {
    mount(<BulkActionBar selectedIds={['11']} confluenceCount={0} onClear={vi.fn()} />);
    expect(screen.queryByTestId('bulk-ai-policy-btn')).toBeNull();
  });
});
