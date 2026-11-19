/**
 * Settings → Governance → Article AI policy (#1881) at the network boundary.
 *
 * What this panel must not get wrong: turning enforcement on is refused while
 * the server reports a blocker, every blocker is rendered with its rows and
 * remedy, only the legacy-client blockers can be acknowledged (and the
 * acknowledgement travels in the PUT), a 409 refusal re-renders the blockers
 * the server saw, and turning off is a confirmed, quieter action whose copy
 * says stored restrictions stay enforced.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiPolicyActivationBlocker, AiPolicyActivationState } from '@compendiq/contracts';
import { ArticleAiPolicyActivationTab } from './ArticleAiPolicyActivationTab';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

const READY: AiPolicyActivationState = {
  enabled: false,
  changedAt: null,
  changedBy: null,
  changedByName: null,
  legacyClientsAcknowledged: false,
  ready: true,
  blockers: [],
};

const RUNTIME_BLOCKER: AiPolicyActivationBlocker = {
  code: 'incompatible_ai_policy_runtime',
  overridable: false,
  total: 3,
  runtimes: [
    { runtimeId: 'rt-old-1', host: 'kb-backend-7', pid: 4242, startedAt: '2026-11-01T08:00:00.000Z' },
    { runtimeId: 'rt-old-2', host: null, pid: null, startedAt: '2026-11-02T08:00:00.000Z' },
  ],
};

const LEGACY_USERS_BLOCKER: AiPolicyActivationBlocker = {
  code: 'legacy_clients_active',
  overridable: true,
  users: 2,
  recent: [
    { userId: USER_ID, username: 'mina', lastSeenAt: '2026-11-08T09:30:00.000Z' },
    { userId: ADMIN_ID, username: 'simon', lastSeenAt: '2026-11-08T09:00:00.000Z' },
  ],
  clearsAt: '2026-11-08T10:30:00.000Z',
};

const WINDOW_BLOCKER: AiPolicyActivationBlocker = {
  code: 'legacy_client_window_open',
  overridable: true,
  since: '2026-11-08T09:00:00.000Z',
  clearsAt: '2026-11-08T10:00:30.000Z',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface RouteState {
  activation: AiPolicyActivationState;
  getStatus: number;
  putStatus: number;
  putError?: unknown;
}

let state: RouteState;
let calls: { url: string; method: string; body: unknown }[];

function route(url: string, init?: RequestInit): Response {
  const method = (init?.method ?? 'GET').toUpperCase();
  const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
  calls.push({ url, method, body });

  if (!url.includes('/admin/ai-policy/activation')) return json({});
  if (method === 'GET') {
    return state.getStatus === 200 ? json(state.activation) : json({ error: 'boom' }, state.getStatus);
  }
  if (state.putStatus !== 200) {
    // A refusal is what the server observed under its lock; the next GET
    // reports the same blockers, as the real route would.
    if (state.putStatus === 409) {
      const refusal = state.putError as { blockers: AiPolicyActivationBlocker[] };
      state.activation = { ...state.activation, ready: false, blockers: refusal.blockers };
    }
    return json(state.putError, state.putStatus);
  }
  const enabled = Boolean(body?.enabled);
  state.activation = {
    ...state.activation,
    enabled,
    changedAt: '2026-11-08T10:05:00.000Z',
    changedBy: ADMIN_ID,
    changedByName: 'Simon',
    legacyClientsAcknowledged: enabled && body?.acknowledgeLegacyClients === true,
    ready: true,
    blockers: [],
  };
  return json(state.activation);
}

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <ArticleAiPolicyActivationTab />
    </QueryClientProvider>,
  );
  return { client, ...view };
}

function activationCalls(method: string) {
  return calls.filter((c) => c.method === method && c.url.includes('/admin/ai-policy/activation'));
}

beforeEach(() => {
  calls = [];
  state = { activation: { ...READY }, getStatus: 200, putStatus: 200 };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => route(String(url), init)));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('article AI policy activation panel', () => {
  it('renders every blocker with its rows and remedy, hides the acknowledgement and refuses to turn on', async () => {
    state.activation = {
      ...READY,
      ready: false,
      blockers: [
        RUNTIME_BLOCKER,
        LEGACY_USERS_BLOCKER,
        WINDOW_BLOCKER,
        { code: 'ai_policy_enforcement_not_registered', overridable: false },
        { code: 'ai_policy_readiness_unavailable', overridable: false },
      ],
    };
    renderTab();

    const blockers = await screen.findByTestId('activation-blockers');
    expect(blockers).toHaveAttribute('role', 'status');
    expect(blockers).toHaveTextContent('This deployment is not ready for enforcement.');

    const runtime = within(blockers).getByTestId('blocker-incompatible_ai_policy_runtime');
    expect(runtime).toHaveTextContent('3 backend instances are running a build without AI-policy enforcement.');
    expect(runtime).toHaveTextContent('rt-old-1');
    expect(runtime).toHaveTextContent('kb-backend-7');
    expect(runtime).toHaveTextContent('pid 4242');
    expect(runtime).toHaveTextContent('rt-old-2');
    expect(runtime).toHaveTextContent('unknown host');
    expect(runtime).toHaveTextContent('docs/runbooks/immutable-page-baselines.md');
    expect(runtime).toHaveTextContent('Runtime retirement and fencing');
    expect(runtime).toHaveTextContent('Showing the first 2 of 3');

    const legacy = within(blockers).getByTestId('blocker-legacy_clients_active');
    expect(legacy).toHaveTextContent('2 users signed in from an older build');
    expect(legacy).toHaveTextContent('mina');
    expect(legacy).toHaveTextContent('simon');
    expect(legacy).toHaveTextContent(/last seen/);
    expect(legacy).toHaveTextContent(/clears by itself at/);

    const windowBlocker = within(blockers).getByTestId('blocker-legacy_client_window_open');
    expect(windowBlocker).toHaveTextContent(/observing sign-ins since/);
    expect(windowBlocker).toHaveTextContent(/fresh install/);
    expect(windowBlocker).toHaveTextContent(/acknowledging below is the appropriate step/);

    expect(within(blockers).getByTestId('blocker-ai_policy_enforcement_not_registered'))
      .toHaveTextContent(/has not registered its AI-policy enforcement/);
    expect(within(blockers).getByTestId('blocker-ai_policy_readiness_unavailable'))
      .toHaveTextContent(/Readiness could not be determined/);

    // A non-overridable blocker hides the acknowledgement entirely.
    expect(screen.queryByTestId('activation-acknowledge')).toBeNull();

    // The action stays mounted, explains itself, and cannot perform.
    const enable = screen.getByTestId('activation-enable');
    expect(enable).toHaveAttribute('aria-disabled', 'true');
    expect(enable).not.toBeDisabled();
    expect(enable).toHaveAccessibleDescription(/cannot be turned on while a blocker above is unresolved/);
    fireEvent.click(enable);
    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
    expect(activationCalls('PUT')).toHaveLength(0);
  });

  it('shows the acknowledgement only when every blocker is overridable, and sends it with the PUT', async () => {
    state.activation = { ...READY, ready: false, blockers: [LEGACY_USERS_BLOCKER, WINDOW_BLOCKER] };
    const { client } = renderTab();
    // A mounted article detail: it carries `aiPolicyActivation` and must re-read.
    client.setQueryData(['pages', 'page-1'], { id: 'page-1', aiPolicyActivation: 'foundation_only' });

    const blockers = await screen.findByTestId('activation-blockers');
    expect(blockers).toHaveTextContent('Older browser sessions may still be open.');

    const enable = screen.getByTestId('activation-enable');
    expect(enable).toHaveAttribute('aria-disabled', 'true');
    expect(enable).toHaveAccessibleDescription(/Tick the acknowledgement above/);

    const acknowledge = screen.getByTestId('activation-acknowledge');
    expect(acknowledge).toHaveAccessibleName(/recorded in the audit log/);
    fireEvent.click(acknowledge);
    expect(enable).not.toHaveAttribute('aria-disabled');
    expect(screen.queryByTestId('activation-hint')).toBeNull();

    fireEvent.click(enable);
    const dialog = await screen.findByTestId('confirm-dialog');
    expect(dialog).toHaveTextContent('Turn on article AI policy enforcement?');
    expect(dialog).toHaveTextContent(/Local AI only or No AI allowed/);
    expect(dialog).toHaveTextContent(/can no longer start/);
    expect(dialog).toHaveTextContent(/must reload/);
    expect(dialog).toHaveTextContent(/acknowledging the older sessions/);
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));

    await waitFor(() => {
      expect(screen.getByTestId('activation-state')).toHaveTextContent('Enforcement on');
    });
    expect(activationCalls('PUT')[0]?.body).toEqual({ enabled: true, acknowledgeLegacyClients: true });
    expect(screen.getByTestId('activation-state')).toHaveTextContent(/On since .* by Simon/);
    expect(screen.getByTestId('activation-state')).toHaveTextContent(/Legacy clients were acknowledged/);
    // The echo is not trusted: readiness is recomputed on every read.
    await waitFor(() => expect(activationCalls('GET').length).toBeGreaterThan(1));
    expect(client.getQueryState(['pages', 'page-1'])?.isInvalidated).toBe(true);
    // Blockers belong to turning on; while on, none are shown.
    expect(screen.queryByTestId('activation-blockers')).toBeNull();
    expect(screen.queryByTestId('activation-acknowledge')).toBeNull();
    expect(screen.getByTestId('activation-disable')).toBeInTheDocument();
  });

  it('turns on through the confirmation with a plain {enabled: true} when the deployment is ready', async () => {
    renderTab();
    const stateLine = await screen.findByTestId('activation-state');
    expect(stateLine).toHaveTextContent('Enforcement off');
    expect(stateLine).toHaveTextContent('It has never been turned on.');
    expect(screen.queryByTestId('activation-blockers')).toBeNull();
    expect(screen.queryByTestId('activation-acknowledge')).toBeNull();

    const enable = screen.getByTestId('activation-enable');
    expect(enable).not.toHaveAttribute('aria-disabled');
    fireEvent.click(enable);
    await screen.findByTestId('confirm-dialog');

    // Cancelling sends nothing.
    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull());
    expect(activationCalls('PUT')).toHaveLength(0);

    fireEvent.click(enable);
    fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));
    await waitFor(() => {
      expect(screen.getByTestId('activation-state')).toHaveTextContent('Enforcement on');
    });
    expect(activationCalls('PUT')).toHaveLength(1);
    expect(activationCalls('PUT')[0]?.body).toEqual({ enabled: true });
  });

  it('re-renders the blockers a 409 refusal returns and names the refusal', async () => {
    state.putStatus = 409;
    state.putError = {
      error: 'ai_policy_activation_refused',
      message: 'An incompatible runtime registered meanwhile',
      blockers: [RUNTIME_BLOCKER],
    };
    renderTab();
    await screen.findByTestId('activation-state');
    expect(screen.queryByTestId('activation-blockers')).toBeNull();

    fireEvent.click(screen.getByTestId('activation-enable'));
    fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));

    const error = await screen.findByTestId('activation-save-error');
    expect(error).toHaveTextContent(/refused to turn on enforcement/);
    expect(error).toHaveTextContent(/1 blocker/);
    const blockers = screen.getByTestId('activation-blockers');
    expect(within(blockers).getByTestId('blocker-incompatible_ai_policy_runtime')).toHaveTextContent('rt-old-1');
    expect(screen.getByTestId('activation-state')).toHaveTextContent('Enforcement off');
    expect(screen.getByTestId('activation-enable')).toHaveAttribute('aria-disabled', 'true');
  });

  it('treats the busy 503 as retryable and keeps the action available', async () => {
    state.putStatus = 503;
    state.putError = { error: 'ai_policy_activation_busy', message: 'Try again' };
    renderTab();
    await screen.findByTestId('activation-state');

    fireEvent.click(screen.getByTestId('activation-enable'));
    fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));

    expect(await screen.findByTestId('activation-save-error')).toHaveTextContent(/Try again in a moment/);
    expect(screen.getByTestId('activation-enable')).not.toHaveAttribute('aria-disabled');
  });

  it('turns off through its own confirmation that says stored restrictions stay enforced', async () => {
    state.activation = {
      ...READY,
      enabled: true,
      changedAt: '2026-11-07T12:00:00.000Z',
      changedBy: ADMIN_ID,
      changedByName: 'Simon',
      legacyClientsAcknowledged: true,
    };
    renderTab();
    const stateLine = await screen.findByTestId('activation-state');
    expect(stateLine).toHaveTextContent(/Enforcement on/);
    expect(stateLine).toHaveTextContent(/by Simon/);
    expect(screen.queryByTestId('activation-enable')).toBeNull();

    const disable = screen.getByTestId('activation-disable');
    expect(disable).toHaveClass('nm-button-ghost');
    fireEvent.click(disable);
    const dialog = await screen.findByTestId('confirm-dialog');
    expect(dialog).toHaveTextContent('Turn off article AI policy enforcement?');
    expect(dialog).toHaveTextContent(/Stored restrictions stay enforced/);
    expect(dialog).toHaveTextContent(/cannot choose or relax/);
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));

    await waitFor(() => {
      expect(screen.getByTestId('activation-state')).toHaveTextContent('Enforcement off');
    });
    expect(screen.getByTestId('activation-state')).toHaveTextContent(/Turned off .* by Simon/);
    expect(activationCalls('PUT')[0]?.body).toEqual({ enabled: false });
    expect(screen.getByTestId('activation-enable')).toBeInTheDocument();
  });

  it('distinguishes a failed read from a failed refresh over the cached state, with a mounted Retry', async () => {
    state.getStatus = 500;
    const { client } = renderTab();

    const error = await screen.findByTestId('activation-error');
    expect(error).toHaveAttribute('role', 'alert');
    expect(error).toHaveTextContent('could not be read, so no change is offered here');
    expect(screen.queryByTestId('activation-enable')).toBeNull();
    expect(screen.queryByTestId('activation-disable')).toBeNull();

    const retry = screen.getByTestId('activation-retry');
    expect(retry).not.toBeDisabled();
    state.getStatus = 200;
    fireEvent.click(retry);
    await screen.findByTestId('activation-state');
    expect(screen.queryByTestId('activation-error')).toBeNull();

    // A later refresh failure keeps the loaded state and says so, as status.
    state.getStatus = 500;
    await client.invalidateQueries({ queryKey: ['admin', 'ai-policy-activation'] });
    const stale = await screen.findByTestId('activation-stale');
    expect(stale).toHaveAttribute('role', 'status');
    expect(stale).toHaveTextContent('could not be refreshed. The last loaded state is shown.');
    expect(screen.getByTestId('activation-state')).toBeInTheDocument();
    expect(screen.getByTestId('activation-enable')).toBeInTheDocument();
  });
});
