import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ForceEmbedTree } from './ForceEmbedTree';
import { useAuthStore } from '../../stores/auth-store';

// Mock the SSE stream helper
vi.mock('../../shared/lib/sse', () => ({
  streamSSE: vi.fn(),
}));

import { streamSSE } from '../../shared/lib/sse';
const mockStreamSSE = vi.mocked(streamSSE);

describe('ForceEmbedTree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.getState().setAuth('test-token', {
      id: '1',
      username: 'testuser',
      role: 'user',
    });
  });

  afterEach(() => {
    useAuthStore.getState().clearAuth();
  });

  it('does not render when hasChildren is false', () => {
    const { container } = render(
      <ForceEmbedTree pageId="page-1" hasChildren={false} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders Embed Tree button when hasChildren is true', () => {
    render(<ForceEmbedTree pageId="page-1" hasChildren={true} />);
    expect(screen.getByText('Embed Tree')).toBeInTheDocument();
  });

  it('shows discovering state when clicked', async () => {
    // Create an async generator that yields discovering then completes
    async function* mockStream() {
      yield { phase: 'discovering', total: 0, completed: 0, done: false };
      yield { phase: 'embedding', total: 5, completed: 0, done: false };
      yield { phase: 'embedding', total: 5, completed: 3, errors: 0, currentPage: 'Page 3', done: false };
      yield { phase: 'complete', total: 5, completed: 5, errors: 0, done: true };
    }

    mockStreamSSE.mockReturnValue(mockStream() as AsyncGenerator<never>);

    render(<ForceEmbedTree pageId="page-1" hasChildren={true} />);

    fireEvent.click(screen.getByText('Embed Tree'));

    // Should eventually show completion
    await waitFor(() => {
      expect(screen.getByText(/Embedded 5 pages/)).toBeInTheDocument();
    });
  });

  it('shows progress during embedding', async () => {
    let resolveYield: (() => void) | null = null;

    async function* mockStream() {
      yield { phase: 'embedding', total: 10, completed: 0, done: false };
      // Wait to simulate in-progress
      await new Promise<void>((resolve) => { resolveYield = resolve; });
      yield { phase: 'embedding', total: 10, completed: 5, errors: 1, currentPage: 'Test Page', done: false };
      yield { phase: 'complete', total: 10, completed: 10, errors: 1, done: true };
    }

    mockStreamSSE.mockReturnValue(mockStream() as AsyncGenerator<never>);

    render(<ForceEmbedTree pageId="page-1" hasChildren={true} />);

    fireEvent.click(screen.getByText('Embed Tree'));

    // Should show initial progress
    await waitFor(() => {
      expect(screen.getByText(/0\/10 pages/)).toBeInTheDocument();
    });

    // Continue the stream
    resolveYield!();

    // Should show updated progress with errors
    await waitFor(() => {
      expect(screen.getByText(/Embedded 10 pages/)).toBeInTheDocument();
      expect(screen.getByText(/1 failed/)).toBeInTheDocument();
    });
  });

  it('disables button while running', async () => {
    let resolveStream: (() => void) | null = null;

    async function* mockStream() {
      yield { phase: 'discovering', total: 0, completed: 0, done: false };
      await new Promise<void>((resolve) => { resolveStream = resolve; });
      yield { phase: 'complete', total: 1, completed: 1, errors: 0, done: true };
    }

    mockStreamSSE.mockReturnValue(mockStream() as AsyncGenerator<never>);

    render(<ForceEmbedTree pageId="page-1" hasChildren={true} />);

    const button = screen.getByText('Embed Tree').closest('button')!;
    fireEvent.click(button);

    await waitFor(() => {
      expect(button).toBeDisabled();
    });

    resolveStream!();

    await waitFor(() => {
      expect(button).not.toBeDisabled();
    });
  });

  it('calls streamSSE with correct path and pageId', async () => {
    async function* mockStream() {
      yield { phase: 'complete', total: 1, completed: 1, errors: 0, done: true };
    }

    mockStreamSSE.mockReturnValue(mockStream() as AsyncGenerator<never>);

    render(<ForceEmbedTree pageId="page-42" hasChildren={true} />);

    fireEvent.click(screen.getByText('Embed Tree'));

    await waitFor(() => {
      expect(mockStreamSSE).toHaveBeenCalledWith(
        '/embeddings/force-embed-tree',
        { pageId: 'page-42' },
        expect.any(AbortSignal),
      );
    });
  });
});
