import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { NewPagePage } from './NewPagePage';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const mockCreateMutateAsync = vi.fn();
vi.mock('../../shared/hooks/use-pages', () => ({
  useCreatePage: () => ({
    mutateAsync: mockCreateMutateAsync,
    isPending: false,
  }),
  usePageTree: () => ({
    data: {
      items: [
        { id: 'page-1', spaceKey: 'DEV', title: 'Getting Started', parentId: null, labels: [], lastModifiedAt: '2026-03-01T00:00:00Z', embeddingDirty: false },
        { id: 'page-2', spaceKey: 'DEV', title: 'Installation', parentId: 'page-1', labels: [], lastModifiedAt: '2026-03-01T00:00:00Z', embeddingDirty: false },
      ],
      total: 2,
    },
    isLoading: false,
  }),
}));

vi.mock('../../shared/hooks/use-spaces', () => ({
  useSpaces: () => ({
    data: [
      { key: 'DEV', name: 'Development', homepageId: null, lastSynced: '2026-03-01T00:00:00Z', pageCount: 10 },
      { key: 'OPS', name: 'Operations', homepageId: null, lastSynced: '2026-03-01T00:00:00Z', pageCount: 5 },
    ],
  }),
}));

const { editorHtml, mockSetContent, mockEditorInstance, mockUseTemplateMutateAsync, mockImportMutateAsync, templatesState } = vi.hoisted(() => {
  // Live HTML the fake editor owns. setContent (template apply) and the
  // textarea's onChange (typing) both write here; getHTML reads it — mirroring
  // the real Editor now that the body is read off the instance, not synced to
  // parent state per keystroke (#954).
  const html = { current: '' };
  const setContent = vi.fn((content: string) => { html.current = content; });
  return {
    editorHtml: html,
    mockSetContent: setContent,
    mockEditorInstance: { commands: { setContent }, getHTML: () => html.current },
    mockUseTemplateMutateAsync: vi.fn(),
    mockImportMutateAsync: vi.fn(),
    templatesState: { items: [] as { id: number; title: string; category: string | null }[] },
  };
});

vi.mock('../../shared/hooks/use-standalone', () => ({
  // GET /api/templates returns a bare array — mirror the real wire shape.
  useTemplates: () => ({ data: templatesState.items, isLoading: false }),
  useUseTemplate: () => ({ mutateAsync: mockUseTemplateMutateAsync, isPending: false }),
  useImportMarkdown: () => ({ mutateAsync: mockImportMutateAsync, isPending: false }),
  useLocalSpaces: () => ({
    data: [
      { key: '__local__', name: 'Default Local Space', source: 'local', description: null, icon: null, pageCount: 0, createdBy: null, createdAt: '2026-01-01T00:00:00Z' },
      { key: 'notes', name: 'My Notes', source: 'local', description: null, icon: null, pageCount: 3, createdBy: null, createdAt: '2026-01-01T00:00:00Z' },
    ],
  }),
}));

// Mock Editor to avoid complex TipTap setup. It reports a fake editor
// instance via onEditorReady (like the real Editor does once TipTap is up)
// so the template flow can insert content into the "live" editor.
vi.mock('../../shared/components/article/Editor', async () => {
  const { useEffect } = await import('react');
  return {
    Editor: ({ onChange, onEditorReady }: { content: string; onChange?: (dirty: boolean) => void; placeholder: string; draftKey: string; onEditorReady?: (editor: unknown) => void }) => {
      useEffect(() => {
        onEditorReady?.(mockEditorInstance);
        return () => onEditorReady?.(null);
      }, [onEditorReady]);
      return (
        <textarea
          data-testid="mock-editor"
          onChange={(e) => {
            // Typing writes the live HTML the fake instance serves via getHTML,
            // then signals dirty (the parent no longer receives the HTML).
            editorHtml.current = e.target.value;
            onChange?.(true);
          }}
        />
      );
    },
    EditorToolbar: () => null,
    TableContextToolbar: () => null,
    LayoutContextToolbar: () => null,
    ColumnContextToolbar: () => null,
    clearDraft: vi.fn(),
  };
});

vi.mock('../../shared/components/feedback/FeatureErrorBoundary', () => ({
  FeatureErrorBoundary: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

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

describe('NewPagePage', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockCreateMutateAsync.mockClear();
    mockSetContent.mockClear();
    mockUseTemplateMutateAsync.mockReset();
    mockImportMutateAsync.mockReset();
    templatesState.items.length = 0;
    editorHtml.current = '';
  });

  it('navigates to the imported page using articles[0].id from the import envelope', async () => {
    mockImportMutateAsync.mockResolvedValue({
      imported: 1,
      total: 1,
      articles: [{ id: 'standalone-xyz', title: 'note', success: true }],
    });
    render(<NewPagePage />, { wrapper: createWrapper() });
    const input = screen.getByTestId('import-markdown-input');
    const file = new File(['# hi'], 'note.md', { type: 'text/markdown' });
    fireEvent.change(input, { target: { files: [file] } });
    // Real bug: the old code read result.id (undefined) → navigated to /pages/undefined.
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/pages/standalone-xyz'));
  });

  it('renders the New Page title and form fields', () => {
    render(<NewPagePage />, { wrapper: createWrapper() });
    expect(screen.getByText('New Page')).toBeInTheDocument();
    expect(screen.getByTestId('title-input')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Untitled page')).toBeInTheDocument();
  });

  it('exposes an accessible name on the back button (#939)', () => {
    render(<NewPagePage />, { wrapper: createWrapper() });
    expect(screen.getByRole('button', { name: /back to pages/i })).toBeInTheDocument();
  });

  it('shows article type toggle defaulting to Local Article', () => {
    render(<NewPagePage />, { wrapper: createWrapper() });
    expect(screen.getByTestId('article-type-local')).toBeInTheDocument();
    expect(screen.getByTestId('article-type-confluence')).toBeInTheDocument();
  });

  it('exposes aria-pressed on the article type toggle buttons (#955)', () => {
    // These are toggle buttons — screen-reader users need aria-pressed to know
    // which type is currently selected. Default is Local.
    render(<NewPagePage />, { wrapper: createWrapper() });
    expect(screen.getByTestId('article-type-local')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('article-type-confluence')).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByTestId('article-type-confluence'));
    expect(screen.getByTestId('article-type-local')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('article-type-confluence')).toHaveAttribute('aria-pressed', 'true');
  });

  it('exposes aria-pressed on the visibility toggle buttons (#955)', async () => {
    render(<NewPagePage />, { wrapper: createWrapper() });
    // Visibility picker only renders once a local space is selected.
    fireEvent.change(screen.getByTestId('space-selector'), { target: { value: '__local__' } });
    await waitFor(() => {
      expect(screen.getByTestId('visibility-picker')).toBeInTheDocument();
    });
    // Default visibility is Private.
    expect(screen.getByTestId('visibility-private')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('visibility-shared')).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByTestId('visibility-shared'));
    expect(screen.getByTestId('visibility-private')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('visibility-shared')).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows space selector always visible', () => {
    render(<NewPagePage />, { wrapper: createWrapper() });
    // Space selector is always shown regardless of article type
    expect(screen.getByTestId('space-selector')).toBeInTheDocument();
  });

  it('shows space selector when Confluence article type is selected', () => {
    render(<NewPagePage />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('article-type-confluence'));
    expect(screen.getByTestId('space-selector')).toBeInTheDocument();
  });

  it('shows local space options when Local type is active', () => {
    render(<NewPagePage />, { wrapper: createWrapper() });
    // Default is local — local spaces should appear as options
    const selector = screen.getByTestId('space-selector');
    expect(selector).toContainElement(screen.getByRole('option', { name: 'Default Local Space' }));
    expect(selector).toContainElement(screen.getByRole('option', { name: 'My Notes' }));
  });

  it('shows confluence space options when Confluence type is active', () => {
    render(<NewPagePage />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('article-type-confluence'));
    const selector = screen.getByTestId('space-selector');
    expect(selector).toContainElement(screen.getByRole('option', { name: 'Development' }));
    expect(selector).toContainElement(screen.getByRole('option', { name: 'Operations' }));
  });

  it('shows location picker when a Confluence space is selected', async () => {
    render(<NewPagePage />, { wrapper: createWrapper() });

    // Switch to Confluence mode
    fireEvent.click(screen.getByTestId('article-type-confluence'));

    // Select a space
    const spaceSelect = screen.getByTestId('space-selector');
    fireEvent.change(spaceSelect, { target: { value: 'DEV' } });

    // Location picker section should appear
    await waitFor(() => {
      expect(screen.getByTestId('location-picker-section')).toBeInTheDocument();
    });
  });

  it('does not show location picker when no space is selected', () => {
    render(<NewPagePage />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('article-type-confluence'));
    expect(screen.queryByTestId('location-picker-section')).not.toBeInTheDocument();
  });

  it('does not show location picker for local articles until a space is selected', () => {
    render(<NewPagePage />, { wrapper: createWrapper() });
    // Default is local — no space selected yet, so no location picker
    expect(screen.queryByTestId('location-picker-section')).not.toBeInTheDocument();
  });

  it('shows location picker for local articles after selecting a local space', async () => {
    render(<NewPagePage />, { wrapper: createWrapper() });
    // Default is local — select a local space
    fireEvent.change(screen.getByTestId('space-selector'), { target: { value: '__local__' } });
    await waitFor(() => {
      expect(screen.getByTestId('location-picker-section')).toBeInTheDocument();
    });
  });

  it('shows visibility picker when a local space is selected', async () => {
    render(<NewPagePage />, { wrapper: createWrapper() });
    fireEvent.change(screen.getByTestId('space-selector'), { target: { value: '__local__' } });
    await waitFor(() => {
      expect(screen.getByTestId('visibility-picker')).toBeInTheDocument();
    });
  });

  it('does not show visibility picker when a confluence space is selected', async () => {
    render(<NewPagePage />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('article-type-confluence'));
    fireEvent.change(screen.getByTestId('space-selector'), { target: { value: 'DEV' } });
    await waitFor(() => {
      expect(screen.queryByTestId('visibility-picker')).not.toBeInTheDocument();
    });
  });

  it('switching article type resets spaceKey (location picker disappears)', async () => {
    render(<NewPagePage />, { wrapper: createWrapper() });

    // Select a local space
    fireEvent.change(screen.getByTestId('space-selector'), { target: { value: '__local__' } });
    await waitFor(() => {
      expect(screen.getByTestId('location-picker-section')).toBeInTheDocument();
    });

    // Switch to confluence — spaceKey should reset
    fireEvent.click(screen.getByTestId('article-type-confluence'));
    await waitFor(() => {
      expect(screen.queryByTestId('location-picker-section')).not.toBeInTheDocument();
    });
  });

  it('create button is disabled when no space selected', () => {
    render(<NewPagePage />, { wrapper: createWrapper() });
    // Enter a title but no space selected
    fireEvent.change(screen.getByTestId('title-input'), { target: { value: 'My Page' } });
    const createBtn = screen.getByText('Create Page');
    expect(createBtn.closest('button')).toBeDisabled();
  });

  it('create button is enabled after title and space are both set', async () => {
    render(<NewPagePage />, { wrapper: createWrapper() });
    fireEvent.change(screen.getByTestId('title-input'), { target: { value: 'My Page' } });
    fireEvent.change(screen.getByTestId('space-selector'), { target: { value: '__local__' } });
    await waitFor(() => {
      const createBtn = screen.getByText('Create Page');
      expect(createBtn.closest('button')).not.toBeDisabled();
    });
  });

  it('explains the disabled Create Page button via a hover hint', () => {
    render(<NewPagePage />, { wrapper: createWrapper() });
    const createBtn = screen.getByText('Create Page').closest('button')!;
    expect(createBtn).toBeDisabled();
    // nm-button-primary sets pointer-events:none on :disabled, which swallows
    // a title tooltip placed on the button itself — the wrapping span carries it.
    const hintCarrier = createBtn.closest('[title]');
    expect(hintCarrier).not.toBeNull();
    expect(hintCarrier).toHaveAttribute('title', 'Enter a title and select a space first');
  });

  it('drops the hover hint once the Create Page button is enabled', async () => {
    render(<NewPagePage />, { wrapper: createWrapper() });
    fireEvent.change(screen.getByTestId('title-input'), { target: { value: 'My Page' } });
    fireEvent.change(screen.getByTestId('space-selector'), { target: { value: '__local__' } });
    await waitFor(() => {
      expect(screen.getByText('Create Page').closest('button')).not.toBeDisabled();
    });
    expect(screen.getByText('Create Page').closest('[title]')).toBeNull();
  });

  it('shows the disabled-create hint as visible text wired via aria-describedby', () => {
    // A title tooltip is mouse-only — keyboard, touch and screen-reader users
    // need the explanation too, so it must exist as real text in the DOM and
    // be linked to the button for assistive tech.
    render(<NewPagePage />, { wrapper: createWrapper() });
    const createBtn = screen.getByText('Create Page').closest('button')!;
    expect(createBtn).toBeDisabled();

    const hint = screen.getByText('Enter a title and select a space first', {
      selector: '#create-page-hint',
    });
    expect(hint).toBeInTheDocument();
    expect(createBtn).toHaveAttribute('aria-describedby', 'create-page-hint');
  });

  it('removes the visible hint once the Create Page button is enabled', async () => {
    render(<NewPagePage />, { wrapper: createWrapper() });
    fireEvent.change(screen.getByTestId('title-input'), { target: { value: 'My Page' } });
    fireEvent.change(screen.getByTestId('space-selector'), { target: { value: '__local__' } });
    await waitFor(() => {
      expect(screen.getByText('Create Page').closest('button')).not.toBeDisabled();
    });
    expect(document.querySelector('#create-page-hint')).toBeNull();
    expect(screen.getByText('Create Page').closest('button')).not.toHaveAttribute('aria-describedby');
  });

  it('submit uses the selected local spaceKey (not hardcoded __local__)', async () => {
    mockCreateMutateAsync.mockResolvedValueOnce({ id: 'new-page-id', title: 'My Notes Page', version: 1 });

    render(<NewPagePage />, { wrapper: createWrapper() });

    // Select the "My Notes" local space
    fireEvent.change(screen.getByTestId('space-selector'), { target: { value: 'notes' } });
    fireEvent.change(screen.getByTestId('title-input'), { target: { value: 'My Notes Page' } });

    fireEvent.click(screen.getByText('Create Page'));

    await waitFor(() => {
      expect(mockCreateMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          spaceKey: 'notes',
          title: 'My Notes Page',
        }),
      );
    });
  });

  it('creates a page with parentId when location is selected', async () => {
    mockCreateMutateAsync.mockResolvedValueOnce({ id: 'new-page-id', title: 'Child', version: 1 });

    render(<NewPagePage />, { wrapper: createWrapper() });

    // Switch to Confluence mode and select space
    fireEvent.click(screen.getByTestId('article-type-confluence'));
    fireEvent.change(screen.getByTestId('space-selector'), { target: { value: 'DEV' } });

    // Wait for location picker
    await waitFor(() => {
      expect(screen.getByTestId('location-picker-section')).toBeInTheDocument();
    });

    // Open the location picker
    fireEvent.click(screen.getByLabelText('Select page location'));

    // Wait for tree to render
    await waitFor(() => {
      expect(screen.getByText('Getting Started')).toBeInTheDocument();
    });

    // Select "Getting Started" as parent
    fireEvent.click(screen.getByText('Getting Started'));
    fireEvent.click(screen.getByText('Confirm'));

    // Fill in title
    fireEvent.change(screen.getByPlaceholderText('Untitled page'), { target: { value: 'Child Page' } });

    // Add editor content
    fireEvent.change(screen.getByTestId('mock-editor'), { target: { value: '<p>Content</p>' } });

    // Create the page
    fireEvent.click(screen.getByText('Create Page'));

    await waitFor(() => {
      expect(mockCreateMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          spaceKey: 'DEV',
          title: 'Child Page',
          parentId: 'page-1',
        }),
      );
    });
  });

  it('resets parentId when space changes', async () => {
    render(<NewPagePage />, { wrapper: createWrapper() });

    // Switch to Confluence
    fireEvent.click(screen.getByTestId('article-type-confluence'));

    // Select DEV space
    fireEvent.change(screen.getByTestId('space-selector'), { target: { value: 'DEV' } });

    await waitFor(() => {
      expect(screen.getByTestId('location-picker-section')).toBeInTheDocument();
    });

    // Open picker, select a parent
    fireEvent.click(screen.getByLabelText('Select page location'));
    await waitFor(() => {
      expect(screen.getByText('Getting Started')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Getting Started'));
    fireEvent.click(screen.getByText('Confirm'));

    // Now change the space
    fireEvent.change(screen.getByTestId('space-selector'), { target: { value: 'OPS' } });

    // The breadcrumb should reset to Root level
    await waitFor(() => {
      expect(screen.getByText('Root')).toBeInTheDocument();
    });
  });

  describe('template gallery', () => {
    it('inserts the selected template into the live editor via setContent', async () => {
      templatesState.items.push({ id: 1, title: 'Meeting Notes', category: 'General' });
      mockUseTemplateMutateAsync.mockResolvedValueOnce({ bodyJson: null, bodyHtml: '<p>Template body</p>' });

      render(<NewPagePage />, { wrapper: createWrapper() });

      fireEvent.click(screen.getByTestId('use-template-btn'));
      fireEvent.click(screen.getByText('Meeting Notes'));

      // The template HTML must reach the TipTap editor itself — bodyHtml state
      // alone is invisible (Editor mounts with content="") and gets overwritten
      // by the first keystroke's onUpdate.
      await waitFor(() => {
        expect(mockSetContent).toHaveBeenCalledWith('<p>Template body</p>', { emitUpdate: true });
      });
      expect(screen.queryByTestId('template-gallery-modal')).not.toBeInTheDocument();
    });

    it('exposes the template gallery with role="dialog" for assistive tech', async () => {
      templatesState.items.push({ id: 1, title: 'Meeting Notes', category: 'General' });

      render(<NewPagePage />, { wrapper: createWrapper() });

      fireEvent.click(screen.getByTestId('use-template-btn'));

      expect(await screen.findByRole('dialog')).toBeInTheDocument();
    });

    it('closes the template gallery on Escape', async () => {
      templatesState.items.push({ id: 1, title: 'Meeting Notes', category: 'General' });

      render(<NewPagePage />, { wrapper: createWrapper() });

      fireEvent.click(screen.getByTestId('use-template-btn'));

      const dialog = await screen.findByRole('dialog');
      fireEvent.keyDown(dialog, { key: 'Escape' });

      await waitFor(() => {
        expect(screen.queryByTestId('template-gallery-modal')).not.toBeInTheDocument();
      });
    });

    it('includes the applied template content in the create payload', async () => {
      templatesState.items.push({ id: 1, title: 'Meeting Notes', category: null });
      mockUseTemplateMutateAsync.mockResolvedValueOnce({ bodyJson: null, bodyHtml: '<p>Template body</p>' });
      mockCreateMutateAsync.mockResolvedValueOnce({ id: 'new-page-id', title: 'From Template', version: 1 });

      render(<NewPagePage />, { wrapper: createWrapper() });

      fireEvent.click(screen.getByTestId('use-template-btn'));
      fireEvent.click(screen.getByText('Meeting Notes'));
      await waitFor(() => {
        expect(screen.queryByTestId('template-gallery-modal')).not.toBeInTheDocument();
      });

      fireEvent.change(screen.getByTestId('title-input'), { target: { value: 'From Template' } });
      fireEvent.change(screen.getByTestId('space-selector'), { target: { value: '__local__' } });
      fireEvent.click(screen.getByText('Create Page'));

      await waitFor(() => {
        expect(mockCreateMutateAsync).toHaveBeenCalledWith(
          expect.objectContaining({ bodyHtml: '<p>Template body</p>' }),
        );
      });
    });
  });
});
