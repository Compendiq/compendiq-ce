import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SpaceHomePicker } from './SpaceHomePicker';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

interface FetchCall {
  url: string;
  init?: RequestInit;
}

// Tracks every fetch the component makes so individual tests can assert
// the body of the PUT /spaces/:key/home request.
function mockFetch(handler: (call: FetchCall) => unknown) {
  const calls: FetchCall[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const call: FetchCall = { url: String(url), init };
    calls.push(call);
    const body = handler(call);
    return new Response(JSON.stringify(body ?? {}), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return calls;
}

describe('SpaceHomePicker (#379)', () => {
  beforeEach(() => {
    // The default permission response is "allowed" — individual tests
    // override this when they need to exercise the disabled path.
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a disabled trigger when the user lacks manage permission', async () => {
    mockFetch((call) => {
      if (call.url.includes('/permissions/check')) return { allowed: false };
      return {};
    });

    render(
      <SpaceHomePicker spaceKey="DEV" resolvedHomePageId={null} customHomePageId={null} />,
      { wrapper: createWrapper() },
    );

    const trigger = await screen.findByTestId('space-home-picker-trigger-DEV');
    await waitFor(() => expect(trigger).toBeDisabled());
    expect(trigger).toHaveAttribute('aria-disabled', 'true');
  });

  it('renders an enabled trigger when the user can manage the space', async () => {
    mockFetch((call) => {
      if (call.url.includes('/permissions/check')) return { allowed: true };
      return {};
    });

    render(
      <SpaceHomePicker spaceKey="DEV" resolvedHomePageId={null} customHomePageId={null} />,
      { wrapper: createWrapper() },
    );

    const trigger = await screen.findByTestId('space-home-picker-trigger-DEV');
    await waitFor(() => expect(trigger).not.toBeDisabled());
  });

  it('reflects the "custom override set" state on the trigger', async () => {
    mockFetch((call) => {
      if (call.url.includes('/permissions/check')) return { allowed: true };
      return {};
    });

    render(
      <SpaceHomePicker spaceKey="DEV" resolvedHomePageId="42" customHomePageId={42} />,
      { wrapper: createWrapper() },
    );

    const trigger = await screen.findByTestId('space-home-picker-trigger-DEV');
    await waitFor(() => expect(trigger).toHaveTextContent(/custom home set/i));
  });

  it('PUTs the chosen page id when a search result is clicked', async () => {
    const calls = mockFetch((call) => {
      if (call.url.includes('/permissions/check')) return { allowed: true };
      if (call.url.includes('/search')) {
        return {
          items: [
            {
              id: 999,
              title: 'Welcome page',
              excerpt: '',
              source: 'confluence',
              spaceKey: 'DEV',
              score: 1,
            },
          ],
          total: 1,
        };
      }
      if (call.url.includes('/spaces/DEV/home')) {
        return { spaceKey: 'DEV', customHomePageId: 999 };
      }
      return {};
    });

    render(
      <SpaceHomePicker spaceKey="DEV" resolvedHomePageId={null} customHomePageId={null} />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(await screen.findByTestId('space-home-picker-trigger-DEV'));

    const search = await screen.findByTestId('space-home-picker-search-DEV');
    fireEvent.change(search, { target: { value: 'wel' } });

    const result = await screen.findByTestId('space-home-picker-result-999');
    fireEvent.click(result);

    await waitFor(() => {
      const put = calls.find((c) => c.init?.method === 'PUT');
      expect(put).toBeTruthy();
      expect(put!.url).toContain('/spaces/DEV/home');
      expect(JSON.parse(put!.init!.body as string)).toEqual({ homePageId: 999 });
    });
  });

  it('PUTs homePageId: null when "Use Confluence default" is clicked', async () => {
    const calls = mockFetch((call) => {
      if (call.url.includes('/permissions/check')) return { allowed: true };
      if (call.url.includes('/spaces/DEV/home')) {
        return { spaceKey: 'DEV', customHomePageId: null };
      }
      return {};
    });

    render(
      <SpaceHomePicker
        spaceKey="DEV"
        resolvedHomePageId="42"
        customHomePageId={42}
      />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(await screen.findByTestId('space-home-picker-trigger-DEV'));
    fireEvent.click(await screen.findByTestId('space-home-picker-reset-DEV'));

    await waitFor(() => {
      const put = calls.find((c) => c.init?.method === 'PUT');
      expect(put).toBeTruthy();
      expect(put!.url).toContain('/spaces/DEV/home');
      expect(JSON.parse(put!.init!.body as string)).toEqual({ homePageId: null });
    });
  });

  it('disables "Use Confluence default" when no override is set', async () => {
    mockFetch((call) => {
      if (call.url.includes('/permissions/check')) return { allowed: true };
      return {};
    });

    render(
      <SpaceHomePicker spaceKey="DEV" resolvedHomePageId={null} customHomePageId={null} />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(await screen.findByTestId('space-home-picker-trigger-DEV'));
    const reset = await screen.findByTestId('space-home-picker-reset-DEV');
    expect(reset).toBeDisabled();
  });

  it('scopes the search to the current space (forwards spaceKey to /search)', async () => {
    const calls = mockFetch((call) => {
      if (call.url.includes('/permissions/check')) return { allowed: true };
      if (call.url.includes('/search')) return { items: [], total: 0 };
      return {};
    });

    render(
      <SpaceHomePicker spaceKey="OPS" resolvedHomePageId={null} customHomePageId={null} />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(await screen.findByTestId('space-home-picker-trigger-OPS'));
    const search = await screen.findByTestId('space-home-picker-search-OPS');
    fireEvent.change(search, { target: { value: 'foo' } });

    await waitFor(() => {
      const searchCall = calls.find((c) => c.url.includes('/search'));
      expect(searchCall?.url).toContain('spaceKey=OPS');
      expect(searchCall?.url).toMatch(/q=foo/);
    });
  });
});
