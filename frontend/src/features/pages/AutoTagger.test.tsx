import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LazyMotion, domAnimation } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AutoTagger } from './AutoTagger';
import { useAuthStore } from '../../stores/auth-store';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <LazyMotion features={domAnimation}>
            {children}
          </LazyMotion>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

describe('AutoTagger', () => {
  beforeEach(() => {
    useAuthStore.getState().setAuth('test-token', {
      id: '1',
      username: 'testuser',
      role: 'user',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useAuthStore.getState().clearAuth();
  });

  it('renders the Auto-tag button', () => {
    render(
      <AutoTagger pageId="page-1" currentLabels={[]} model="qwen3.5" />,
      { wrapper: createWrapper() },
    );

    expect(screen.getByText('Auto-tag')).toBeInTheDocument();
  });

  it('shows loading state while auto-tagging', async () => {
    // Never-resolving promise for loading state test
    vi.spyOn(globalThis, 'fetch').mockReturnValue(
      new Promise(() => {}),
    );

    render(
      <AutoTagger pageId="page-1" currentLabels={[]} model="qwen3.5" />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('Auto-tag'));

    // The button should become disabled during loading
    await waitFor(() => {
      const button = screen.getByText('Auto-tag').closest('button');
      expect(button).toBeDisabled();
    });
  });

  it('shows tag suggestion dialog when tags are returned', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          suggestedTags: ['architecture', 'deployment'],
          existingLabels: [],
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(
      <AutoTagger pageId="page-1" currentLabels={[]} model="qwen3.5" />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('Auto-tag'));

    await waitFor(() => {
      expect(screen.getByText('Suggested Tags')).toBeInTheDocument();
      expect(screen.getByText('architecture')).toBeInTheDocument();
      expect(screen.getByText('deployment')).toBeInTheDocument();
    });
  });

  it('filters out already-applied tags', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          suggestedTags: ['architecture', 'deployment', 'security'],
          existingLabels: ['architecture'],
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(
      <AutoTagger pageId="page-1" currentLabels={['architecture']} model="qwen3.5" />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('Auto-tag'));

    await waitFor(() => {
      expect(screen.getByText('Suggested Tags')).toBeInTheDocument();
      // Only new tags should be shown as suggestion chips
      expect(screen.getByText('deployment')).toBeInTheDocument();
      expect(screen.getByText('security')).toBeInTheDocument();
    });
  });

  it('allows toggling tag selection', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          suggestedTags: ['architecture', 'deployment'],
          existingLabels: [],
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(
      <AutoTagger pageId="page-1" currentLabels={[]} model="qwen3.5" />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('Auto-tag'));

    await waitFor(() => {
      expect(screen.getByText('Suggested Tags')).toBeInTheDocument();
    });

    // By default all tags should be selected - button should say "Apply 2 tags"
    expect(screen.getByText('Apply 2 tags')).toBeInTheDocument();

    // Deselect one tag
    fireEvent.click(screen.getByText('architecture'));

    // Now only 1 tag selected
    expect(screen.getByText('Apply 1 tag')).toBeInTheDocument();
  });

  it('closes dialog on Cancel', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          suggestedTags: ['architecture'],
          existingLabels: [],
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(
      <AutoTagger pageId="page-1" currentLabels={[]} model="qwen3.5" />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByText('Auto-tag'));

    await waitFor(() => {
      expect(screen.getByText('Suggested Tags')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Cancel'));

    await waitFor(() => {
      expect(screen.queryByText('Suggested Tags')).not.toBeInTheDocument();
    });
  });
});
