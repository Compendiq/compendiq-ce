import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppHeaderMain, HeaderHost } from './header-slot';
import { APP_HEADER_SLOT_ID } from './header-slot-utils';

describe('HeaderHost', () => {
  it('renders in place when the app header slot is missing', () => {
    render(
      <HeaderHost fallbackClassName="fallback">
        <h1>Pages</h1>
      </HeaderHost>,
    );
    expect(screen.getByRole('heading', { name: 'Pages' }).parentElement).toHaveClass('fallback');
  });

  it('portals into the app header slot when it exists', () => {
    const slot = document.createElement('div');
    slot.id = APP_HEADER_SLOT_ID;
    document.body.appendChild(slot);
    render(
      <HeaderHost fallbackClassName="fallback">
        <h1>Pages</h1>
      </HeaderHost>,
    );
    expect(slot.querySelector('h1')?.textContent).toBe('Pages');
    expect(document.querySelector('.fallback')).toBeNull();
    slot.remove();
  });
});

describe('AppHeaderMain', () => {
  it('keeps the fallback title in the same row as the slot, not after a spacer', () => {
    render(
      <MemoryRouter initialEntries={['/ai']}>
        <AppHeaderMain />
      </MemoryRouter>,
    );
    const slot = screen.getByTestId('app-header-slot');
    const title = screen.getByRole('heading', { name: 'AI' });
    expect(slot.contains(title)).toBe(false);
    expect(slot.parentElement).toContainElement(title);
    expect(slot.className).toMatch(/contents/);
    expect(slot.parentElement?.className).toMatch(/flex-1/);
  });

  it('hides the fallback once a page claims the slot', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <AppHeaderMain />
        <HeaderHost>
          <h1>Pages</h1>
        </HeaderHost>
      </MemoryRouter>,
    );
    await vi.waitFor(() => {
      expect(screen.getAllByRole('heading', { name: 'Pages' })).toHaveLength(1);
    });
  });
});
