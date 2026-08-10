/**
 * What are the DIRECT CHILDREN of `.tiptap`, really?
 *
 * The reading measure clamps an allow-list of prose elements and leaves
 * everything else at the full column. That only works if the allow-list matches
 * the DOM the components actually render — and a CSS-text test cannot check
 * that: it happily certifies a selector matching nothing.
 *
 * The first version of this feature learned that the expensive way. It measured
 * `> *` and exempted a deny-list of wide selectors, three of which
 * (`.drawio-nodeview`, `[data-type='drawioDiagram']`, `[data-type='mermaidBlock']`)
 * matched nothing, because TipTap wraps every React node view in its own
 * `div.react-renderer.node-<name>` and those sit a level deeper. And the reader
 * and editor disagree on shape — a code block is a bare `<pre>` in the reader
 * but a node-view wrapper in the editor — so the deny-list clamped code while
 * editing and not while reading.
 *
 * jsdom performs no layout, so widths are not checkable here. The DOM is, and
 * the DOM is where that whole class of bug lived.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'fs';
import { resolve } from 'path';

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg>diagram</svg>' }),
  },
}));
vi.mock('../../hooks/use-is-light-theme', () => ({ useIsLightTheme: () => false }));
vi.mock('../../hooks/use-authenticated-src', () => ({
  fetchAuthenticatedBlob: vi.fn().mockResolvedValue(null),
  useAuthenticatedSrc: () => ({ blobSrc: null, loading: false }),
}));
vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: '1' }),
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: React.ReactNode }) => <a href="/">{children}</a>,
}));

const { ArticleViewer } = await import('./ArticleViewer');
const { Editor } = await import('./Editor');

const css = readFileSync(resolve(__dirname, '../../../index.css'), 'utf-8');

/** The tag names the measure is allowed to clamp, read out of the CSS itself. */
function measuredTags(): string[] {
  const m = /\.article-measure \.tiptap > :is\(([^)]*)\)/.exec(css);
  expect(m, 'prose allow-list rule not found in index.css').not.toBeNull();
  return m![1].split(',').map((s) => s.trim()).filter(Boolean);
}

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

/** Tag names of the direct children of `.tiptap`. */
async function childTags(ui: React.ReactElement): Promise<string[]> {
  const { container } = render(ui, { wrapper });
  await waitFor(() => {
    const t = container.querySelector('.tiptap');
    expect(t, 'no .tiptap rendered').not.toBeNull();
    expect(t!.children.length).toBeGreaterThan(0);
  });
  return [...container.querySelector('.tiptap')!.children].map((el) => el.tagName.toLowerCase());
}

const read = (html: string) => childTags(<ArticleViewer content={html} />);
const edit = (html: string) =>
  childTags(<Editor content={html} onChange={() => {}} naked hideToolbar />);

describe('the measure clamps prose', () => {
  it.each([
    ['paragraph', '<p>Some prose that should sit at the reading measure.</p>', 'p'],
    ['heading', '<h2>Symptoms</h2>', 'h2'],
    ['bullet list', '<ul><li>one</li></ul>', 'ul'],
    ['ordered list', '<ol><li>one</li></ol>', 'ol'],
    ['blockquote', '<blockquote><p>quoted</p></blockquote>', 'blockquote'],
    ['divider', '<p>a</p><hr><p>b</p>', 'hr'],
  ])('%s renders as <%s>, which the allow-list covers', async (_label, html, tag) => {
    const tags = await read(html);
    expect(tags).toContain(tag);
    expect(measuredTags()).toContain(tag);
  });
});

describe('the measure does NOT clamp structural blocks', () => {
  // Each of these must render as something the allow-list does not name, in
  // BOTH modes. A regression here is a diagram or table silently shrunk to
  // 40rem — or, worse, shrunk in one mode and not the other.
  it.each([
    ['table', '<table><tbody><tr><td>a</td></tr></tbody></table>'],
    ['code block', '<pre><code class="language-sql">SELECT 1;</code></pre>'],
    ['mermaid diagram', '<pre><code class="language-mermaid">graph TD; A-->B;</code></pre>'],
    ['figure', '<figure><img src="/a.png" alt="a"><figcaption>c</figcaption></figure>'],
    ['bare image', '<p>x</p><img src="/a.png" alt="a">'],
    ['Confluence layout', '<div class="confluence-layout"><div class="confluence-layout-cell"><p>hi</p></div></div>'],
  ])('%s keeps the full column in both reader and editor', async (_label, html) => {
    const allow = measuredTags();
    const readTags = await read(html);
    const editTags = await edit(html);

    // The block itself is whichever child is not plain prose. `p` is excluded
    // because TipTap appends a trailing paragraph in the editor.
    const structural = (tags: string[]) => tags.filter((t) => t !== 'p');

    expect(structural(readTags).length, `nothing structural rendered: ${readTags}`).toBeGreaterThan(0);
    for (const t of structural(readTags)) {
      expect(allow, `reader: <${t}> is in the prose allow-list but is a structural block`).not.toContain(t);
    }
    for (const t of structural(editTags)) {
      expect(allow, `editor: <${t}> is in the prose allow-list but is a structural block`).not.toContain(t);
    }
  });

  // The specific asymmetry that broke the deny-list version.
  it('tolerates the reader and editor rendering a code block differently', async () => {
    const html = '<pre><code class="language-sql">SELECT 1;</code></pre>';
    const allow = measuredTags();
    const readTags = await read(html);
    const editTags = await edit(html);
    // Reader gives a bare <pre>; editor gives the node-view wrapper <div>.
    expect(readTags).toContain('pre');
    expect(editTags.some((t) => t === 'div')).toBe(true);
    // Under an allow-list both are unmeasured, so the difference is harmless —
    // which is the entire reason this is an allow-list.
    expect(allow).not.toContain('pre');
    expect(allow).not.toContain('div');
  });
});

describe('the allow-list names only real prose elements', () => {
  it('contains no class or attribute selectors', () => {
    // Those are the guesses that silently matched nothing last time. Tag names
    // cannot be wrong in that way.
    for (const sel of measuredTags()) {
      expect(sel, `${sel} is not a bare tag name`).toMatch(/^[a-z][a-z0-9]*$/);
    }
  });

  it('does not carry a deny-list alongside it', () => {
    expect(
      /\.article-measure \.tiptap > \*/.test(css),
      'measuring `> *` reintroduces the need for a deny-list of wide blocks',
    ).toBe(false);
  });
});
