import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, domAnimation } from 'framer-motion';
import { AiAssistantPage } from './AiAssistantPage';

// scrollIntoView is not available in jsdom
Element.prototype.scrollIntoView = vi.fn();

// Mock API calls
vi.mock('../../shared/lib/api', () => ({
  apiFetch: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../shared/hooks/use-pages', () => ({
  usePage: () => ({ data: undefined }),
  useEmbeddingStatus: () => ({ data: undefined }),
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/ai']}>
          <LazyMotion features={domAnimation}>
            {children}
          </LazyMotion>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

describe('AiAssistantPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the AI assistant page with mode buttons', () => {
    render(<AiAssistantPage />, { wrapper: createWrapper() });
    expect(screen.getByText('Q&A')).toBeInTheDocument();
    expect(screen.getByText('Improve')).toBeInTheDocument();
    expect(screen.getByText('Generate')).toBeInTheDocument();
    expect(screen.getByText('Summarize')).toBeInTheDocument();
    expect(screen.getByText('Diagram')).toBeInTheDocument();
  });

  it('uses h-full instead of fixed viewport height to prevent page-level scrolling', () => {
    const { container } = render(<AiAssistantPage />, { wrapper: createWrapper() });
    const rootDiv = container.firstElementChild as HTMLElement;
    expect(rootDiv.className).toContain('h-full');
    expect(rootDiv.className).not.toContain('calc');
  });

  it('renders empty state message for Q&A mode', () => {
    render(<AiAssistantPage />, { wrapper: createWrapper() });
    expect(screen.getByText('Ask questions about your knowledge base')).toBeInTheDocument();
  });
});
