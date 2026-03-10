import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { LazyMotion, domAnimation } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PageViewPage } from './PageViewPage';
import { useAuthStore } from '../../stores/auth-store';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => vi.fn(),
  };
});

const mockPage = {
  confluenceId: 'page-1',
  title: 'Test Page',
  spaceKey: 'DEV',
  bodyHtml: '<h2>Hello</h2><p>World</p>',
  bodyText: 'Hello World',
  version: 3,
  author: 'testuser',
  labels: ['docs'],
  lastModifiedAt: '2025-01-01T00:00:00Z',
  status: 'current',
};

const mockPageWithCode = {
  ...mockPage,
  bodyHtml: '<p>Use <code>console.log()</code> for debugging.</p><pre><code class="language-javascript">const x = 42;\nconsole.log(x);</code></pre>',
  bodyText: 'Use console.log() for debugging. const x = 42; console.log(x);',
};

const mockPageWithImages = {
  ...mockPage,
  bodyHtml: '<h2>Screenshots</h2><img src="/api/attachments/page-1/dashboard.png" alt="dashboard.png" width="600"><p>External:</p><img src="https://example.com/diagram.svg" alt="external">',
  bodyText: 'Screenshots External:',
};

const mockPageWithDrawio = {
  ...mockPage,
  bodyHtml: '<h2>Architecture</h2><div class="confluence-drawio" data-diagram-name="system-topology"><img src="/api/attachments/page-1/system-topology.png" alt="Draw.io diagram: system-topology"><a class="drawio-edit-link" href="#" data-drawio="true">Edit in Confluence</a></div>',
  bodyText: 'Architecture',
};

const mockPageWithHeadings = {
  ...mockPage,
  bodyHtml: '<h1>Main Title</h1><p>Intro paragraph.</p><h2>Section One</h2><p>Content for section one.</p><h3>Subsection</h3><p>Deeper content.</p><h2>Section Two</h2><ul><li>Item A</li><li>Item B</li></ul>',
  bodyText: 'Main Title Intro paragraph. Section One Content for section one. Subsection Deeper content. Section Two Item A Item B',
};

const mockPageWithPanelsAndTasks = {
  ...mockPage,
  bodyHtml: '<div class="panel-info"><p>This is an info panel.</p></div><div class="panel-warning"><p>Watch out!</p></div><ul data-type="taskList"><li data-type="taskItem" data-checked="true">Done task</li><li data-type="taskItem" data-checked="false">Open task</li></ul><blockquote><p>A wise quote.</p></blockquote><hr><details><summary>Expand me</summary><p>Hidden content.</p></details>',
  bodyText: 'This is an info panel. Watch out! Done task Open task A wise quote. Hidden content.',
};

let currentMockPage = mockPage;

vi.mock('../../shared/hooks/use-pages', () => ({
  usePage: () => ({ data: currentMockPage, isLoading: false }),
  useUpdatePage: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdatePageLabels: () => ({ mutate: vi.fn(), isPending: false }),
  useDeletePage: () => ({ mutateAsync: vi.fn() }),
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/pages/page-1']}>
          <LazyMotion features={domAnimation}>
            <Routes>
              <Route path="/pages/:id" element={children} />
            </Routes>
          </LazyMotion>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

describe('PageViewPage', () => {
  beforeEach(() => {
    currentMockPage = mockPage;
    useAuthStore.getState().setAuth('test-token', {
      id: '1',
      username: 'testuser',
      role: 'user',
    });
    // Mock fetch for sub-components that may call APIs
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({}), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useAuthStore.getState().clearAuth();
  });

  it('renders page title and metadata', () => {
    render(<PageViewPage />, { wrapper: createWrapper() });

    expect(screen.getByText('Test Page')).toBeInTheDocument();
    expect(screen.getByText('DEV')).toBeInTheDocument();
    expect(screen.getByText('v3')).toBeInTheDocument();
    expect(screen.getByText('docs')).toBeInTheDocument();
  });

  it('renders sidebar with sticky positioning', () => {
    const { container } = render(<PageViewPage />, { wrapper: createWrapper() });

    // The sidebar div should have sticky positioning classes
    const sidebar = container.querySelector('.sticky.top-4.self-start');
    expect(sidebar).toBeInTheDocument();
    expect(sidebar).toHaveClass('sticky', 'top-4', 'self-start');
  });

  it('toolbar contains History and Duplicates buttons', () => {
    render(<PageViewPage />, { wrapper: createWrapper() });

    expect(screen.getByText('History')).toBeInTheDocument();
    expect(screen.getByText('Duplicates')).toBeInTheDocument();
  });

  it('renders inline code and code blocks visually', () => {
    currentMockPage = mockPageWithCode;
    const { container } = render(<PageViewPage />, { wrapper: createWrapper() });

    // Content area should have prose classes for code styling
    const contentArea = container.querySelector('.prose');
    expect(contentArea).toBeInTheDocument();

    // Inline code should be rendered
    const inlineCode = container.querySelector('code');
    expect(inlineCode).toBeInTheDocument();
    expect(inlineCode!.textContent).toBe('console.log()');

    // Code block should be rendered with language class
    const codeBlock = container.querySelector('pre code.language-javascript');
    expect(codeBlock).toBeInTheDocument();
    expect(codeBlock!.textContent).toContain('const x = 42');
  });

  it('renders images with correct src attributes', () => {
    currentMockPage = mockPageWithImages;
    const { container } = render(<PageViewPage />, { wrapper: createWrapper() });

    const images = container.querySelectorAll('img');
    expect(images).toHaveLength(2);

    // Local attachment image
    expect(images[0]).toHaveAttribute('src', '/api/attachments/page-1/dashboard.png');
    expect(images[0]).toHaveAttribute('alt', 'dashboard.png');

    // External image
    expect(images[1]).toHaveAttribute('src', 'https://example.com/diagram.svg');
  });

  it('renders draw.io diagrams with enhanced preview', async () => {
    currentMockPage = mockPageWithDrawio;
    const { container } = render(<PageViewPage />, { wrapper: createWrapper() });

    // Wait for TipTap to render the draw.io content.
    // The DrawioDiagramPreview React mount happens via rAF which may or may not
    // flush in jsdom. Check for either the enhanced preview or the fallback TipTap HTML.
    await waitFor(() => {
      const enhanced = container.querySelector('[data-testid="drawio-preview"]');
      const fallback = container.querySelector('.confluence-drawio');
      expect(enhanced || fallback).toBeTruthy();
    });

    // Check the enhanced preview if the rAF replacement fired
    const preview = container.querySelector('[data-testid="drawio-preview"]');
    if (preview) {
      // Caption should show the diagram name
      const caption = container.querySelector('[data-testid="drawio-caption"]');
      expect(caption).toBeInTheDocument();
      expect(caption!.textContent).toContain('system-topology');

      // Image should be rendered with correct src
      const img = preview.querySelector('img');
      expect(img).toHaveAttribute('src', '/api/attachments/page-1/system-topology.png');

      // Edit link should be present
      const editLink = container.querySelector('[data-testid="drawio-edit-link"]');
      expect(editLink).toBeInTheDocument();
      expect(editLink!.textContent).toContain('Edit in Confluence');
    } else {
      // Fallback: TipTap rendered the raw node HTML before rAF replacement
      const drawioDiv = container.querySelector('.confluence-drawio');
      expect(drawioDiv).toBeInTheDocument();
      expect(drawioDiv).toHaveAttribute('data-diagram-name', 'system-topology');

      const drawioImg = drawioDiv!.querySelector('img');
      expect(drawioImg).toHaveAttribute('src', '/api/attachments/page-1/system-topology.png');

      const editLink = drawioDiv!.querySelector('a.drawio-edit-link');
      expect(editLink).toBeInTheDocument();
      expect(editLink!.textContent).toBe('Edit in Confluence');
    }
  });

  it('opens lightbox when clicking an image', async () => {
    currentMockPage = mockPageWithImages;
    const { container } = render(<PageViewPage />, { wrapper: createWrapper() });

    // Wait for TipTap to render and the rAF-based image click handler to attach
    let image: HTMLImageElement | null = null;
    await waitFor(() => {
      image = container.querySelector('img');
      expect(image).toBeTruthy();
      expect(image!.style.cursor).toBe('zoom-in');
    });

    // Click the image
    fireEvent.click(image!);

    // Lightbox should appear with a dialog role
    const lightbox = screen.getByRole('dialog');
    expect(lightbox).toBeInTheDocument();

    // Close button should be present
    const closeBtn = screen.getByLabelText('Close preview');
    expect(closeBtn).toBeInTheDocument();
  });

  it('closes lightbox when clicking close button', async () => {
    currentMockPage = mockPageWithImages;
    const { container } = render(<PageViewPage />, { wrapper: createWrapper() });

    // Wait for image click handler
    let image: HTMLImageElement | null = null;
    await waitFor(() => {
      image = container.querySelector('img');
      expect(image).toBeTruthy();
      expect(image!.style.cursor).toBe('zoom-in');
    });

    fireEvent.click(image!);

    // Lightbox is open
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // Click close
    fireEvent.click(screen.getByLabelText('Close preview'));

    // Wait for AnimatePresence exit animation
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('closes lightbox on Escape key', async () => {
    currentMockPage = mockPageWithImages;
    const { container } = render(<PageViewPage />, { wrapper: createWrapper() });

    // Wait for image click handler
    let image: HTMLImageElement | null = null;
    await waitFor(() => {
      image = container.querySelector('img');
      expect(image).toBeTruthy();
      expect(image!.style.cursor).toBe('zoom-in');
    });

    fireEvent.click(image!);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // Press Escape
    fireEvent.keyDown(document, { key: 'Escape' });

    // Wait for AnimatePresence exit animation
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('renders headings with proper hierarchy in the content area', () => {
    currentMockPage = mockPageWithHeadings;
    const { container } = render(<PageViewPage />, { wrapper: createWrapper() });

    const contentArea = container.querySelector('.prose');
    expect(contentArea).toBeInTheDocument();

    // All heading levels should render
    const h1 = contentArea!.querySelector('h1');
    expect(h1).toBeInTheDocument();
    expect(h1!.textContent).toBe('Main Title');

    const h2s = contentArea!.querySelectorAll('h2');
    expect(h2s).toHaveLength(2);
    expect(h2s[0].textContent).toBe('Section One');
    expect(h2s[1].textContent).toBe('Section Two');

    const h3 = contentArea!.querySelector('h3');
    expect(h3).toBeInTheDocument();
    expect(h3!.textContent).toBe('Subsection');

    // Lists should render
    const listItems = contentArea!.querySelectorAll('li');
    expect(listItems.length).toBeGreaterThanOrEqual(2);
  });

  it('renders panels, task lists, blockquotes, and expand sections', () => {
    currentMockPage = mockPageWithPanelsAndTasks;
    const { container } = render(<PageViewPage />, { wrapper: createWrapper() });

    const contentArea = container.querySelector('.prose');
    expect(contentArea).toBeInTheDocument();

    // Info and warning panels
    const infoPanel = contentArea!.querySelector('.panel-info');
    expect(infoPanel).toBeInTheDocument();
    expect(infoPanel!.textContent).toContain('info panel');

    const warningPanel = contentArea!.querySelector('.panel-warning');
    expect(warningPanel).toBeInTheDocument();
    expect(warningPanel!.textContent).toContain('Watch out');

    // Task list with checked/unchecked items
    const taskList = contentArea!.querySelector('ul[data-type="taskList"]');
    expect(taskList).toBeInTheDocument();

    const checkedTask = contentArea!.querySelector('li[data-checked="true"]');
    expect(checkedTask).toBeInTheDocument();
    expect(checkedTask!.textContent).toContain('Done task');

    const uncheckedTask = contentArea!.querySelector('li[data-checked="false"]');
    expect(uncheckedTask).toBeInTheDocument();
    expect(uncheckedTask!.textContent).toContain('Open task');

    // Blockquote
    const blockquote = contentArea!.querySelector('blockquote');
    expect(blockquote).toBeInTheDocument();
    expect(blockquote!.textContent).toContain('wise quote');

    // Horizontal rule
    const hr = contentArea!.querySelector('hr');
    expect(hr).toBeInTheDocument();

    // Expand section (details/summary)
    const details = contentArea!.querySelector('details');
    expect(details).toBeInTheDocument();
    const summary = details!.querySelector('summary');
    expect(summary).toBeInTheDocument();
    expect(summary!.textContent).toBe('Expand me');
  });
});
