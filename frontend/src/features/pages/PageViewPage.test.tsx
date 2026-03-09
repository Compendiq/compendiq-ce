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

  it('sidebar contains version history and duplicate detector sections', () => {
    render(<PageViewPage />, { wrapper: createWrapper() });

    expect(screen.getByText('Duplicate Detection')).toBeInTheDocument();
  });

  it('renders inline code and code blocks visually', () => {
    currentMockPage = mockPageWithCode;
    const { container } = render(<PageViewPage />, { wrapper: createWrapper() });

    // Content area should have prose classes for code styling
    const contentArea = container.querySelector('.prose.prose-invert');
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

  it('renders draw.io diagrams with data attributes preserved', () => {
    currentMockPage = mockPageWithDrawio;
    const { container } = render(<PageViewPage />, { wrapper: createWrapper() });

    const drawioDiv = container.querySelector('.confluence-drawio');
    expect(drawioDiv).toBeInTheDocument();
    expect(drawioDiv).toHaveAttribute('data-diagram-name', 'system-topology');

    const drawioImg = drawioDiv!.querySelector('img');
    expect(drawioImg).toHaveAttribute('src', '/api/attachments/page-1/system-topology.png');

    const editLink = drawioDiv!.querySelector('a.drawio-edit-link');
    expect(editLink).toBeInTheDocument();
    expect(editLink!.textContent).toBe('Edit in Confluence');
  });

  it('opens lightbox when clicking an image', () => {
    currentMockPage = mockPageWithImages;
    const { container } = render(<PageViewPage />, { wrapper: createWrapper() });

    const image = container.querySelector('img');
    expect(image).toBeInTheDocument();

    // Images should have zoom-in cursor
    expect(image!.style.cursor).toBe('zoom-in');

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

    const image = container.querySelector('img');
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

    const image = container.querySelector('img');
    fireEvent.click(image!);

    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // Press Escape
    fireEvent.keyDown(document, { key: 'Escape' });

    // Wait for AnimatePresence exit animation
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });
});
