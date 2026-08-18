import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HeaderFindButton, HeaderSessionCluster } from './HeaderSessionCluster';
import { useCommandPaletteStore } from '../../../stores/command-palette-store';
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

describe('HeaderFindButton', () => {
  beforeEach(() => {
    useCommandPaletteStore.setState({ isOpen: false });
  });

  it('opens the existing command palette', () => {
    render(<HeaderFindButton />, { wrapper });
    fireEvent.click(screen.getByTestId('header-find'));
    expect(useCommandPaletteStore.getState().isOpen).toBe(true);
  });

  it('is named for the palette, not a second search', () => {
    render(<HeaderFindButton />, { wrapper });
    expect(screen.getByRole('button', { name: 'Jump to page or command' })).toBeInTheDocument();
  });
});

describe('HeaderSessionCluster', () => {
  beforeEach(() => {
    useArticleViewStore.setState({ editing: false });
  });

  it('renders find, notifications, theme, and account', () => {
    render(<HeaderSessionCluster />, { wrapper });
    expect(screen.getByTestId('header-find')).toBeInTheDocument();
    expect(screen.getByTestId('notification-bell')).toBeInTheDocument();
    expect(screen.getByLabelText(/Theme:/)).toBeInTheDocument();
    expect(screen.getByLabelText(/menu$/i)).toBeInTheDocument();
  });

  it('stands down while the article editor owns the slot', () => {
    useArticleViewStore.setState({ editing: true });
    render(<HeaderSessionCluster />, { wrapper });
    expect(screen.queryByTestId('header-session-cluster')).not.toBeInTheDocument();
  });
});
