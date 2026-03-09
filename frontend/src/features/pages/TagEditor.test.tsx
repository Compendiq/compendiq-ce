import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TagEditor } from './TagEditor';
import { useAuthStore } from '../../stores/auth-store';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          {children}
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

describe('TagEditor', () => {
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

  it('renders existing labels as badges', () => {
    render(
      <TagEditor pageId="page-1" labels={['architecture', 'deployment']} />,
      { wrapper: createWrapper() },
    );

    expect(screen.getByText('architecture')).toBeInTheDocument();
    expect(screen.getByText('deployment')).toBeInTheDocument();
  });

  it('renders add button', () => {
    render(
      <TagEditor pageId="page-1" labels={[]} />,
      { wrapper: createWrapper() },
    );

    expect(screen.getByLabelText('Add tag')).toBeInTheDocument();
  });

  it('shows input field when add button clicked', () => {
    render(
      <TagEditor pageId="page-1" labels={[]} />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByLabelText('Add tag'));

    expect(screen.getByPlaceholderText('tag name')).toBeInTheDocument();
  });

  it('renders remove buttons on hover for each label', () => {
    render(
      <TagEditor pageId="page-1" labels={['architecture']} />,
      { wrapper: createWrapper() },
    );

    expect(screen.getByLabelText('Remove tag architecture')).toBeInTheDocument();
  });

  it('calls API to add a tag on Enter', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ labels: ['architecture', 'new-tag'] }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(
      <TagEditor pageId="page-1" labels={['architecture']} />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByLabelText('Add tag'));
    const input = screen.getByPlaceholderText('tag name');
    fireEvent.change(input, { target: { value: 'new-tag' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/pages/page-1/labels'),
        expect.objectContaining({ method: 'PUT' }),
      );
    });
  });

  it('calls API to remove a tag when remove button clicked', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ labels: [] }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(
      <TagEditor pageId="page-1" labels={['architecture']} />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByLabelText('Remove tag architecture'));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/pages/page-1/labels'),
        expect.objectContaining({ method: 'PUT' }),
      );
    });
  });

  it('hides input on Escape key', () => {
    render(
      <TagEditor pageId="page-1" labels={[]} />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByLabelText('Add tag'));
    const input = screen.getByPlaceholderText('tag name');
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.queryByPlaceholderText('tag name')).not.toBeInTheDocument();
  });

  it('renders with no labels showing only add button', () => {
    render(
      <TagEditor pageId="page-1" labels={[]} />,
      { wrapper: createWrapper() },
    );

    expect(screen.getByLabelText('Add tag')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Remove tag/)).not.toBeInTheDocument();
  });

  it('shows remove buttons always visible when editing is true', () => {
    render(
      <TagEditor pageId="page-1" labels={['architecture', 'deployment']} editing />,
      { wrapper: createWrapper() },
    );

    const removeBtn = screen.getByLabelText('Remove tag architecture');
    expect(removeBtn.className).toContain('inline-flex');
    expect(removeBtn.className).not.toContain('hidden');
  });

  it('hides remove buttons by default when editing is false', () => {
    render(
      <TagEditor pageId="page-1" labels={['architecture']} />,
      { wrapper: createWrapper() },
    );

    const removeBtn = screen.getByLabelText('Remove tag architecture');
    expect(removeBtn.className).toContain('hidden');
  });

  it('calls API to remove a tag in editing mode', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ labels: [] }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(
      <TagEditor pageId="page-1" labels={['deployment']} editing />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByLabelText('Remove tag deployment'));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/pages/page-1/labels'),
        expect.objectContaining({ method: 'PUT' }),
      );
    });
  });
});
