/**
 * Settings → Article baselines, in the Governance group (#277) at the network boundary.
 *
 * Two things this panel must not get wrong: enabling baseline creation is a
 * one-way door and is refused while the deployment reports a blocker, and an
 * approval role is granted to a person the admin PICKS — never to a name they
 * type.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArticleBaselinesTab } from './ArticleBaselinesTab';

vi.mock('../../shared/enterprise/use-enterprise', () => ({
  useEnterprise: () => ({ isEnterprise: entitled, hasFeature: () => entitled }),
}));

let entitled = true;

const USER_ID = '88888888-8888-4888-8888-888888888888';

const ACTIVATION = {
  creationEnabled: false,
  deploymentReady: true,
  blockers: [] as string[],
  activatedAt: null,
  activatedBy: null,
  activatedByName: null,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface RouteState {
  activation: typeof ACTIVATION;
  activationStatus: number;
  activationError?: unknown;
}

let state: RouteState;
let fetchMock: ReturnType<typeof vi.fn>;
let calls: { url: string; method: string; body: unknown }[];

function route(url: string, init?: RequestInit): Response {
  const method = (init?.method ?? 'GET').toUpperCase();
  calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });

  if (url.includes('/admin/page-baselines/activation')) {
    if (method === 'PUT' && state.activationStatus !== 200) {
      return json(state.activationError, state.activationStatus);
    }
    if (method === 'PUT') {
      state.activation = { ...state.activation, creationEnabled: Boolean((JSON.parse(String(init?.body)) as { creationEnabled: boolean }).creationEnabled) };
    }
    return json(state.activation);
  }
  if (url.includes('/spaces/local')) {
    return json([{ key: 'LOCAL', name: 'Local space' }]);
  }
  if (url.includes('/policy')) {
    return json({ spaceKey: 'LOCAL', enabled: false, policyRevision: '2' });
  }
  if (url.includes('/requirements')) {
    if (method === 'PUT') return json({ requirements: null });
    return json({
      requirements: {
        spaceKey: 'LOCAL',
        requiredRoles: ['quality'],
        requirementsRevision: '4',
        updatedBy: null,
        updatedByName: null,
        updatedAt: null,
      },
    });
  }
  if (url.includes('/roles')) {
    if (method !== 'GET') return new Response(null, { status: 204 });
    return json({ assignments: [] });
  }
  if (url.includes('/admin/users')) {
    return json({ users: [{ id: USER_ID, username: 'mina', displayName: 'Mina Okafor' }] });
  }
  return json({});
}

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ArticleBaselinesTab />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  entitled = true;
  calls = [];
  state = { activation: { ...ACTIVATION }, activationStatus: 200 };
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => route(String(url), init));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('article baselines admin panel', () => {
  it('refuses activation while the deployment reports a blocker, and says what it is', async () => {
    state.activation = {
      ...ACTIVATION,
      deploymentReady: false,
      blockers: ['incompatible_page_writer_runtime'],
    };
    renderTab();

    const blockers = await screen.findByTestId('activation-blockers');
    expect(blockers.textContent).toMatch(/does not enforce baselines/i);

    fireEvent.click(screen.getByTestId('activation-toggle'));
    await screen.findByTestId('activation-save-error');
    expect(calls.some((c) => c.method === 'PUT' && c.url.includes('activation'))).toBe(false);
  });

  it('enables creation with an explicit flag and re-reads the server state', async () => {
    renderTab();
    await screen.findByTestId('activation-state');

    fireEvent.click(screen.getByTestId('activation-toggle'));
    await waitFor(() => {
      expect(screen.getByTestId('activation-state').textContent).toMatch(/is enabled/i);
    });
    const put = calls.find((c) => c.method === 'PUT' && c.url.includes('activation'));
    expect(put?.body).toEqual({ creationEnabled: true });
    // The echo is not trusted: the panel asks again, because readiness is
    // recomputed from the live writer runtimes on every read.
    expect(calls.filter((c) => c.method === 'GET' && c.url.includes('activation')).length)
      .toBeGreaterThan(1);
  });

  it('names the standalone requirement when the server refuses on Confluence', async () => {
    state.activationStatus = 409;
    state.activationError = {
      error: 'Turn off Confluence integration',
      reason: 'confluence_integration_enabled',
    };
    renderTab();
    await screen.findByTestId('activation-state');

    fireEvent.click(screen.getByTestId('activation-toggle'));
    const error = await screen.findByTestId('activation-save-error');
    expect(error.textContent).toMatch(/Confluence integration/i);
  });

  it('hides the approval-role sections behind the licence and explains the policy still binds', async () => {
    entitled = false;
    renderTab();

    const notice = await screen.findByTestId('governance-unlicensed');
    expect(notice.textContent).toMatch(/Enterprise/i);
    expect(notice.textContent).toMatch(/keeps refusing a direct manual freeze/i);
    expect(screen.queryByTestId('governance-requirements')).toBeNull();
    expect(screen.queryByTestId('governance-approvers')).toBeNull();
  });

  it('saves the typed role list and states that pending votes are invalidated', async () => {
    renderTab();
    const input = await screen.findByTestId('requirements-input');
    expect(screen.getByTestId('governance-requirements').textContent)
      .toMatch(/invalidates every pending vote/i);

    fireEvent.change(input, { target: { value: 'quality, regulatory' } });
    fireEvent.click(screen.getByTestId('requirements-save'));

    await waitFor(() => {
      const put = calls.find((c) => c.method === 'PUT' && c.url.includes('requirements'));
      expect(put?.body).toEqual({ requiredRoles: ['quality', 'regulatory'] });
    });
  });

  it('assigns an approver by user id chosen from the directory, never by a typed name', async () => {
    renderTab();
    const user = await screen.findByTestId('approver-user');
    expect(user.tagName).toBe('SELECT');
    await screen.findByRole('option', { name: 'Mina Okafor' });

    fireEvent.change(user, { target: { value: USER_ID } });
    fireEvent.click(screen.getByTestId('approver-add'));

    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.url.includes('/roles'));
      expect(post?.body).toEqual({ role: 'quality', userId: USER_ID });
    });
  });
});
