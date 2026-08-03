import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

const mockApiFetch = vi.fn();
vi.mock('../../../shared/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/lib/api')>()),
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

import { ChatVisionCapability } from './ChatVisionCapability';

const CAPABILITY_URL = '/admin/llm-usecases/chat/vision-capability';
const REPROBE_URL = '/admin/llm-usecases/chat/reprobe-vision';

const PROVIDER_ID = '11111111-1111-4111-8111-111111111111';

function capability(overrides: Record<string, unknown> = {}) {
  return {
    providerId: PROVIDER_ID,
    model: 'qwen2.5vl',
    vision: false,
    probedAt: '2026-08-01T09:30:00.000Z',
    probeError: 'chat HTTP 415: {"error":"image_url is not supported"}',
    ...overrides,
  };
}

function renderStrip(vision: boolean | null = false) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const utils = render(
    <QueryClientProvider client={qc}>
      <ChatVisionCapability vision={vision} />
    </QueryClientProvider>,
  );
  return { ...utils, qc };
}

beforeEach(() => {
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  mockApiFetch.mockReset().mockImplementation(async (path: string) => {
    if (path === CAPABILITY_URL) return capability();
    if (path === REPROBE_URL) return capability({ vision: true, probeError: null });
    return {};
  });
});

describe('ChatVisionCapability — when it was last checked (#1184)', () => {
  it('shows when the verdict was probed', async () => {
    renderStrip();
    const stamp = await screen.findByTestId('vision-probed-at');
    // Relative for scanning, exact stamp on hover — a `true` verdict probed
    // months ago has to read as old at a glance.
    expect(stamp).toHaveAttribute('title', expect.stringContaining('2026'));
  });

  /**
   * `probed_at` is shown for every verdict, not just the non-`true` ones, so a
   * stale "Vision" badge is visible as stale.
   */
  it('shows the timestamp for a positive verdict too', async () => {
    mockApiFetch.mockImplementation(async (path: string) =>
      path === CAPABILITY_URL ? capability({ vision: true, probeError: null }) : {},
    );
    renderStrip(true);
    expect(await screen.findByTestId('vision-probed-at')).toBeInTheDocument();
  });

  it('says so when the pair has never been probed', async () => {
    mockApiFetch.mockImplementation(async (path: string) =>
      path === CAPABILITY_URL ? capability({ vision: null, probedAt: null, probeError: null }) : {},
    );
    renderStrip(null);
    expect(await screen.findByTestId('vision-probed-at')).toHaveTextContent(/never/i);
  });
});

describe('ChatVisionCapability — the probe error disclosure (#1184)', () => {
  it('keeps the probe error behind a closed disclosure', async () => {
    renderStrip();
    const disclosure = await screen.findByTestId('vision-probe-error');
    expect(disclosure).not.toHaveAttribute('open');
    expect(screen.getByTestId('vision-probe-error-text')).toHaveTextContent(
      'image_url is not supported',
    );
  });

  /**
   * The probe error is third-party text from the provider. React escapes by
   * default; this test exists so a future "render it nicely" refactor via
   * `dangerouslySetInnerHTML` or a Markdown renderer fails loudly.
   */
  it('renders the probe error as text, never as markup', async () => {
    mockApiFetch.mockImplementation(async (path: string) =>
      path === CAPABILITY_URL
        ? capability({ probeError: '<img src=x onerror="alert(1)"><b>bold</b>' })
        : {},
    );
    renderStrip();

    const text = await screen.findByTestId('vision-probe-error-text');
    expect(text.querySelector('img')).toBeNull();
    expect(text.querySelector('b')).toBeNull();
    expect(text).toHaveTextContent('<img src=x onerror="alert(1)"><b>bold</b>');
  });

  it('omits the disclosure when there is no stored error', async () => {
    mockApiFetch.mockImplementation(async (path: string) =>
      path === CAPABILITY_URL ? capability({ vision: true, probeError: null }) : {},
    );
    renderStrip(true);

    await screen.findByTestId('vision-probed-at');
    expect(screen.queryByTestId('vision-probe-error')).not.toBeInTheDocument();
  });
});

describe('ChatVisionCapability — re-check (#1184)', () => {
  it('posts to the re-probe route', async () => {
    renderStrip();
    fireEvent.click(await screen.findByTestId('vision-recheck'));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(REPROBE_URL, { method: 'POST' }),
    );
  });

  /**
   * The re-probe is a synchronous LLM round-trip through the queue and the
   * per-provider breaker — it can take many seconds. The control must say so
   * and must not be clickable twice.
   */
  it('shows a pending state and blocks a second click while probing', async () => {
    let release: (v: unknown) => void = () => {};
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === CAPABILITY_URL) return capability();
      return new Promise((resolve) => {
        release = resolve;
      });
    });

    renderStrip();
    const button = await screen.findByTestId('vision-recheck');
    fireEvent.click(button);

    await waitFor(() => expect(button).toBeDisabled());
    expect(button).toHaveTextContent(/checking/i);

    fireEvent.click(button);
    const posts = mockApiFetch.mock.calls.filter(([p]) => p === REPROBE_URL);
    expect(posts).toHaveLength(1);

    release(capability({ vision: true, probeError: null }));
    await waitFor(() => expect(button).toBeEnabled());
  });

  /**
   * Matches LlmTab's save handler: the resolved-default consumers (the AI chat
   * pane's model selector) and the assignments document both hold a verdict
   * this click may have just changed.
   */
  it('invalidates the assignments and resolved-default caches on success', async () => {
    const { qc } = renderStrip();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    fireEvent.click(await screen.findByTestId('vision-recheck'));

    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['llm-usecases'] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['llm', 'usecase-default'] });
    });
  });

  it('reports the new verdict', async () => {
    renderStrip();
    fireEvent.click(await screen.findByTestId('vision-recheck'));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it('surfaces a failed re-check without losing the control', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === CAPABILITY_URL) return capability();
      throw new Error('Rate limit exceeded');
    });

    renderStrip();
    const button = await screen.findByTestId('vision-recheck');
    fireEvent.click(button);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Rate limit exceeded'));
    expect(button).toBeEnabled();
  });
});
