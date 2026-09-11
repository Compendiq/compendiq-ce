import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
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

    // Marker-free directory: no disc column, two columns by default.
    const list = screen.getByTestId('children-list').querySelector('ul');
    expect(list?.classList.contains('list-disc')).toBe(false);
    expect(list?.classList.contains('list-none')).toBe(true);
    expect(list?.classList.contains('sm:grid-cols-2')).toBe(true);
    expect(screen.getByTestId('children-macro-view').getAttribute('data-columns')).toBe('2');
    expect(screen.queryByTestId('children-columns-toggle')).toBeNull();

    // Notion-style page links: body colour + underline. The accent prose-link
    // colour and the old padded row (`px-2`) are the two things that made
    // this read as chrome rather than document. Hover uses the same accent
    // fill as PagesPage / the page tree — a background change, not a border.
    expect(links[0].classList.contains('children-directory-link')).toBe(true);
    const titleEl = links[0].querySelector('.children-directory-title');
    expect(titleEl?.textContent).toBe('Getting Started');
    // Title stays inline (not a flex item) so the rule paints through spaces.
    expect(titleEl?.parentElement).not.toBe(links[0]);
    expect(links[0].className).not.toMatch(/text-primary/);
    expect(links[0].className).not.toMatch(/(?:^|\s)px-2(?:\s|$)/);
    expect(links[0].className).toMatch(/(?:^|\s)py-0\.5(?:\s|$)/);
    expect(links[0].className).not.toMatch(/(?:^|\s)py-1(?:\s|$)/);
    expect(links[0].className).toMatch(/hover:bg-accent/);
    expect(links[0].className).toMatch(/rounded-md/);
    expect(links[0].className).toMatch(/transition-colors/);
    expect(list?.className).toMatch(/(?:^|\s)gap-y-0(?:\s|$)/);
    expect(list?.className).not.toMatch(/(?:^|\s)gap-1(?:\s|$)/);
    expect(list?.className).not.toMatch(/(?:^|\s)pl-3(?:\s|$)/);
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

    // Nested titles start on the same left edge as the article, not a tree gutter.
    const nested = screen.getByTestId('children-list').querySelector('ul ul');
    expect(nested?.className).not.toMatch(/(?:^|\s)pl-3(?:\s|$)/);
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
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByTestId('children-columns-hint').textContent).toContain(
      'Compendiq only',
    );
    expect(screen.queryByRole('link')).toBeNull();
    const title = screen.getByText('Getting Started');
    expect(title.tagName).toBe('SPAN');
    // Edit-mode titles are not navigable, so they must not wear the
    // pages-list hover fill — that would advertise a click that is not there.
    expect(title.className).not.toMatch(/hover:bg-accent/);
    toggle.click();
    expect(updateAttributes).toHaveBeenCalledWith({ columns: '1' });
  });

  it('writes columns=1 when the pressed default toggle is clicked', async () => {
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
    expect(updateAttributes).toHaveBeenCalledWith({ columns: '1' });
  });

  it('keeps a single stack when columns=1', async () => {
    mockApiFetch.mockResolvedValueOnce({
      children: [
        { id: 1, confluenceId: 'child-1', title: 'Getting Started', spaceKey: 'DEV' },
        { id: 2, confluenceId: 'child-2', title: 'Installation Guide', spaceKey: 'DEV' },
      ],
    });

    const updateAttributes = vi.fn();
    const editable = makeProps({ columns: '1' }, { isEditable: true });
    editable.updateAttributes = updateAttributes;
    renderWithRouter(editable);

    await waitFor(() => {
      expect(screen.getByTestId('children-list')).toBeTruthy();
    });

    expect(screen.getByTestId('children-macro-view').getAttribute('data-columns')).toBe('1');
    const list = screen.getByTestId('children-list').querySelector('ul');
    expect(list?.classList.contains('sm:grid-cols-2')).toBe(false);
    expect(list?.classList.contains('flex')).toBe(true);

    const toggle = screen.getByRole('button', { name: 'Two columns' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    toggle.click();
    expect(updateAttributes).toHaveBeenCalledWith({ columns: '2' });
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

describe('ChildrenMacroView link treatment', () => {
  const css = readFileSync(resolve(__dirname, '../../../index.css'), 'utf-8');

  it('overrides prose accent links with an inherited, always-underlined title', () => {
    expect(css).toMatch(
      /\.prose \.confluence-children-view a[\s\S]*?color:\s*inherit[\s\S]*?text-decoration:\s*none/,
    );
    const start = css.indexOf('.prose .confluence-children-view a,');
    expect(start).toBeGreaterThan(-1);
    const block = css.slice(start, start + 2800);
    expect(block).not.toMatch(/--color-primary/);
    // Continuous rule under the whole phrase, spaces included. text-decoration
    // skip-spaces is missing in WebKit and still gaps a multi-word title.
    expect(block).toMatch(/\.children-directory-title[\s\S]*?background-image:\s*linear-gradient/);
    expect(block).toMatch(/box-decoration-break:\s*clone/);
    expect(block).not.toMatch(/text-decoration-skip-spaces/);
    expect(block).toMatch(/color-mix\(in oklab, var\(--color-foreground\) 22%, transparent\)/);
    expect(block).toMatch(/\[data-theme-type="light"\][\s\S]*?color-mix\(in oklab, var\(--color-foreground\) 16%, transparent\)/);
    expect(block).not.toMatch(/text-decoration-color:\s*var\(--color-foreground\)/);
    expect(css).toMatch(/\.confluence-children-view ul ul\s*\{\s*padding-inline-start:\s*0;/);
    expect(css).toMatch(/\.confluence-children-view li\s*\{\s*padding-inline-start:\s*0;/);
    // Prose's `transition: color, text-decoration` would snap the row fill
    // unless this override includes background-color.
    expect(block).toMatch(/background-color\s+0\.15s/);
  });
});
