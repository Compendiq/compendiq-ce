import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ComponentProps } from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RelocatePreview } from '@compendiq/contracts';
import { RelocateDialog } from './RelocateDialog';

const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();
const mockToastWarning = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
    warning: (...args: unknown[]) => mockToastWarning(...args),
  },
}));

// ── Network boundary ────────────────────────────────────────────────
//
// Every test drives the component through a stubbed global `fetch`, so the
// real `apiFetch`, the real TanStack queries and the real request bodies are
// all exercised. Nothing internal is mocked.

interface StubResponse {
  status?: number;
  body?: unknown;
}

let routes: Array<{ match: RegExp; method?: string; respond: (url: string, init?: RequestInit) => StubResponse }>;
let calls: Array<{ url: string; method: string; body: string | null }>;

function stubFetch() {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : null });

      const route = routes.find((r) => r.match.test(url) && (r.method ?? 'GET') === method);
      const { status = 200, body = {} } = route ? route.respond(url, init) : { status: 404, body: { message: `no stub for ${method} ${url}` } };

      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: String(status),
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => body,
      } as unknown as Response;
    }),
  );
}

/** Every POST /relocate request body, parsed. */
function relocatePosts(): unknown[] {
  return calls
    .filter((c) => c.method === 'POST' && /\/relocate$/.test(c.url))
    .map((c) => JSON.parse(c.body ?? '{}'));
}

/** Every preview URL requested, in order. */
function previewUrls(): string[] {
  return calls.filter((c) => /\/relocate\/preview/.test(c.url)).map((c) => c.url);
}

// ── Fixtures ────────────────────────────────────────────────────────

const CONFLUENCE_SPACES = [
  { key: 'DEV', name: 'Developer Docs', homepageId: null, lastSynced: null, pageCount: 1, source: 'confluence' },
  { key: 'OPS', name: 'Operations', homepageId: null, lastSynced: null, pageCount: 9, source: 'confluence' },
  { key: 'HOME', name: 'Home', homepageId: null, lastSynced: null, pageCount: 4, source: 'local' },
];

const LOCAL_SPACES = [
  { key: 'HOME', name: 'Home', description: null, icon: null, pageCount: 4, createdBy: null, createdAt: '', source: 'local' },
];

function standalonePreview(overrides: Partial<RelocatePreview> = {}): RelocatePreview {
  return {
    pageId: 42,
    title: 'Architecture Notes',
    source: 'standalone',
    spaceKey: null,
    confluenceId: null,
    target: 'confluence',
    childCount: 0,
    subtreeEffect: null,
    attachmentCount: 0,
    localVersionCount: 12,
    accessChange: {
      from: 'Private article — only simon can read it',
      to: 'Everyone with access to the chosen Confluence space',
      gains: [],
      loses: [],
      truncated: false,
    },
    upstreamDeletion: null,
    ...overrides,
  };
}

function confluencePreview(overrides: Partial<RelocatePreview> = {}): RelocatePreview {
  return {
    pageId: 42,
    title: 'Release Runbook',
    source: 'confluence',
    spaceKey: 'DEV',
    confluenceId: '98765432',
    target: 'local',
    childCount: 0,
    subtreeEffect: null,
    attachmentCount: 0,
    localVersionCount: 0,
    accessChange: {
      from: 'Governed by Confluence space DEV — everyone assigned to that space can read it',
      to: 'Governed by the local visibility you choose',
      gains: [],
      loses: [],
      truncated: false,
    },
    upstreamDeletion: { confluenceId: '98765432', spaceKey: 'DEV', title: 'Release Runbook' },
    ...overrides,
  };
}

/**
 * Register the two space listings plus a preview route whose response is
 * computed from the query string, so the dependent re-fetch returns different
 * data than the first, destination-less fetch — exactly as the server does.
 */
function givenPreview(build: (params: URLSearchParams) => RelocatePreview) {
  routes = [
    { match: /\/api\/spaces\/local$/, respond: () => ({ body: LOCAL_SPACES }) },
    { match: /\/api\/spaces$/, respond: () => ({ body: CONFLUENCE_SPACES }) },
    {
      match: /\/relocate\/preview/,
      respond: (url) => ({ body: build(new URL(url, 'http://localhost').searchParams) }),
    },
  ];
}

/** Preview route that fails, optionally only once the destination is chosen. */
function givenFailingPreview(opts: { onlyWithDestination?: boolean } = {}) {
  routes = [
    { match: /\/api\/spaces\/local$/, respond: () => ({ body: LOCAL_SPACES }) },
    { match: /\/api\/spaces$/, respond: () => ({ body: CONFLUENCE_SPACES }) },
    {
      match: /\/relocate\/preview/,
      respond: (url) => {
        const params = new URL(url, 'http://localhost').searchParams;
        const chosen = params.has('spaceKey') || params.has('visibility');
        if (opts.onlyWithDestination && !chosen) {
          return { body: standalonePreview({ localVersionCount: 12 }) };
        }
        return { status: 403, body: { message: 'Access denied to this space' } };
      },
    },
  ];
}

function givenRelocate(response: StubResponse) {
  routes.push({ match: /\/relocate$/, method: 'POST', respond: () => response });
}

const onClose = vi.fn();

function renderDialog(props: Partial<ComponentProps<typeof RelocateDialog>> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RelocateDialog
        open
        pageId="42"
        pageTitle="Architecture Notes"
        source="standalone"
        onClose={onClose}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { ...utils, queryClient, invalidate };
}

/** Wait for the first preview to have rendered. */
async function awaitPreview() {
  await screen.findByTestId('relocate-preview');
}

beforeEach(() => {
  onClose.mockReset();
  mockToastSuccess.mockReset();
  mockToastError.mockReset();
  mockToastWarning.mockReset();
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RelocateDialog — preview', () => {
  it('states the exact number of local versions the move destroys', async () => {
    givenPreview(() => standalonePreview({ localVersionCount: 12 }));
    renderDialog();
    await awaitPreview();

    expect(screen.getByTestId('relocate-effect-versions')).toHaveTextContent(/12/);
  });

  it('says there is no local history to discard rather than showing a zero', async () => {
    givenPreview(() => standalonePreview({ localVersionCount: 0 }));
    renderDialog();
    await awaitPreview();

    expect(screen.getByTestId('relocate-effect-versions')).toHaveTextContent(/no local version history/i);
  });

  it('reports attachments and children, and warns that children stay behind', async () => {
    givenPreview(() =>
      standalonePreview({
        attachmentCount: 3,
        childCount: 2,
        subtreeEffect: {
          childrenRemainInSpaceKey: 'HOME',
          pageMovesToSpaceKey: 'DEV',
          childrenDetachFromOriginTree: true,
        },
      }),
    );
    renderDialog();
    await awaitPreview();

    expect(screen.getByTestId('relocate-effect-attachments')).toHaveTextContent(/3/);
    const children = screen.getByTestId('relocate-effect-children');
    expect(children).toHaveTextContent(/2/);
    expect(children).toHaveTextContent(/HOME/);
    expect(children).toHaveTextContent(/stay/i);
  });

  it('agrees the verb with a single child page', async () => {
    givenPreview(() =>
      confluencePreview({
        childCount: 1,
        subtreeEffect: {
          childrenRemainInSpaceKey: 'DEV',
          pageMovesToSpaceKey: null,
          childrenDetachFromOriginTree: true,
        },
      }),
    );
    renderDialog({ source: 'confluence', pageTitle: 'Release Runbook' });
    await awaitPreview();

    const row = screen.getByTestId('relocate-effect-children');
    expect(row).toHaveTextContent(/1 child page stays in DEV/);
    expect(row).toHaveTextContent(/It keeps its own location/);
  });

  it('names the Confluence page and space deleted upstream', async () => {
    givenPreview(() => confluencePreview());
    renderDialog({ source: 'confluence', pageTitle: 'Release Runbook' });
    await awaitPreview();

    const row = screen.getByTestId('relocate-effect-upstream');
    expect(row).toHaveTextContent(/Release Runbook/);
    expect(row).toHaveTextContent(/DEV/);
  });
});

describe('RelocateDialog — access change', () => {
  it('renders the before and after access models', async () => {
    givenPreview(() => standalonePreview());
    renderDialog();
    await awaitPreview();

    expect(screen.getByTestId('relocate-access-from')).toHaveTextContent(/only simon can read it/i);
    expect(screen.getByTestId('relocate-access-to')).toHaveTextContent(/Confluence space/i);
  });

  it('reads empty principal lists as nobody, not as an empty box', async () => {
    givenPreview(() => standalonePreview());
    renderDialog();
    await awaitPreview();

    expect(screen.getByTestId('relocate-gains')).toHaveTextContent(/nobody/i);
    expect(screen.getByTestId('relocate-loses')).toHaveTextContent(/nobody/i);
  });

  it('lists every principal with its kind once a destination resolves them', async () => {
    givenPreview((params) =>
      standalonePreview(
        params.get('spaceKey')
          ? {
              accessChange: {
                from: 'Private article — only simon can read it',
                to: 'Governed by Confluence space DEV',
                gains: [
                  { kind: 'user', label: 'ada' },
                  { kind: 'group', label: 'platform-team' },
                ],
                loses: [{ kind: 'owner', label: 'simon' }],
                truncated: false,
              },
            }
          : {},
      ),
    );
    renderDialog();
    await awaitPreview();

    fireEvent.change(screen.getByTestId('relocate-space-select'), { target: { value: 'DEV' } });

    const gains = await screen.findByTestId('relocate-gains');
    await waitFor(() => expect(gains).toHaveTextContent('ada'));
    expect(within(gains).getByTestId('relocate-principal-user-ada')).toBeInTheDocument();
    expect(within(gains).getByTestId('relocate-principal-group-platform-team')).toBeInTheDocument();
    expect(within(screen.getByTestId('relocate-loses')).getByTestId('relocate-principal-owner-simon')).toBeInTheDocument();
  });

  it('says so explicitly when the roster is truncated', async () => {
    givenPreview((params) =>
      standalonePreview(
        params.get('spaceKey')
          ? {
              accessChange: {
                from: 'Private article — only simon can read it',
                to: 'Governed by Confluence space DEV',
                gains: [{ kind: 'user', label: 'ada' }],
                loses: [],
                truncated: true,
              },
            }
          : {},
      ),
    );
    renderDialog();
    await awaitPreview();

    expect(screen.queryByTestId('relocate-truncated')).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId('relocate-space-select'), { target: { value: 'DEV' } });

    expect(await screen.findByTestId('relocate-truncated')).toHaveTextContent(/more people may be affected/i);
  });

  it('re-fetches the preview with the chosen destination', async () => {
    givenPreview(() => standalonePreview());
    renderDialog();
    await awaitPreview();

    expect(previewUrls()).toHaveLength(1);
    expect(previewUrls()[0]).not.toContain('spaceKey');

    fireEvent.change(screen.getByTestId('relocate-space-select'), { target: { value: 'DEV' } });

    await waitFor(() => expect(previewUrls()).toHaveLength(2));
    expect(previewUrls()[1]).toContain('spaceKey=DEV');
  });

  it('re-fetches with the chosen visibility when moving to a local space', async () => {
    givenPreview(() => confluencePreview());
    renderDialog({ source: 'confluence', pageTitle: 'Release Runbook' });
    await awaitPreview();

    fireEvent.click(screen.getByTestId('relocate-visibility-shared'));

    await waitFor(() => expect(previewUrls()).toHaveLength(2));
    expect(previewUrls()[1]).toContain('visibility=shared');
    // The destination local space must NOT be sent: the preview route
    // authorises a caller-supplied spaceKey against the user's *Confluence*
    // space assignments, so a local key would 403 for a non-admin.
    expect(previewUrls()[1]).not.toContain('spaceKey');
  });
});

describe('RelocateDialog — confirmation body', () => {
  it('sends the confluence arm of the discriminated union verbatim', async () => {
    givenPreview(() => standalonePreview({ localVersionCount: 12 }));
    givenRelocate({
      body: {
        pageId: 42,
        source: 'confluence',
        spaceKey: 'DEV',
        confluenceId: '111',
        childrenRepointed: 0,
        versionsDiscarded: 12,
        attachmentsMigrated: 0,
        upstreamDeleted: false,
        warnings: [],
      },
    });
    renderDialog();
    await awaitPreview();

    fireEvent.change(screen.getByTestId('relocate-space-select'), { target: { value: 'DEV' } });
    await waitFor(() => expect(previewUrls()).toHaveLength(2));
    fireEvent.click(screen.getByTestId('relocate-ack-access'));
    fireEvent.click(screen.getByTestId('relocate-ack-versions'));
    fireEvent.click(screen.getByTestId('relocate-submit'));

    await waitFor(() => expect(relocatePosts()).toHaveLength(1));
    expect(relocatePosts()[0]).toEqual({
      target: 'confluence',
      spaceKey: 'DEV',
      acknowledgeAccessChange: true,
      acknowledgeDiscardedVersions: 12,
    });
  });

  it('echoes acknowledgeDiscardedVersions: 0 even with no versions checkbox to tick', async () => {
    givenPreview(() => standalonePreview({ localVersionCount: 0 }));
    givenRelocate({
      body: {
        pageId: 42, source: 'confluence', spaceKey: 'DEV', confluenceId: '111',
        childrenRepointed: 0, versionsDiscarded: 0, attachmentsMigrated: 0,
        upstreamDeleted: false, warnings: [],
      },
    });
    renderDialog();
    await awaitPreview();

    expect(screen.queryByTestId('relocate-ack-versions')).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId('relocate-space-select'), { target: { value: 'DEV' } });
    await waitFor(() => expect(previewUrls()).toHaveLength(2));
    fireEvent.click(screen.getByTestId('relocate-ack-access'));
    fireEvent.click(screen.getByTestId('relocate-submit'));

    await waitFor(() => expect(relocatePosts()).toHaveLength(1));
    expect(relocatePosts()[0]).toEqual({
      target: 'confluence',
      spaceKey: 'DEV',
      acknowledgeAccessChange: true,
      acknowledgeDiscardedVersions: 0,
    });
  });

  it('sends the local arm with the echoed confluence page and a null space when none is chosen', async () => {
    givenPreview(() => confluencePreview());
    givenRelocate({
      body: {
        pageId: 42, source: 'standalone', spaceKey: null, confluenceId: null,
        childrenRepointed: 0, versionsDiscarded: 0, attachmentsMigrated: 0,
        upstreamDeleted: true, warnings: [],
      },
    });
    renderDialog({ source: 'confluence', pageTitle: 'Release Runbook' });
    await awaitPreview();

    fireEvent.click(screen.getByTestId('relocate-visibility-private'));
    await waitFor(() => expect(previewUrls()).toHaveLength(2));
    fireEvent.click(screen.getByTestId('relocate-ack-access'));
    fireEvent.click(screen.getByTestId('relocate-ack-delete'));
    fireEvent.click(screen.getByTestId('relocate-submit'));

    await waitFor(() => expect(relocatePosts()).toHaveLength(1));
    expect(relocatePosts()[0]).toEqual({
      target: 'local',
      spaceKey: null,
      visibility: 'private',
      acknowledgeAccessChange: true,
      confirmDeleteConfluencePage: { confluenceId: '98765432', spaceKey: 'DEV' },
    });
  });

  it('sends the chosen local space when one is picked', async () => {
    givenPreview(() => confluencePreview());
    givenRelocate({
      body: {
        pageId: 42, source: 'standalone', spaceKey: 'HOME', confluenceId: null,
        childrenRepointed: 0, versionsDiscarded: 0, attachmentsMigrated: 0,
        upstreamDeleted: true, warnings: [],
      },
    });
    renderDialog({ source: 'confluence', pageTitle: 'Release Runbook' });
    await awaitPreview();

    fireEvent.change(screen.getByTestId('relocate-space-select'), { target: { value: 'HOME' } });
    fireEvent.click(screen.getByTestId('relocate-visibility-shared'));
    await waitFor(() => expect(previewUrls()).toHaveLength(2));
    fireEvent.click(screen.getByTestId('relocate-ack-access'));
    fireEvent.click(screen.getByTestId('relocate-ack-delete'));
    fireEvent.click(screen.getByTestId('relocate-submit'));

    await waitFor(() => expect(relocatePosts()).toHaveLength(1));
    expect(relocatePosts()[0]).toMatchObject({ target: 'local', spaceKey: 'HOME', visibility: 'shared' });
  });

  it('names the Confluence page and space in the delete acknowledgement', async () => {
    givenPreview(() => confluencePreview());
    renderDialog({ source: 'confluence', pageTitle: 'Release Runbook' });
    await awaitPreview();

    const label = screen.getByTestId('relocate-ack-delete-label');
    expect(label).toHaveTextContent(/Release Runbook/);
    expect(label).toHaveTextContent(/DEV/);
  });
});

describe('RelocateDialog — gating', () => {
  it('keeps the move disabled until a destination and every acknowledgement are set', async () => {
    givenPreview(() => standalonePreview({ localVersionCount: 12 }));
    renderDialog();
    await awaitPreview();

    const submit = screen.getByTestId('relocate-submit');
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByTestId('relocate-space-select'), { target: { value: 'DEV' } });
    await waitFor(() => expect(previewUrls()).toHaveLength(2));
    expect(submit).toBeDisabled();

    fireEvent.click(screen.getByTestId('relocate-ack-access'));
    expect(submit).toBeDisabled();

    fireEvent.click(screen.getByTestId('relocate-ack-versions'));
    expect(submit).toBeEnabled();
  });

  it('requires an explicit visibility before a move to a local space can run', async () => {
    givenPreview(() => confluencePreview());
    renderDialog({ source: 'confluence', pageTitle: 'Release Runbook' });
    await awaitPreview();

    // Everything acknowledged, but no visibility chosen: still refused.
    fireEvent.click(screen.getByTestId('relocate-ack-access'));
    fireEvent.click(screen.getByTestId('relocate-ack-delete'));
    expect(screen.getByTestId('relocate-submit')).toBeDisabled();

    fireEvent.click(screen.getByTestId('relocate-visibility-shared'));
    await waitFor(() => expect(previewUrls()).toHaveLength(2));
    fireEvent.click(screen.getByTestId('relocate-ack-access'));
    fireEvent.click(screen.getByTestId('relocate-ack-delete'));
    await waitFor(() => expect(screen.getByTestId('relocate-submit')).toBeEnabled());
  });

  // The acknowledgements sit below the fold on a short viewport, so a confirm
  // button that is merely disabled reads as broken. It has to name what is
  // still missing.
  it('names the first unmet requirement while the move is refused', async () => {
    givenPreview(() => standalonePreview({ localVersionCount: 12 }));
    renderDialog();
    await awaitPreview();

    expect(screen.getByTestId('relocate-submit-hint')).toHaveTextContent(/choose a confluence space/i);

    fireEvent.change(screen.getByTestId('relocate-space-select'), { target: { value: 'DEV' } });
    await waitFor(() => expect(previewUrls()).toHaveLength(2));
    // The destination-keyed preview is in flight; until it lands the roster on
    // screen belongs to the previous destination, so the move stays refused for
    // that reason rather than for a missing tick.
    await waitFor(() => {
      expect(screen.getByTestId('relocate-submit-hint')).toHaveTextContent(/confirm|acknowledge/i);
    });

    fireEvent.click(screen.getByTestId('relocate-ack-access'));
    fireEvent.click(screen.getByTestId('relocate-ack-versions'));
    expect(screen.queryByTestId('relocate-submit-hint')).not.toBeInTheDocument();
  });

  // `placeholderData` keeps the previous preview on screen while the
  // destination-keyed one loads, so `preview` stays truthy throughout. Without
  // gating on the fetch, both boxes could be ticked and the move confirmed
  // against the roster and version count of the *previous* destination.
  it('refuses the move while the destination-keyed preview is still loading', async () => {
    let release: (() => void) | undefined;
    givenPreview(() => standalonePreview({ localVersionCount: 12 }));
    renderDialog();
    await awaitPreview();

    // Hold the second request open.
    givenPreview(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return standalonePreview({ localVersionCount: 12 });
    });

    fireEvent.change(screen.getByTestId('relocate-space-select'), { target: { value: 'DEV' } });
    await waitFor(() => expect(previewUrls()).toHaveLength(2));

    fireEvent.click(screen.getByTestId('relocate-ack-access'));
    fireEvent.click(screen.getByTestId('relocate-ack-versions'));

    expect(screen.getByTestId('relocate-submit')).toBeDisabled();
    expect(screen.getByTestId('relocate-submit-hint')).toHaveTextContent(/working out/i);

    release?.();
  });

  it('asks for a visibility first when moving to a local space', async () => {
    givenPreview(() => confluencePreview());
    renderDialog({ source: 'confluence', pageTitle: 'Release Runbook' });
    await awaitPreview();

    expect(screen.getByTestId('relocate-submit-hint')).toHaveTextContent(/private or shared/i);
  });

  it('clears the acknowledgements when the destination changes', async () => {
    // The roster the user read belonged to the previous space; the new one is
    // still in flight, so a still-ticked box would confirm something unseen.
    givenPreview(() => standalonePreview({ localVersionCount: 12 }));
    renderDialog();
    await awaitPreview();

    fireEvent.change(screen.getByTestId('relocate-space-select'), { target: { value: 'DEV' } });
    await waitFor(() => expect(previewUrls()).toHaveLength(2));
    fireEvent.click(screen.getByTestId('relocate-ack-access'));
    fireEvent.click(screen.getByTestId('relocate-ack-versions'));
    expect(screen.getByTestId('relocate-submit')).toBeEnabled();

    fireEvent.change(screen.getByTestId('relocate-space-select'), { target: { value: 'OPS' } });

    expect(screen.getByTestId('relocate-ack-access')).not.toBeChecked();
    expect(screen.getByTestId('relocate-ack-versions')).not.toBeChecked();
    expect(screen.getByTestId('relocate-submit')).toBeDisabled();
  });
});

describe('RelocateDialog — failures', () => {
  async function submitConfluenceMove() {
    renderDialog();
    await awaitPreview();
    fireEvent.change(screen.getByTestId('relocate-space-select'), { target: { value: 'DEV' } });
    await waitFor(() => expect(previewUrls()).toHaveLength(2));
    fireEvent.click(screen.getByTestId('relocate-ack-access'));
    fireEvent.click(screen.getByTestId('relocate-ack-versions'));
    fireEvent.click(screen.getByTestId('relocate-submit'));
  }

  it.each([
    [409, 'A Confluence sync is currently running. Wait for it to finish and try again.'],
    [403, 'Access denied to this space'],
    [400, 'Confluence not configured'],
    [400, 'Target space is not a Confluence space'],
    [404, 'Page not found'],
  ])('renders the server message for a %i', async (status, message) => {
    givenPreview(() => standalonePreview({ localVersionCount: 12 }));
    givenRelocate({ status, body: { message } });
    await submitConfluenceMove();

    expect(await screen.findByTestId('relocate-error')).toHaveTextContent(message);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('offers a preview reload after a 409 and clears the acknowledgements with it', async () => {
    givenPreview(() => standalonePreview({ localVersionCount: 12 }));
    givenRelocate({
      status: 409,
      body: {
        message:
          'Version count changed: 13 local version(s) would be discarded, but the confirmation acknowledged 12. Reload and confirm again.',
      },
    });
    await submitConfluenceMove();

    await screen.findByTestId('relocate-error');
    expect(screen.getByTestId('relocate-ack-access')).toBeChecked();

    const before = previewUrls().length;
    fireEvent.click(screen.getByTestId('relocate-reload-preview'));

    await waitFor(() => expect(previewUrls().length).toBeGreaterThan(before));
    expect(screen.getByTestId('relocate-ack-access')).not.toBeChecked();
    expect(screen.getByTestId('relocate-ack-versions')).not.toBeChecked();
    expect(screen.getByTestId('relocate-submit')).toBeDisabled();
  });

  it('offers no reload for a non-conflict failure', async () => {
    givenPreview(() => standalonePreview({ localVersionCount: 12 }));
    givenRelocate({ status: 400, body: { message: 'Confluence not configured' } });
    await submitConfluenceMove();

    await screen.findByTestId('relocate-error');
    expect(screen.queryByTestId('relocate-reload-preview')).not.toBeInTheDocument();
  });
});

describe('RelocateDialog — success', () => {
  it('closes and invalidates the page, space and local-space queries', async () => {
    givenPreview(() => standalonePreview({ localVersionCount: 12 }));
    givenRelocate({
      body: {
        pageId: 42, source: 'confluence', spaceKey: 'DEV', confluenceId: '111',
        childrenRepointed: 0, versionsDiscarded: 12, attachmentsMigrated: 0,
        upstreamDeleted: false, warnings: [],
      },
    });
    const { invalidate } = renderDialog();
    await awaitPreview();

    fireEvent.change(screen.getByTestId('relocate-space-select'), { target: { value: 'DEV' } });
    await waitFor(() => expect(previewUrls()).toHaveLength(2));
    fireEvent.click(screen.getByTestId('relocate-ack-access'));
    fireEvent.click(screen.getByTestId('relocate-ack-versions'));
    fireEvent.click(screen.getByTestId('relocate-submit'));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const keys = invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(['pages']));
    expect(keys).toContain(JSON.stringify(['pages', '42']));
    expect(keys).toContain(JSON.stringify(['spaces']));
    expect(keys).toContain(JSON.stringify(['local-spaces']));
    expect(mockToastSuccess).toHaveBeenCalled();
  });

  it('warns when the local side committed but the Confluence page survived', async () => {
    givenPreview(() => confluencePreview());
    givenRelocate({
      body: {
        pageId: 42, source: 'standalone', spaceKey: null, confluenceId: null,
        childrenRepointed: 0, versionsDiscarded: 0, attachmentsMigrated: 0,
        upstreamDeleted: false, warnings: [],
      },
    });
    renderDialog({ source: 'confluence', pageTitle: 'Release Runbook' });
    await awaitPreview();

    fireEvent.click(screen.getByTestId('relocate-visibility-shared'));
    await waitFor(() => expect(previewUrls()).toHaveLength(2));
    fireEvent.click(screen.getByTestId('relocate-ack-access'));
    fireEvent.click(screen.getByTestId('relocate-ack-delete'));
    fireEvent.click(screen.getByTestId('relocate-submit'));

    await waitFor(() => expect(mockToastWarning).toHaveBeenCalled());
    expect(String(mockToastWarning.mock.calls[0]?.[0])).toMatch(/Confluence page/i);
  });

  it('surfaces server warnings alongside the success', async () => {
    givenPreview(() => standalonePreview({ localVersionCount: 12 }));
    givenRelocate({
      body: {
        pageId: 42, source: 'confluence', spaceKey: 'DEV', confluenceId: '111',
        childrenRepointed: 0, versionsDiscarded: 12, attachmentsMigrated: 0,
        upstreamDeleted: false,
        warnings: ['Attachment "chart.png" is referenced but missing on disk; it was not published.'],
      },
    });
    renderDialog();
    await awaitPreview();

    fireEvent.change(screen.getByTestId('relocate-space-select'), { target: { value: 'DEV' } });
    await waitFor(() => expect(previewUrls()).toHaveLength(2));
    fireEvent.click(screen.getByTestId('relocate-ack-access'));
    fireEvent.click(screen.getByTestId('relocate-ack-versions'));
    fireEvent.click(screen.getByTestId('relocate-submit'));

    await waitFor(() => expect(mockToastWarning).toHaveBeenCalled());
    expect(String(mockToastWarning.mock.calls[0]?.[0])).toMatch(/chart\.png/);
  });
});

describe('RelocateDialog — preview failures (#1123 review)', () => {
  it('offers a retry when the first preview fails', async () => {
    givenFailingPreview();
    renderDialog();

    const error = await screen.findByTestId('relocate-preview-error');
    expect(error).toHaveTextContent(/access denied/i);
    expect(screen.getByTestId('relocate-preview-retry')).toBeInTheDocument();
    expect(screen.queryByTestId('relocate-preview')).not.toBeInTheDocument();
  });

  // Replacing the whole body would take the destination picker with it, so the
  // only offered recovery would be re-requesting the same failing key.
  it('keeps the destination picker reachable when a chosen destination fails', async () => {
    givenFailingPreview({ onlyWithDestination: true });
    renderDialog();
    await awaitPreview();

    fireEvent.change(screen.getByTestId('relocate-space-select'), { target: { value: 'DEV' } });

    await waitFor(() => {
      expect(screen.getByTestId('relocate-destination-error')).toHaveTextContent(/access denied/i);
    });
    // Still there, so another destination can be picked.
    expect(screen.getByTestId('relocate-space-select')).toBeInTheDocument();
    expect(screen.getByTestId('relocate-submit')).toBeDisabled();
  });

  it('recovers when a retried first preview succeeds', async () => {
    givenFailingPreview();
    renderDialog();
    await screen.findByTestId('relocate-preview-error');

    givenPreview(() => standalonePreview({ localVersionCount: 12 }));
    fireEvent.click(screen.getByTestId('relocate-preview-retry'));

    await awaitPreview();
    expect(screen.queryByTestId('relocate-preview-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('relocate-space-select')).toBeInTheDocument();
  });

  // `staleTime: 0` leaves `refetchOnWindowFocus` on by default, which can
  // replace the version count and access roster behind acknowledgements
  // already ticked for the old ones.
  it('does not refetch the preview when the tab regains focus', async () => {
    givenPreview(() => standalonePreview({ localVersionCount: 12 }));
    renderDialog();
    await awaitPreview();
    const before = previewUrls().length;

    fireEvent.focus(window);
    window.dispatchEvent(new Event('visibilitychange'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(previewUrls()).toHaveLength(before);
  });

  // "Choose a Confluence space to continue" is not an instruction anyone can
  // follow when the picker is empty.
  it('explains an empty Confluence space list instead of instructing', async () => {
    routes = [
      { match: /\/api\/spaces\/local$/, respond: () => ({ body: LOCAL_SPACES }) },
      { match: /\/api\/spaces$/, respond: () => ({ body: [] }) },
      {
        match: /\/relocate\/preview/,
        respond: () => ({ body: standalonePreview({ localVersionCount: 0 }) }),
      },
    ];
    renderDialog();
    await awaitPreview();

    await waitFor(() => {
      expect(screen.getByTestId('relocate-submit-hint')).toHaveTextContent(/no confluence space is available/i);
    });
    expect(screen.getByTestId('relocate-submit')).toBeDisabled();
  });

  // A failed or malformed /spaces response used to take the whole dialog down
  // with `(spaces ?? []).filter is not a function` — `??` does not guard a
  // non-array. It surfaced only in CI, where the query resolved before the test
  // ended.
  it('survives a malformed space listing instead of crashing', async () => {
    routes = [
      { match: /\/api\/spaces\/local$/, respond: () => ({ body: { error: 'boom' } }) },
      { match: /\/api\/spaces$/, respond: () => ({ body: { error: 'boom' } }) },
      {
        match: /\/relocate\/preview/,
        respond: () => ({ body: standalonePreview({ localVersionCount: 0 }) }),
      },
    ];

    renderDialog();

    await awaitPreview();
    expect(screen.getByTestId('relocate-space-select')).toBeInTheDocument();
    expect(screen.getByTestId('relocate-submit')).toBeDisabled();
  });

  // A cached `source` can be stale; the preview is the server's own answer.
  it('follows the server\'s target when it disagrees with the cached source', async () => {
    givenPreview(() => confluencePreview());
    // Caller believes the page is still standalone.
    renderDialog({ source: 'standalone' });
    await awaitPreview();

    // The move-to-local dialog, which is what the server says this page needs.
    await waitFor(() => {
      expect(screen.getByTestId('relocate-ack-delete')).toBeInTheDocument();
    });
    expect(screen.getByTestId('relocate-visibility-private')).toBeInTheDocument();
  });

  it('refuses a move to local when the page has no Confluence page on record', async () => {
    givenPreview(() => confluencePreview({ upstreamDeletion: null }));
    renderDialog({ source: 'confluence' });
    await awaitPreview();

    fireEvent.click(screen.getByTestId('relocate-visibility-private'));

    await waitFor(() => {
      expect(screen.getByTestId('relocate-no-upstream')).toBeInTheDocument();
    });
    expect(screen.getByTestId('relocate-submit')).toBeDisabled();
  });
});

