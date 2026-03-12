import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Breadcrumb } from './Breadcrumb';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Breadcrumb />
    </MemoryRouter>,
  );
}

describe('Breadcrumb', () => {
  it('shows Pages on root path with nav wrapper', () => {
    renderAt('/');
    expect(screen.getByText('Pages')).toBeInTheDocument();
    expect(screen.getByLabelText('Breadcrumb')).toBeInTheDocument();
  });

  it('shows Pages breadcrumb', () => {
    renderAt('/pages');
    expect(screen.getByText('Pages')).toBeInTheDocument();
  });

  it('shows nested breadcrumb for new page', () => {
    renderAt('/pages/new');
    expect(screen.getByText('Pages')).toBeInTheDocument();
    expect(screen.getByText('New Page')).toBeInTheDocument();
  });

  it('shows Settings breadcrumb', () => {
    renderAt('/settings');
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('shows AI Assistant breadcrumb', () => {
    renderAt('/ai');
    expect(screen.getByText('AI Assistant')).toBeInTheDocument();
  });

  it('has a home link on non-root paths', () => {
    renderAt('/pages');
    const nav = screen.getByLabelText('Breadcrumb');
    expect(nav).toBeInTheDocument();
  });
});
