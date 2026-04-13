import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TemplatesPage } from './TemplatesPage';
import type { Template } from './TemplateCard';

// Mock framer-motion
vi.mock('framer-motion', () => ({
  m: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock('../../shared/hooks/use-is-light-theme', () => ({
  useIsLightTheme: () => false,
}));

const mockTemplates: Template[] = [
  {
    id: 'tpl-1',
    title: 'Daily Standup',
    description: 'Daily standup meeting notes',
    category: 'Meetings',
    useCount: 5,
    bodyHtml: '<h1>Standup</h1>',
    createdAt: '2025-01-01T00:00:00Z',
  },
  {
    id: 'tpl-2',
    title: 'Runbook',
    description: 'Operations runbook template',
    category: 'Operations',
    useCount: 3,
    bodyHtml: '<h1>Runbook</h1>',
    createdAt: '2025-01-02T00:00:00Z',
  },
  {
    id: 'tpl-3',
    title: 'API Reference',
    description: 'API documentation template',
    category: 'Engineering',
    useCount: 0,
    bodyHtml: '<h1>API Ref</h1>',
    createdAt: '2025-01-03T00:00:00Z',
  },
];

let mockApiFetch: ReturnType<typeof vi.fn>;

vi.mock('../../shared/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <TemplatesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('TemplatesPage', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockApiFetch = vi.fn().mockResolvedValue(mockTemplates);
  });

  it('renders the page header', () => {
    renderPage();
    expect(screen.getByText('Templates')).toBeInTheDocument();
    expect(screen.getByText('Start from a pre-built template to create pages faster')).toBeInTheDocument();
  });

  it('renders Create Template button', () => {
    renderPage();
    expect(screen.getByText('Create Template')).toBeInTheDocument();
  });

  it('navigates to new page when Create Template is clicked', () => {
    renderPage();
    fireEvent.click(screen.getByText('Create Template'));
    expect(mockNavigate).toHaveBeenCalledWith('/pages/new');
  });

  it('renders category tabs', () => {
    renderPage();
    expect(screen.getByTestId('category-tab-all')).toBeInTheDocument();
    expect(screen.getByTestId('category-tab-meetings')).toBeInTheDocument();
    expect(screen.getByTestId('category-tab-operations')).toBeInTheDocument();
    expect(screen.getByTestId('category-tab-documentation')).toBeInTheDocument();
    expect(screen.getByTestId('category-tab-engineering')).toBeInTheDocument();
  });

  it('renders loading skeleton initially', () => {
    // Set apiFetch to never resolve to keep loading state
    mockApiFetch = vi.fn().mockReturnValue(new Promise(() => {}));
    renderPage();
    const skeletons = document.querySelectorAll('.animate-pulse');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('renders template cards after loading', async () => {
    renderPage();
    await vi.waitFor(() => {
      expect(screen.getByText('Daily Standup')).toBeInTheDocument();
    });
    expect(screen.getByText('Runbook')).toBeInTheDocument();
    expect(screen.getByText('API Reference')).toBeInTheDocument();
  });

  it('filters templates by category tab', async () => {
    renderPage();
    await vi.waitFor(() => {
      expect(screen.getByText('Daily Standup')).toBeInTheDocument();
    });

    // Click Meetings tab
    fireEvent.click(screen.getByTestId('category-tab-meetings'));
    expect(screen.getByText('Daily Standup')).toBeInTheDocument();
    expect(screen.queryByText('Runbook')).not.toBeInTheDocument();
    expect(screen.queryByText('API Reference')).not.toBeInTheDocument();
  });

  it('shows empty state when category has no templates', async () => {
    renderPage();
    await vi.waitFor(() => {
      expect(screen.getByText('Daily Standup')).toBeInTheDocument();
    });

    // Click Documentation tab (no templates of this category)
    fireEvent.click(screen.getByTestId('category-tab-documentation'));
    expect(screen.getByTestId('empty-state-title')).toHaveTextContent('No documentation templates');
  });

  it('shows all templates when All tab is clicked', async () => {
    renderPage();
    await vi.waitFor(() => {
      expect(screen.getByText('Daily Standup')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('category-tab-meetings'));
    expect(screen.queryByText('Runbook')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('category-tab-all'));
    expect(screen.getByText('Daily Standup')).toBeInTheDocument();
    expect(screen.getByText('Runbook')).toBeInTheDocument();
    expect(screen.getByText('API Reference')).toBeInTheDocument();
  });
});
