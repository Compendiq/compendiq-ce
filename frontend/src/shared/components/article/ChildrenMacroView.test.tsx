import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ChildrenMacroView } from './ChildrenMacroView';
import type { NodeViewProps } from '@tiptap/react';

// Mock the NodeViewWrapper since it's a TipTap component
vi.mock('@tiptap/react', () => ({
  NodeViewWrapper: ({ children, className, ...props }: { children: React.ReactNode; className?: string; [key: string]: unknown }) => (
    <div className={className} {...props}>{children}</div>
  ),
}));

// Mock apiFetch
const mockApiFetch = vi.fn();
vi.mock('../../lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

function makeProps(attrs: Record<string, string | null> = {}): NodeViewProps {
  return {
    node: {
      attrs: {
        sort: null,
        reverse: null,
        depth: null,
        first: null,
        page: null,
        style: null,
        excerptType: null,
        'macro-name': null,
        ...attrs,
      },
    },
    updateAttributes: vi.fn(),
    deleteNode: vi.fn(),
    editor: { isEditable: false },
    getPos: () => 0,
    extension: {} as NodeViewProps['extension'],
    HTMLAttributes: {},
    decorations: [],
    selected: false,
  } as unknown as NodeViewProps;
}

function renderWithRouter(props: NodeViewProps, pageId = '42') {
  return render(
    <MemoryRouter initialEntries={[`/pages/${pageId}`]}>
      <Routes>
        <Route path="/pages/:id" element={<ChildrenMacroView {...props} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ChildrenMacroView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockApiFetch.mockReturnValue(new Promise(() => {})); // never resolves
    renderWithRouter(makeProps());

    expect(screen.getByTestId('children-loading')).toBeTruthy();
    expect(screen.getByText('Child Pages')).toBeTruthy();
  });

  it('renders a list of child pages', async () => {
    mockApiFetch.mockResolvedValueOnce({
      children: [
        { id: 1, confluenceId: 'child-1', title: 'Getting Started', spaceKey: 'DEV' },
        { id: 2, confluenceId: 'child-2', title: 'Installation Guide', spaceKey: 'DEV' },
      ],
    });

    renderWithRouter(makeProps());

    await waitFor(() => {
      expect(screen.getByTestId('children-list')).toBeTruthy();
    });

    expect(screen.getByText('Getting Started')).toBeTruthy();
    expect(screen.getByText('Installation Guide')).toBeTruthy();

    // Links should point to page routes using integer IDs
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute('href')).toBe('/pages/1');
    expect(links[1].getAttribute('href')).toBe('/pages/2');
  });

  it('shows empty message when no children exist', async () => {
    mockApiFetch.mockResolvedValueOnce({ children: [] });

    renderWithRouter(makeProps());

    await waitFor(() => {
      expect(screen.getByTestId('children-empty')).toBeTruthy();
    });

    expect(screen.getByText('No child pages')).toBeTruthy();
  });

  it('shows error state on fetch failure', async () => {
    mockApiFetch.mockRejectedValueOnce(new Error('Network error'));

    renderWithRouter(makeProps());

    await waitFor(() => {
      expect(screen.getByTestId('children-error')).toBeTruthy();
    });

    expect(screen.getByText('Network error')).toBeTruthy();
  });

  it('renders nested children when depth > 1', async () => {
    mockApiFetch.mockResolvedValueOnce({
      children: [
        {
          id: 1,
          confluenceId: 'parent',
          title: 'Parent Page',
          spaceKey: 'DEV',
          children: [
            { id: 2, confluenceId: 'child', title: 'Nested Child', spaceKey: 'DEV' },
          ],
        },
      ],
    });

    renderWithRouter(makeProps({ depth: '2' }));

    await waitFor(() => {
      expect(screen.getByTestId('children-list')).toBeTruthy();
    });

    expect(screen.getByText('Parent Page')).toBeTruthy();
    expect(screen.getByText('Nested Child')).toBeTruthy();
  });

  it('passes correct query params to the API', async () => {
    mockApiFetch.mockResolvedValueOnce({ children: [] });

    renderWithRouter(makeProps({ sort: 'creation', depth: '2', reverse: 'true' }));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledTimes(1);
    });

    const callPath = mockApiFetch.mock.calls[0][0] as string;
    expect(callPath).toContain('/pages/42/children');
    expect(callPath).toContain('sort=created_at');
    expect(callPath).toContain('order=desc');
    expect(callPath).toContain('depth=2');
  });

  it('does not fetch when no page ID is available', async () => {
    render(
      <MemoryRouter initialEntries={['/other']}>
        <Routes>
          <Route path="/other" element={<ChildrenMacroView {...makeProps()} />} />
        </Routes>
      </MemoryRouter>,
    );

    // Should not call the API and should not show loading
    await waitFor(() => {
      expect(mockApiFetch).not.toHaveBeenCalled();
    });
  });
});
