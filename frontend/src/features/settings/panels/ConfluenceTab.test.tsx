import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { SettingsResponse } from '@compendiq/contracts';
import { ConfluenceTab } from './ConfluenceTab';

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
