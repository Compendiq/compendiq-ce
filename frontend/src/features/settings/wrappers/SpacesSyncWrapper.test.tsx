import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SettingsResponse } from '@compendiq/contracts';
import { SpacesSyncWrapper } from './SpacesSyncWrapper';

// Both sub-tabs self-fetch (`/spaces`, the worker status probes); nothing
// here depends on the payloads, so the boundary is mocked once.
vi.mock('../../../shared/lib/api', () => ({
  apiFetch: vi.fn().mockResolvedValue([]),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

/**
 * #1623: the wrapper is where the flag enters this panel. Without these the
 * gates inside SpacesTab / SyncTab would be unreachable code — the panel
 * would keep soliciting Confluence work from a standalone user.
 */
function renderPanel(settings: Partial<SettingsResponse> | undefined, sub?: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/settings/knowledge/spaces${sub ? `?sub=${sub}` : ''}`]}>
        <SpacesSyncWrapper
          settings={settings as SettingsResponse | undefined}
          isLoading={false}
          onSaveSettingsAsync={vi.fn().mockResolvedValue({})}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('SpacesSyncWrapper Confluence gate (#1623)', () => {
  it('hands the off state to the Spaces tab and stops promising a mirror', async () => {
    renderPanel({ confluenceEnabled: false });

    expect(await screen.findByTestId('spaces-confluence-off')).toBeInTheDocument();
    expect(screen.queryByText('Fetch Spaces')).not.toBeInTheDocument();
    expect(screen.getByText(/The spaces stored in Compendiq/)).toBeInTheDocument();
  });

  it('hands the off state to the Sync tab as well', async () => {
    renderPanel({ confluenceEnabled: false }, 'sync');

    expect(await screen.findByTestId('sync-confluence-off')).toBeInTheDocument();
    expect(screen.queryByTestId('sync-overview-sync-now')).not.toBeInTheDocument();
  });

  it('leaves both tabs untouched when the integration is on', async () => {
    renderPanel({ confluenceEnabled: true });

    expect(await screen.findByText('Fetch Spaces')).toBeInTheDocument();
    expect(screen.queryByTestId('spaces-confluence-off')).not.toBeInTheDocument();
    expect(screen.getByText(/Pick which Confluence spaces to mirror/)).toBeInTheDocument();
  });

  // A pre-#1623 settings payload has no `confluenceEnabled` key at all. A
  // falsy check would read that absence as "off" and hide the panel's whole
  // reason for existing; only an explicit false counts.
  it('treats a payload without the key as on, not off', async () => {
    renderPanel({});

    expect(await screen.findByText('Fetch Spaces')).toBeInTheDocument();
    expect(screen.queryByTestId('spaces-confluence-off')).not.toBeInTheDocument();
  });
});
