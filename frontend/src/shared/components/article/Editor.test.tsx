import { describe, it, expect, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

vi.mock('../hooks/use-is-light-theme', () => ({
  useIsLightTheme: () => false,
}));

import { Editor } from './Editor';

describe('Editor', () => {
  it('sticky toolbar has no ::before that could overlap content above the editor', async () => {
    // The Editor component is embedded in pages (e.g. NewPagePage) where a
    // title input and config bar sit directly above it. A ::before pseudo on
    // the sticky toolbar with before:bottom-full created a 200px opaque pane
    // that covered those elements. The toolbar's own bg-card is sufficient.
    const { container } = render(
      <Editor content="<p>Hello</p>" editable={true} />,
    );

    await waitFor(() => {
      expect(container.querySelector('[class*="sticky"]')).toBeTruthy();
    });

    const toolbar = container.querySelector('[class*="sticky"]');
    const classes = toolbar?.className ?? '';
    expect(classes).not.toMatch(/before:bottom-full/);
    expect(classes).not.toMatch(/before:h-\[/);
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
