import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SidebarSessionChrome } from './SidebarSessionChrome';

vi.mock('./ThemeToggle', () => ({
  ThemeToggle: () => <div data-testid="theme-toggle" />,
}));

vi.mock('./UserMenu', () => ({
  UserMenu: ({ align }: { align?: string }) => (
    <button type="button" data-testid="user-menu" data-align={align}>
      Account
    </button>
  ),
}));

describe('SidebarSessionChrome', () => {
  it('renders theme and account controls', () => {
    render(
      <MemoryRouter>
        <SidebarSessionChrome />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('sidebar-session-chrome')).toBeInTheDocument();
    expect(screen.getByTestId('theme-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('user-menu')).toHaveAttribute('data-align', 'start');
  });

  it('stacks compact chrome for the collapsed rail', () => {
    render(
      <MemoryRouter>
        <SidebarSessionChrome compact />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('sidebar-session-chrome').className).toContain('flex-col');
  });
});
