import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppBootSkeleton, RouteLoadingFallback } from './AppLoadingFallback';

describe('AppBootSkeleton', () => {
  it('paints the workspace chassis instead of a loading card', () => {
    render(<AppBootSkeleton />);

    const root = screen.getByTestId('app-boot-skeleton');
    expect(root).toHaveAttribute('role', 'status');
    expect(root).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Loading Compendiq')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Compendiq' })).toBeInTheDocument();
    expect(screen.getByTestId('library-list-skeleton')).toBeInTheDocument();
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
    expect(root.querySelector('.nm-card')).toBeNull();
  });

  it('omits fake navigation on the quiet guest/setup wait', () => {
    render(<AppBootSkeleton variant="quiet" />);

    expect(screen.getByTestId('quiet-boot-skeleton')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Compendiq' })).toBeInTheDocument();
    expect(screen.queryByTestId('library-list-skeleton')).not.toBeInTheDocument();
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
  });
});

describe('RouteLoadingFallback', () => {
  function renderAt(path: string) {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <RouteLoadingFallback />
      </MemoryRouter>,
    );
  }

  it('mirrors the article column on an existing page', () => {
    renderAt('/pages/abc-123');
    expect(screen.getByTestId('page-view-skeleton')).toBeInTheDocument();
    expect(screen.getByText('Loading page')).toBeInTheDocument();
  });

  it('mirrors the article column on the new-page route', () => {
    renderAt('/pages/new');
    expect(screen.getByTestId('page-view-skeleton')).toBeInTheDocument();
  });

  it('mirrors settings chrome on settings routes', () => {
    renderAt('/settings/ai/models');
    expect(screen.getByTestId('settings-skeleton')).toBeInTheDocument();
  });

  it('uses chat bones on AI routes', () => {
    renderAt('/ai/c/conv-1');
    expect(screen.getByTestId('ai-route-skeleton')).toBeInTheDocument();
    expect(screen.getAllByTestId('skeleton-chat-message')).toHaveLength(2);
  });

  it('uses the library list on the overview', () => {
    renderAt('/');
    expect(screen.getByTestId('library-list-skeleton')).toBeInTheDocument();
    expect(screen.queryByTestId('page-view-skeleton')).not.toBeInTheDocument();
  });
});
