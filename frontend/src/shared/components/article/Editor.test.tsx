import { describe, it, expect, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

vi.mock('../hooks/use-is-light-theme', () => ({
  useIsLightTheme: () => false,
}));

import { Editor } from './Editor';

describe('Editor', () => {
  it('sticky toolbar has a safe ::before mask that covers the scroll gap without overlapping content above', async () => {
    // The internal toolbar uses before:-z-10 (behind its own content) to mask
    // the scroll-container padding gap above when the toolbar is stuck.
    // The old bad pattern (before:bottom-full, no -z-10) created a 200px opaque
    // pane that covered title inputs and config bars on embedding pages.
    const { container } = render(
      <Editor content="<p>Hello</p>" editable={true} />,
    );

    await waitFor(() => {
      expect(container.querySelector('[class*="sticky"]')).toBeTruthy();
    });

    const toolbar = container.querySelector('[class*="sticky"]');
    const classes = toolbar?.className ?? '';

    // Must NOT use the old downward-extending pattern that covered page content
    expect(classes).not.toMatch(/before:bottom-full/);
    expect(classes).not.toMatch(/before:h-\[/);

    // Must use the safe behind-content mask with an upward extension
    expect(classes).toMatch(/before:-z-10/);
    expect(classes).toMatch(/before:-top-\[/);
  });

  it('renders Insert Layout toolbar button', async () => {
    const { container } = render(
      <Editor content="<p>Hello</p>" editable={true} />,
    );

    await waitFor(() => {
      expect(container.querySelector('[title="Insert Layout"]')).toBeTruthy();
    });
  });

  it('preserves Confluence page layout structure in read-only mode', async () => {
    const layoutHtml = '<div class="confluence-layout"><div class="confluence-layout-section" data-layout-type="two_equal"><div class="confluence-layout-cell"><p>Left</p></div><div class="confluence-layout-cell"><p>Right</p></div></div></div>';
    const { container } = render(
      <Editor content={layoutHtml} editable={false} />,
    );

    await waitFor(() => {
      expect(container.querySelector('.confluence-layout')).toBeTruthy();
    });

    const section = container.querySelector('.confluence-layout-section');
    expect(section).toHaveAttribute('data-layout-type', 'two_equal');

    const cells = container.querySelectorAll('.confluence-layout-cell');
    expect(cells).toHaveLength(2);
  });

  it('preserves Confluence column structure in read-only mode', async () => {
    const columnHtml = '<div class="confluence-section" data-border="true"><div class="confluence-column" data-cell-width="30%"><p>Left</p></div><div class="confluence-column" data-cell-width="70%"><p>Right</p></div></div>';
    const { container } = render(
      <Editor content={columnHtml} editable={false} />,
    );

    await waitFor(() => {
      expect(container.querySelector('.confluence-section')).toBeTruthy();
    });

    const section = container.querySelector('.confluence-section');
    expect(section).toHaveAttribute('data-border', 'true');

    const columns = container.querySelectorAll('.confluence-column');
    expect(columns).toHaveLength(2);
    expect(columns[0]).toHaveAttribute('data-cell-width', '30%');
    expect(columns[1]).toHaveAttribute('data-cell-width', '70%');
  });

  it('preserves Confluence image metadata attributes on mirrored images', async () => {
    const { container } = render(
      <Editor
        content={'<p><img src="/api/attachments/page-1/external-abc.png" data-confluence-image-source="external-url" data-confluence-url="https://example.com/a.png" data-confluence-filename="original.png" data-confluence-owner-page-title="Shared Assets" data-confluence-owner-space-key="OPS" /></p>'}
        editable={false}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector('img')).toBeTruthy();
    });

    const img = container.querySelector('img');
    expect(img).toHaveAttribute('data-confluence-image-source', 'external-url');
    expect(img).toHaveAttribute('data-confluence-url', 'https://example.com/a.png');
    expect(img).toHaveAttribute('data-confluence-filename', 'original.png');
    expect(img).toHaveAttribute('data-confluence-owner-page-title', 'Shared Assets');
    expect(img).toHaveAttribute('data-confluence-owner-space-key', 'OPS');
  });
});
