import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { SettingsResponse } from '@compendiq/contracts';
import { ConfluenceTab } from './ConfluenceTab';
import { confluenceTokenUrl } from './confluence-token-url';

// ConfluenceTab only reads `confluenceUrl` and `hasConfluencePat`; the rest
// of SettingsResponse is irrelevant to this component.
const settings = {
  confluenceUrl: 'https://confluence.example.com',
  hasConfluencePat: false,
} as SettingsResponse;

function mockTestConnection(body: { success: boolean; message: string }) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ConfluenceTab — connection test result indicator', () => {
  // The E2E suite (e2e/confluence-sync.spec.ts) locates this box via
  // data-testid + data-state instead of Tailwind utility classes, so a
  // styling refactor can't silently hollow out the E2E assertion. These
  // tests pin that contract.
  it('renders the success result with data-testid and data-state="success"', async () => {
    mockTestConnection({ success: true, message: 'Connected to Confluence 9.2' });
    render(<ConfluenceTab settings={settings} onSave={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /test connection/i }));

    const result = await screen.findByTestId('confluence-test-result');
    expect(result).toHaveAttribute('data-state', 'success');
    expect(result).toHaveTextContent('Connected to Confluence 9.2');
  });

  it('renders the failure result with data-state="error"', async () => {
    mockTestConnection({ success: false, message: 'Authentication failed' });
    render(<ConfluenceTab settings={settings} onSave={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /test connection/i }));

    const result = await screen.findByTestId('confluence-test-result');
    expect(result).toHaveAttribute('data-state', 'error');
    expect(result).toHaveTextContent('Authentication failed');
  });

  it('shows no result box before the test runs', async () => {
    render(<ConfluenceTab settings={settings} onSave={vi.fn()} />);
    expect(screen.queryByTestId('confluence-test-result')).not.toBeInTheDocument();
    // Settle any pending microtasks so nothing leaks into the next test.
    await waitFor(() => expect(true).toBe(true));
  });
});

describe('confluenceTokenUrl', () => {
  it('derives the token page from the origin, discarding any path', () => {
    expect(confluenceTokenUrl('https://confluence.example.com/wiki/spaces/DEV')).toBe(
      'https://confluence.example.com/plugins/personalaccesstokens/usertokens.action',
    );
  });

  it('tolerates surrounding whitespace and non-default ports', () => {
    expect(confluenceTokenUrl('  https://conf.example.com:8090  ')).toBe(
      'https://conf.example.com:8090/plugins/personalaccesstokens/usertokens.action',
    );
  });

  it('returns null for input that is not yet a usable http(s) URL', () => {
    // A half-typed host would produce a link that 404s — worse than no link.
    expect(confluenceTokenUrl('')).toBeNull();
    expect(confluenceTokenUrl('confluence.exa')).toBeNull();
    expect(confluenceTokenUrl('javascript:alert(1)')).toBeNull();
  });
});

describe('ConfluenceTab — save gating', () => {
  it('disables Save until the connection tests green', async () => {
    render(<ConfluenceTab settings={settings} onSave={vi.fn()} />);

    const save = screen.getByTestId('confluence-save-btn');
    expect(save).toBeDisabled();
    expect(screen.getByTestId('confluence-save-hint')).toHaveTextContent(
      /test the connection to enable saving/i,
    );

    mockTestConnection({ success: true, message: 'Connected' });
    fireEvent.click(screen.getByRole('button', { name: /test connection/i }));

    await waitFor(() => expect(save).toBeEnabled());
    expect(screen.queryByTestId('confluence-save-hint')).not.toBeInTheDocument();
  });

  it('keeps Save disabled when the test fails', async () => {
    mockTestConnection({ success: false, message: 'Authentication failed' });
    render(<ConfluenceTab settings={settings} onSave={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /test connection/i }));

    await screen.findByTestId('confluence-test-result');
    expect(screen.getByTestId('confluence-save-btn')).toBeDisabled();
  });

  it('re-locks Save when credentials change after a green test', async () => {
    mockTestConnection({ success: true, message: 'Connected' });
    render(<ConfluenceTab settings={settings} onSave={vi.fn()} />);

    const save = screen.getByTestId('confluence-save-btn');
    fireEvent.click(screen.getByRole('button', { name: /test connection/i }));
    await waitFor(() => expect(save).toBeEnabled());

    // A stale green result must not vouch for a token the user just swapped.
    fireEvent.change(screen.getByLabelText(/personal access token/i), {
      target: { value: 'a-different-token' },
    });

    expect(save).toBeDisabled();
    expect(screen.getByTestId('confluence-save-hint')).toHaveTextContent(
      /details changed — test the connection again/i,
    );
  });

  it('submits the tested credentials once Save unlocks', async () => {
    mockTestConnection({ success: true, message: 'Connected' });
    const onSave = vi.fn();
    render(<ConfluenceTab settings={settings} onSave={onSave} />);

    fireEvent.change(screen.getByLabelText(/personal access token/i), {
      target: { value: 'tok-123' },
    });
    fireEvent.click(screen.getByRole('button', { name: /test connection/i }));
    await waitFor(() => expect(screen.getByTestId('confluence-save-btn')).toBeEnabled());

    fireEvent.click(screen.getByTestId('confluence-save-btn'));

    expect(onSave).toHaveBeenCalledWith({
      confluenceUrl: 'https://confluence.example.com',
      confluencePat: 'tok-123',
    });
  });
});

describe('ConfluenceTab — trust and guidance at PAT entry', () => {
  it('states that the token is encrypted at rest and never reaches an LLM', () => {
    render(<ConfluenceTab settings={settings} onSave={vi.fn()} />);
    const hint = screen.getByText(/AES-256-GCM/i);
    expect(hint).toBeInTheDocument();
    expect(hint).toHaveTextContent(/never included in any prompt sent to a language model/i);
  });

  it('deep-links to the token page on the configured instance', () => {
    render(<ConfluenceTab settings={settings} onSave={vi.fn()} />);
    expect(screen.getByTestId('confluence-token-link')).toHaveAttribute(
      'href',
      'https://confluence.example.com/plugins/personalaccesstokens/usertokens.action',
    );
  });

  it('omits the deep link until the URL is usable', () => {
    render(
      <ConfluenceTab settings={{ hasConfluencePat: false } as SettingsResponse} onSave={vi.fn()} />,
    );
    expect(screen.queryByTestId('confluence-token-link')).not.toBeInTheDocument();
  });

  it('renders the panel title so the surface matches the other settings panels', () => {
    render(<ConfluenceTab settings={settings} onSave={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Confluence' })).toBeInTheDocument();
  });
});
