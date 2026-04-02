import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VimModeIndicator } from './VimModeIndicator';
import type { VimState } from './vim-extension';

function makeState(overrides: Partial<VimState> = {}): VimState {
  return {
    mode: 'normal',
    pendingKeys: '',
    countPrefix: '',
    register: '',
    commandBuffer: null,
    ...overrides,
  };
}

describe('VimModeIndicator', () => {
  it('renders the mode indicator element', () => {
    render(<VimModeIndicator vimState={makeState()} />);
    expect(screen.getByTestId('vim-mode-indicator')).toBeTruthy();
  });

  it('shows NORMAL mode label', () => {
    render(<VimModeIndicator vimState={makeState({ mode: 'normal' })} />);
    expect(screen.getByText('-- NORMAL --')).toBeTruthy();
  });

  it('shows INSERT mode label', () => {
    render(<VimModeIndicator vimState={makeState({ mode: 'insert' })} />);
    expect(screen.getByText('-- INSERT --')).toBeTruthy();
  });

  it('shows VISUAL mode label', () => {
    render(<VimModeIndicator vimState={makeState({ mode: 'visual' })} />);
    expect(screen.getByText('-- VISUAL --')).toBeTruthy();
  });

  it('shows pending keys when present', () => {
    render(<VimModeIndicator vimState={makeState({ pendingKeys: 'd' })} />);
    expect(screen.getByText('d')).toBeTruthy();
  });

  it('shows count prefix with pending keys', () => {
    render(<VimModeIndicator vimState={makeState({ countPrefix: '3', pendingKeys: 'd' })} />);
    expect(screen.getByText('3d')).toBeTruthy();
  });

  it('shows command buffer when active', () => {
    render(<VimModeIndicator vimState={makeState({ commandBuffer: 'w' })} />);
    expect(screen.getByText(/:w/)).toBeTruthy();
  });

  it('does not show command buffer when null', () => {
    const { container } = render(<VimModeIndicator vimState={makeState({ commandBuffer: null })} />);
    expect(container.textContent).not.toContain(':');
  });

  it('does not show pending keys when empty', () => {
    render(<VimModeIndicator vimState={makeState()} />);
    // Only the mode label should be present, no extra text nodes
    const indicator = screen.getByTestId('vim-mode-indicator');
    expect(indicator.children.length).toBe(1); // only the mode label span
  });
});
