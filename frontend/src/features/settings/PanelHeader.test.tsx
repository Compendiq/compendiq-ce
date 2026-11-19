import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PanelHeader } from './PanelHeader';

describe('PanelHeader', () => {
  // Break: re-adding an H2 with the panel name duplicates the settings title
  // (the rail's band plus the layout's sr-only H1), so the same place is
  // titled twice.
  it('does not render a heading — the page H1 already names the panel', () => {
    render(
      <PanelHeader
        subtitle="Connect Compendiq to your Confluence Data Center."
        action={<button type="button">Save</button>}
      />,
    );

    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(
      screen.getByText('Connect Compendiq to your Confluence Data Center.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });
});
