import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HeaderHost, APP_HEADER_SLOT_ID } from './header-slot';

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
