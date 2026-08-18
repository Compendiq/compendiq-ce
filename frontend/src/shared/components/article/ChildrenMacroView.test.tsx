import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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

function makeProps(
  attrs: Record<string, string | null> = {},
  editor: { isEditable?: boolean } = {},
): NodeViewProps {
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
        columns: null,
        'macro-name': null,
        ...attrs,
      },
    },
    updateAttributes: vi.fn(),
    deleteNode: vi.fn(),
    editor: { isEditable: false, ...editor },
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
    expect(screen.getByText('Loading child pages')).toBeTruthy();
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

    // Marker-free directory: no disc column, and a single stack by default.
    const list = screen.getByTestId('children-list').querySelector('ul');
    expect(list?.classList.contains('list-disc')).toBe(false);
    expect(list?.classList.contains('list-none')).toBe(true);
    expect(screen.getByTestId('children-macro-view').getAttribute('data-columns')).toBe('1');
    expect(screen.queryByTestId('children-columns-toggle')).toBeNull();
  });

  it('shows empty message when no children exist', async () => {
    mockApiFetch.mockResolvedValueOnce({ children: [] });

    renderWithRouter(makeProps());

    await waitFor(() => {
      expect(screen.getByTestId('children-empty')).toBeTruthy();
    });

    expect(screen.getByText('This page has no children')).toBeTruthy();
  });

  it('shows error state on fetch failure', async () => {
    mockApiFetch.mockRejectedValueOnce(new Error('Network error'));

    renderWithRouter(makeProps());

    await waitFor(() => {
      expect(screen.getByTestId('children-error')).toBeTruthy();
    });

    expect(screen.getByRole('alert').textContent).toBe("Couldn't load child pages.");
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
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

  it('splits the top-level list into two columns when columns=2', async () => {
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
        { id: 3, confluenceId: 'sibling', title: 'Sibling Page', spaceKey: 'DEV' },
      ],
    });

    renderWithRouter(makeProps({ columns: '2' }));

    await waitFor(() => {
      expect(screen.getByTestId('children-list')).toBeTruthy();
    });

    expect(screen.getByTestId('children-macro-view').getAttribute('data-columns')).toBe('2');
    const lists = screen.getByTestId('children-list').querySelectorAll('ul');
    expect(lists[0]?.classList.contains('sm:grid-cols-2')).toBe(true);
    // Nested directory stays a stack under its parent — two columns is a
    // top-level layout, not a recursive one.
    expect(lists[1]?.classList.contains('sm:grid-cols-2')).toBe(false);
    expect(lists[1]?.classList.contains('flex')).toBe(true);
  });

  it('exposes a two-column toggle only while editing', async () => {
    mockApiFetch.mockResolvedValue({
      children: [
        { id: 1, confluenceId: 'child-1', title: 'Getting Started', spaceKey: 'DEV' },
      ],
    });

    const { unmount } = renderWithRouter(makeProps());
    await waitFor(() => {
      expect(screen.getByTestId('children-list')).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: 'Two columns' })).toBeNull();
    unmount();

    const updateAttributes = vi.fn();
    const editable = makeProps({}, { isEditable: true });
    editable.updateAttributes = updateAttributes;
    renderWithRouter(editable);

    await waitFor(() => {
      expect(screen.getByTestId('children-list')).toBeTruthy();
    });

    const toggle = screen.getByRole('button', { name: 'Two columns' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByTestId('children-columns-hint').textContent).toContain(
      'Compendiq only',
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Getting Started').tagName).toBe('SPAN');
    toggle.click();
    expect(updateAttributes).toHaveBeenCalledWith({ columns: '2' });
  });

  it('clears the columns param when the pressed toggle is clicked', async () => {
    mockApiFetch.mockResolvedValueOnce({
      children: [
        { id: 1, confluenceId: 'child-1', title: 'Getting Started', spaceKey: 'DEV' },
      ],
    });

    const updateAttributes = vi.fn();
    const editable = makeProps({ columns: '2' }, { isEditable: true });
    editable.updateAttributes = updateAttributes;
    renderWithRouter(editable);

    await waitFor(() => {
      expect(screen.getByTestId('children-list')).toBeTruthy();
    });

    const toggle = screen.getByRole('button', { name: 'Two columns' });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    toggle.click();
    expect(updateAttributes).toHaveBeenCalledWith({ columns: null });
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

  it('names unused Confluence params in edit mode when they are present', async () => {
    mockApiFetch.mockResolvedValueOnce({ children: [] });

    renderWithRouter(makeProps({ page: 'Other Page', style: 'h3' }, { isEditable: true }));

    await waitFor(() => {
      expect(screen.getByTestId('children-empty')).toBeTruthy();
    });

    expect(screen.getByTestId('children-unused-params').textContent).toContain(
      "This list is always this page's children",
    );
  });

  it('retries a failed fetch from the error control', async () => {
    mockApiFetch
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({
        children: [{ id: 1, confluenceId: 'child-1', title: 'Getting Started', spaceKey: 'DEV' }],
      });

    renderWithRouter(makeProps());

    await waitFor(() => {
      expect(screen.getByTestId('children-error')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => {
      expect(screen.getByTestId('children-list')).toBeTruthy();
    });
    expect(screen.getByText('Getting Started')).toBeTruthy();
    expect(mockApiFetch).toHaveBeenCalledTimes(2);
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
    expect(screen.getByText('Child pages will appear on a saved page.')).toBeTruthy();
  });

  it('is a document directory without gadget card framing or an injected title', async () => {
    mockApiFetch.mockResolvedValueOnce({ children: [] });
    renderWithRouter(makeProps());

    await waitFor(() => {
      expect(screen.getByTestId('children-empty')).toBeTruthy();
    });

    const view = screen.getByTestId('children-macro-view');
    expect(view.classList.contains('border')).toBe(false);
    expect(view.classList.contains('rounded-lg')).toBe(false);
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.queryByText('Children of this page')).toBeNull();
  });
});
