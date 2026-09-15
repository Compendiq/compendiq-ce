import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { ImageAnalysisCapabilityDetail, UsecaseAssignment } from '@compendiq/contracts';
import { ImageAnalysisCard } from './ImageAnalysisCard';
import { useAuthStore } from '../../../stores/auth-store';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), message: vi.fn(), warning: vi.fn() },
}));

/**
 * #1615 — the image-analysis strip. What the tests pin is behaviour an admin
 * can observe: which sentence describes egress, that the capability query is
 * gated on the SAVED assignment, the three verdict states, the ceiling row's
 * commit semantics, and that Re-check keeps the keyboard where it was.
 */

const PROVIDER_ID = '22222222-2222-4222-8222-222222222222';
const NIL = '00000000-0000-0000-0000-000000000000';

const assigned: UsecaseAssignment = {
  providerId: PROVIDER_ID,
  model: 'qwen3-vl',
  resolved: { providerId: PROVIDER_ID, providerName: 'RTX3090', model: 'qwen3-vl' },
};
const unassigned: UsecaseAssignment = {
  providerId: null,
  model: null,
  resolved: { providerId: NIL, providerName: '', model: '' },
};

const detail = (over: Partial<ImageAnalysisCapabilityDetail> = {}): ImageAnalysisCapabilityDetail => ({
  providerId: PROVIDER_ID,
  model: 'qwen3-vl',
  vision: true,
  probedAt: '2026-09-15T10:00:00.000Z',
  probeError: null,
  identity: {
    providerId: PROVIDER_ID,
    model: 'qwen3-vl',
    baseUrl: 'http://192.168.178.47:1234/v1',
    identityHash: 'abcdef0123456789'.repeat(4),
    assignedAt: '2026-09-15T10:00:00.000Z',
  },
  identityDrift: false,
  ...over,
});

let capabilityHits: number;
let recheckHits: number;

function mockRoutes(options: {
  capability?: ImageAnalysisCapabilityDetail | 'error';
  recheck?: ImageAnalysisCapabilityDetail;
  recheckDelay?: Promise<void>;
} = {}) {
  capabilityHits = 0;
  recheckHits = 0;
  // Stateful, because the server is: a re-check persists the verdict it
  // produced, so the invalidation the card fires afterwards must read the
  // NEW detail rather than the one it started from.
  let last: ImageAnalysisCapabilityDetail | null = null;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/admin/llm-usecases/image_analysis/capability')) {
      capabilityHits++;
      if (last) return json(last);
      if (options.capability === 'error') return json({ error: 'boom' }, 500);
      return json(options.capability ?? detail());
    }
    if (url.endsWith('/admin/llm-usecases/image_analysis/recheck') && (init as RequestInit).method === 'POST') {
      recheckHits++;
      if (options.recheckDelay) await options.recheckDelay;
      const answer = options.recheck ?? detail({ probedAt: '2026-09-15T11:00:00.000Z' });
      // `reanalyzeRows` is on the re-check answer only; the stored detail has none.
      last = { ...answer };
      delete last.reanalyzeRows;
      return json(answer);
    }
    return json([]);
  });
}

function renderCard(props: { savedAssignment?: UsecaseAssignment; maxOutputTokens?: number; onChange?: (n: number) => void } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onChange = props.onChange ?? vi.fn();
  const utils = render(
    <QueryClientProvider client={qc}>
      <ImageAnalysisCard
        savedAssignment={props.savedAssignment ?? unassigned}
        maxOutputTokens={props.maxOutputTokens ?? 8192}
        onMaxOutputTokensChange={onChange}
      />
    </QueryClientProvider>,
  );
  return { ...utils, qc, onChange };
}

describe('ImageAnalysisCard', () => {
  beforeEach(() => {
    useAuthStore.getState().setAuth('test-token', { id: '1', username: 'admin', role: 'admin' });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    useAuthStore.getState().clearAuth();
  });

  it('unassigned: states that no image leaves the host, renders the ceiling row, and never asks for a verdict', async () => {
    mockRoutes();
    renderCard();
    expect(screen.getByTestId('image-analysis-egress')).toHaveTextContent(/no page image leaves this host/i);
    expect(screen.getByTestId('image-analysis-pause-note')).toHaveTextContent(/pauses new analysis/i);
    expect(screen.queryByTestId('image-analysis-recheck')).not.toBeInTheDocument();
    expect(screen.queryByTestId('vision-badge')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Max output tokens')).toHaveValue(8192);
    // Nothing to wait for: the query is disabled, not merely slow.
    await act(async () => {});
    expect(capabilityHits).toBe(0);
  });

  it('assigned: names the SAVED provider as the recipient and reads the verdict for it', async () => {
    mockRoutes();
    renderCard({ savedAssignment: assigned });
    expect(screen.getByTestId('image-analysis-egress')).toHaveTextContent('Page images are sent to RTX3090 for analysis.');
    expect(await screen.findByTestId('vision-badge')).toHaveTextContent('Vision');
    expect(screen.getByTestId('image-analysis-probed-at')).toHaveTextContent(/^Checked /);
    expect(screen.getByTestId('image-analysis-identity')).toHaveTextContent('qwen3-vl');
    expect(screen.getByTestId('image-analysis-identity')).toHaveTextContent('abcdef012345');
    expect(screen.queryByTestId('image-analysis-identity-drift')).not.toBeInTheDocument();
    expect(screen.queryByTestId('image-analysis-probe-error')).not.toBeInTheDocument();
    expect(capabilityHits).toBe(1);
  });

  it('renders nothing that claims a verdict before the capability query resolves', async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      await hold;
      return new Response(JSON.stringify(detail()), { headers: { 'Content-Type': 'application/json' } });
    });
    renderCard({ savedAssignment: assigned });
    expect(screen.getByTestId('image-analysis-capability-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('vision-badge')).not.toBeInTheDocument();
    // Re-check is live even while the read is out: it is the remedy, not a result.
    expect(screen.getByTestId('image-analysis-recheck')).toBeEnabled();
    release();
    expect(await screen.findByTestId('vision-badge')).toBeInTheDocument();
  });

  it('a failed capability read says so and keeps Re-check live', async () => {
    mockRoutes({ capability: 'error' });
    renderCard({ savedAssignment: assigned });
    expect(await screen.findByTestId('image-analysis-capability-error')).toHaveTextContent(/could not be read/i);
    expect(screen.queryByTestId('vision-badge')).not.toBeInTheDocument();
    expect(screen.getByTestId('image-analysis-recheck')).toBeEnabled();
  });

  it('unconfirmed is explained as not-a-verdict; text-only as a pause; the provider body sits behind a disclosure, escaped', async () => {
    const hostile = 'chat HTTP 401: {"error":"no key for tenant-7 at llm-internal.corp.lan"} <img src=x onerror=alert(1)>';
    mockRoutes({ capability: detail({ vision: null, probedAt: null, probeError: hostile }) });
    const { unmount } = renderCard({ savedAssignment: assigned });
    expect(await screen.findByTestId('vision-badge')).toHaveTextContent('Unconfirmed');
    expect(screen.getByTestId('image-analysis-probed-at')).toHaveTextContent('Never checked');
    expect(screen.getByTestId('image-analysis-unconfirmed-note')).toHaveTextContent(/not evidence the model is text-only/i);
    expect(screen.queryByTestId('image-analysis-text-only-note')).not.toBeInTheDocument();
    const errorText = screen.getByTestId('image-analysis-probe-error-text');
    expect(errorText).toHaveTextContent('tenant-7');
    expect(errorText.querySelector('img')).toBeNull();
    unmount();
    vi.restoreAllMocks();

    mockRoutes({ capability: detail({ vision: false, probeError: 'chat HTTP 415: images not accepted' }) });
    renderCard({ savedAssignment: assigned });
    expect(await screen.findByTestId('vision-badge')).toHaveTextContent('Text-only');
    expect(screen.getByTestId('image-analysis-text-only-note')).toHaveTextContent(/paused until a vision-capable model/i);
    expect(screen.queryByTestId('image-analysis-unconfirmed-note')).not.toBeInTheDocument();
  });

  it('names identity drift and what Re-check will do about it', async () => {
    mockRoutes({ capability: detail({ identityDrift: true }) });
    renderCard({ savedAssignment: assigned });
    const drift = await screen.findByTestId('image-analysis-identity-drift');
    expect(drift).toHaveTextContent(/endpoint has moved/i);
    expect(drift).toHaveTextContent(/Re-check/);
    expect(drift).toHaveAttribute('role', 'status');
  });

  it('Re-check: keeps focus on the button while pending, then seeds the new verdict and toasts it', async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    mockRoutes({
      capability: detail({ vision: null, probeError: 'stale' }),
      recheck: detail({ vision: true, probedAt: '2026-09-15T12:00:00.000Z' }),
      recheckDelay: hold,
    });
    renderCard({ savedAssignment: assigned });
    expect(await screen.findByTestId('vision-badge')).toHaveTextContent('Unconfirmed');

    const button = screen.getByTestId('image-analysis-recheck');
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute('aria-busy', 'true'));
    expect(button).toHaveTextContent('Checking…');
    expect(document.activeElement).toBe(button);

    release();
    await waitFor(() => expect(button).toHaveAttribute('aria-busy', 'false'));
    expect(screen.getByTestId('vision-badge')).toHaveTextContent('Vision');
    expect(screen.queryByTestId('image-analysis-probe-error')).not.toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/confirmed/i));
    expect(toast.warning).not.toHaveBeenCalled();
    expect(recheckHits).toBe(1);
  });

  it('Re-check: a true verdict that adopted a new identity discloses the re-analysis scope in amber', async () => {
    mockRoutes({
      capability: detail({ identityDrift: true }),
      recheck: detail({ identityDrift: false, reanalyzeRows: 17 }),
    });
    renderCard({ savedAssignment: assigned });
    await screen.findByTestId('image-analysis-identity-drift');
    fireEvent.click(screen.getByTestId('image-analysis-recheck'));
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(expect.stringMatching(/^17 image analyses are no longer valid/)));
    expect(toast.success).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('image-analysis-identity-drift')).not.toBeInTheDocument());
  });

  it('Re-check: a negative or inconclusive verdict is an error toast, not a success', async () => {
    mockRoutes({ recheck: detail({ vision: false, probeError: 'chat HTTP 415' }) });
    renderCard({ savedAssignment: assigned });
    await screen.findByTestId('vision-badge');
    fireEvent.click(screen.getByTestId('image-analysis-recheck'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/refused the test image/i)));
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByTestId('vision-badge')).toHaveTextContent('Text-only');
  });

  it('Max output tokens: verbatim while typing, clamped on commit, onChange only on commit', () => {
    mockRoutes();
    const { onChange } = renderCard({ maxOutputTokens: 8192 });
    const input = screen.getByLabelText('Max output tokens');
    fireEvent.change(input, { target: { value: '40' } });
    // The keystroke belongs to the draft: no clamp, no commit.
    expect(input).toHaveValue(40);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(4096);

    fireEvent.change(input, { target: { value: '99999' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(16384);

    fireEvent.change(input, { target: { value: '6000' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith(6000);
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('Max output tokens: the help copy is the ADR\'s, described by the input, with the reset offered only off-default', () => {
    mockRoutes();
    const { rerender, qc } = renderCard({ maxOutputTokens: 8192 });
    const input = screen.getByLabelText('Max output tokens');
    const help = document.getElementById(input.getAttribute('aria-describedby')!)!;
    expect(help).toHaveTextContent('Changing it never re-analyzes an image');
    expect(help.querySelector('button, a, input, select')).toBeNull();
    expect(screen.queryByTestId('image-analysis-imageAnalysisMaxOutputTokens-reset')).not.toBeInTheDocument();

    rerender(
      <QueryClientProvider client={qc}>
        <ImageAnalysisCard savedAssignment={unassigned} maxOutputTokens={6000} onMaxOutputTokensChange={() => {}} />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId('image-analysis-imageAnalysisMaxOutputTokens-reset')).toHaveTextContent('Reset to default (8192)');
  });
});
