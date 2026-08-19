import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HeaderHost } from './header-slot';
import { APP_HEADER_SLOT_ID } from './header-slot-utils';

describe('HeaderHost', () => {
  it('renders the heading in the document, never in the header slot', () => {
    const slot = document.createElement('div');
    slot.id = APP_HEADER_SLOT_ID;
    document.body.appendChild(slot);
    render(
      <HeaderHost fallbackClassName="fallback">
        <h1>Pages</h1>
      </HeaderHost>,
    );
    expect(screen.getByRole('heading', { name: 'Pages' }).parentElement).toHaveClass('fallback');
    expect(slot.querySelector('h1')).toBeNull();
    slot.remove();
  });
});
