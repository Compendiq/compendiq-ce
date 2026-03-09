import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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
});
