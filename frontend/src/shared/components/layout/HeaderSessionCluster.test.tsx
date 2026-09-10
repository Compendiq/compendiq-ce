import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HeaderSessionCluster } from './HeaderSessionCluster';
import { useArticleViewStore } from '../../../stores/article-view-store';

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('HeaderSessionCluster', () => {
  beforeEach(() => {
    useArticleViewStore.setState({ editing: false });
  });

  it('renders notifications, theme, and account without a global search bar', () => {
    render(<HeaderSessionCluster />, { wrapper });
    expect(screen.queryByTestId('header-find')).not.toBeInTheDocument();
    expect(screen.getByTestId('notification-bell')).toBeInTheDocument();
    expect(screen.getByLabelText(/Theme:/)).toBeInTheDocument();
    expect(screen.getByLabelText(/menu$/i)).toBeInTheDocument();
  });

  it('stays mounted while the article is being edited', () => {
    useArticleViewStore.setState({ editing: true });
    render(<HeaderSessionCluster />, { wrapper });
    expect(screen.getByTestId('header-session-cluster')).toBeInTheDocument();
  });
});
