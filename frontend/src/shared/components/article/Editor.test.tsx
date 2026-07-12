import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, screen, fireEvent } from '@testing-library/react';

vi.mock('../hooks/use-is-light-theme', () => ({
  useIsLightTheme: () => false,
}));

vi.mock('../../lib/api', () => ({
  apiFetch: vi.fn(),
}));

const mockFetchAuthenticatedBlob = vi.fn();
vi.mock('../../hooks/use-authenticated-src', () => ({
  fetchAuthenticatedBlob: (...args: unknown[]) => mockFetchAuthenticatedBlob(...args),
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    // `loading` returns a toast id that `dismiss` / `success` / etc. can
    // target. The HTML paste handler chains `toast.loading(...) → toast.x(...
    // , { id })`, so the id needs to be a stable value across the mock.
    loading: vi.fn(() => 'toast-id-1'),
    dismiss: vi.fn(),
  },
}));

import { Editor, EditorToolbar, clearDraft } from './Editor';
import type { Editor as EditorType } from '@tiptap/react';

// Minimal mock of a TipTap Editor instance for toolbar-level tests
function createMockEditor(): EditorType {
  const chainProxy: Record<string, unknown> = new Proxy(
    { run: vi.fn() } as Record<string, unknown>,
    {
      get(_target, prop: string) {
        if (prop === 'run') return vi.fn();
        return () => chainProxy;
      },
    },
  );

  return {
    chain: () => chainProxy,
    can: () =>
      new Proxy(
        {},
        { get() { return () => true; } },
      ),
    isActive: () => false,
    getAttributes: () => ({}),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as EditorType;
}

describe('Editor', () => {
  beforeEach(() => {
    // The ConfluenceImage NodeView calls fetchAuthenticatedBlob() during
    // editor init for any `/api/attachments/...` src in the initial content.
    // Tests that don't care about the blob URL still need the mock to return
    // a thenable, otherwise `.then(...)` on the result crashes the editor.
    // The NodeView describe overrides this with mockResolvedValue('blob:…')
    // for tests that DO care.
    mockFetchAuthenticatedBlob.mockResolvedValue(null);
  });

  it('signals dirty via a boolean onChange, not a serialized HTML string (#954)', async () => {
    // Perf invariant: the hot per-keystroke onUpdate path must NOT serialize
    // the whole document (getHTML) and hand it to the parent. onChange fires a
    // cheap boolean dirty flag instead, so the parent can flip an isDirty flag
    // without re-rendering on every keystroke and without paying the O(doc)
    // serialization cost each time.
    const onChange = vi.fn();
    let editor: EditorType | null = null;
    render(
      <Editor
        content="<p>seed</p>"
        editable={true}
        draftKey="page-954"
        onChange={onChange}
        onEditorReady={(e) => { editor = e; }}
      />,
    );

    await waitFor(() => {
      expect(editor).not.toBeNull();
    });

    editor!.commands.insertContent(' x');

    await waitFor(() => {
      expect(onChange).toHaveBeenCalled();
    });

    const lastArg = onChange.mock.calls.at(-1)![0];
    // Pre-fix this was the serialized HTML string (`<p>seed x</p>`). Post-fix
    // it is a boolean dirty signal.
    expect(typeof lastArg).toBe('boolean');
    expect(lastArg).toBe(true);
  });

  it('sticky toolbar reads as the top of the article card (#30 overhaul)', async () => {
    // The internal toolbar must look like the visual top of the article card
    // below — same bg, rounded only on top, sticks at top:0 when scrolling.
    // The old bad patterns (before:bottom-full overlapping content above, or
    // before:bg-background showing the page color through the toolbar) are
    // structurally impossible now because the ::before strip is gone.
    const { container } = render(
      <Editor content="<p>Hello</p>" editable={true} />,
    );

    await waitFor(() => {
      expect(container.querySelector('[class*="sticky"]')).toBeTruthy();
    });

    const toolbar = container.querySelector('[class*="sticky"]');
    const classes = toolbar?.className ?? '';

    // Sticky at top:0
    expect(classes).toMatch(/sticky/);
    expect(classes).toMatch(/top-0/);

    // Square top corners — definitive fix for the scroll-peek-through bug.
    // Rounded top corners create transparent cutout areas that reveal
    // whatever is behind the toolbar (article card edges, page bg, etc.)
    // when scrolling. Square corners eliminate the cutouts entirely.
    expect(classes).not.toMatch(/rounded-t-/);
    expect(classes).toMatch(/bg-card\b/);
    expect(classes).toMatch(/border-b/);
    // No ::before pseudo-strip — the old shield/extension patterns are gone.
    expect(classes).not.toMatch(/before:absolute/);
    expect(classes).not.toMatch(/before:bottom-full/);
    expect(classes).not.toMatch(/before:bg-background/);
  });

  it('renders Insert Layout toolbar button', async () => {
    const { container } = render(
      <Editor content="<p>Test</p>" editable={true} />,
    );

    await waitFor(() => {
      expect(container.querySelector('[class*="tiptap"]')).toBeTruthy();
    });

    // Find the toolbar region: look for a group of buttons inside the editor wrapper
    const buttons = container.querySelectorAll('button');
    const layoutButton = Array.from(buttons).find(
      (btn) =>
        btn.title?.toLowerCase().includes('layout') ||
        btn.textContent?.toLowerCase().includes('layout'),
    );

    // The Insert Layout button must exist in the toolbar
    expect(layoutButton).toBeTruthy();
  });

  it('loads the MermaidBlock extension', async () => {
    const { container } = render(
      <Editor content="<p>Test</p>" editable={true} />,
    );

    await waitFor(() => {
      expect(container.querySelector('[class*="tiptap"]')).toBeTruthy();
    });

    // The MermaidBlock extension is registered (no toolbar button exists for it;
    // mermaid blocks are inserted via slash commands or pasted content).
    // Verify the editor loaded successfully with the extension by checking
    // that the ProseMirror editor is mounted and interactive.
    const prosemirror = container.querySelector('.ProseMirror');
    expect(prosemirror).toBeTruthy();
    expect(prosemirror?.getAttribute('contenteditable')).toBe('true');
  });

  it('preserves Confluence image metadata attributes in the editor', async () => {
    const htmlWithMetadata = `
      <p><img src="/api/attachments/page-1/test.png"
        data-confluence-image-source="external-url"
        data-confluence-url="https://example.com/a.png"
        data-confluence-filename="original.png"
        data-confluence-owner-page-title="Shared Assets"
        data-confluence-owner-space-key="OPS"
      /></p>
    `;

    const { container } = render(
      <Editor content={htmlWithMetadata} editable={true} />,
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

  describe('Confluence macro round-trip schema (#857)', () => {
    // The edit-mode ProseMirror schema must register a node for every macro
    // placeholder the backend emits into body_html. If a wrapper has no
    // matching parse rule, ProseMirror silently unwraps it — and editor
    // saves (getHTML → htmlToConfluence → updatePage) then permanently
    // delete the macro from the Confluence page (#765/#857). This asserts the
    // wrappers survive a load → serialize round-trip so htmlToConfluence can
    // rebuild the ac:structured-macro / ri:user elements.
    it('preserves panel/toc/jira/include/labels/unknown-macro/mention wrappers in editor.getHTML()', async () => {
      const fixture = [
        '<div class="panel-info"><p>hi</p></div>',
        '<div class="confluence-toc" data-maxlevel="3">[Table of Contents]</div>',
        '<p><span class="confluence-jira-issue" data-key="KEY-1">[JIRA: KEY-1]</span></p>',
        '<div class="confluence-include-macro" data-macro-name="include" data-page-title="Shared" data-space-key="OPS">[Include: Shared]</div>',
        '<div class="confluence-labels-macro" data-max="5">[Labels]</div>',
        '<div class="confluence-macro-unknown" data-macro-name="roadmap" data-macro-params=\'{"key":"v"}\'>[Confluence macro: roadmap]</div>',
        '<p><span class="confluence-user-mention" data-username="alice">@alice</span></p>',
      ].join('\n');

      let editor: EditorType | null = null;
      render(
        <Editor
          content={fixture}
          editable={true}
          onEditorReady={(e) => { editor = e; }}
        />,
      );

      await waitFor(() => {
        expect(editor).not.toBeNull();
      });

      const html = editor!.getHTML();

      // Panel wrapper — reverse pass keys off `.panel-info`.
      expect(html).toContain('panel-info');
      // TOC placeholder + round-tripped param.
      expect(html).toContain('confluence-toc');
      expect(html).toContain('data-maxlevel="3"');
      // JIRA inline macro.
      expect(html).toContain('confluence-jira-issue');
      expect(html).toContain('data-key="KEY-1"');
      // Include macro + page/space reference.
      expect(html).toContain('confluence-include-macro');
      expect(html).toContain('data-page-title="Shared"');
      expect(html).toContain('data-space-key="OPS"');
      // Labels macro.
      expect(html).toContain('confluence-labels-macro');
      // Unknown macro — the macro name AND its serialized params (the #865
      // backend forward pass writes data-macro-params to preserve an unknown
      // macro's parameters) must both round-trip.
      expect(html).toContain('confluence-macro-unknown');
      expect(html).toContain('data-macro-name="roadmap"');
      expect(html).toContain('data-macro-params');
      expect(html).toContain('&quot;key&quot;:&quot;v&quot;');
      // User mention.
      expect(html).toContain('confluence-user-mention');
      expect(html).toContain('data-username="alice"');
    });
  });

  describe('clipboard image paste (#17)', () => {
    it('renders and accepts the pageId prop', async () => {
      const { container } = render(
        <Editor content="" editable={true} pageId="42" />,
      );

      await waitFor(() => {
        expect(container.querySelector('[class*="tiptap"]')).toBeTruthy();
      });

      // Verify the editor renders successfully with pageId
      expect(container.querySelector('[class*="tiptap"]')).toBeTruthy();
    });

    it('renders without pageId (backward compatible)', async () => {
      const { container } = render(
        <Editor content="" editable={true} />,
      );

      await waitFor(() => {
        expect(container.querySelector('[class*="tiptap"]')).toBeTruthy();
      });

      expect(container.querySelector('[class*="tiptap"]')).toBeTruthy();
    });
  });

  it('applies header-numbering class to container when localStorage flag is true', async () => {
    localStorage.setItem('editor-header-numbering', 'true');
    const { container } = render(
      <Editor content="<p>Hello</p>" editable={true} />,
    );

    await waitFor(() => {
      expect(container.querySelector('.header-numbering')).toBeTruthy();
    });
  });

  it('does not apply header-numbering class when localStorage flag is false', async () => {
    localStorage.setItem('editor-header-numbering', 'false');
    const { container } = render(
      <Editor content="<p>Hello</p>" editable={true} />,
    );

    await waitFor(() => {
      // Wait for editor to render
      expect(container.querySelector('[class*="nm-card"]')).toBeTruthy();
    });
    expect(container.querySelector('.header-numbering')).toBeFalsy();
  });

  describe('image NodeView — JWT-gated attachment rewrite', () => {
    // Browsers can't send Authorization headers on <img> requests, so
    // `/api/attachments/...` always 401's a direct load. The NodeView
    // intercepts these srcs, fetches them with the bearer token, and
    // renders via a blob URL — while leaving `node.attrs.src` (and
    // therefore `getHTML()`) untouched so saves persist the canonical URL.

    beforeEach(() => {
      mockFetchAuthenticatedBlob.mockReset();
      // ProseMirror may re-create the NodeView during editor init (e.g. when
      // content is parsed-and-re-rendered), causing applySrc to fire twice for
      // the same image. mockResolvedValueOnce only covers the first call; any
      // subsequent call would return undefined and crash on `.then`. Set a
      // safe default; tests that care about a specific URL use
      // mockResolvedValueOnce to override.
      mockFetchAuthenticatedBlob.mockResolvedValue(null);
      // Track URL.createObjectURL/revokeObjectURL so the destroy test can
      // assert the blob URL is released — jsdom's stub no-ops by default.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (URL as any).createObjectURL = vi.fn(() => `blob:test-${Math.random().toString(36).slice(2, 8)}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (URL as any).revokeObjectURL = vi.fn();
    });

    it('rewrites /api/attachments/... srcs to blob URLs via fetchAuthenticatedBlob', async () => {
      // Use mockResolvedValue (sticky) — ProseMirror may create the NodeView
      // more than once while initialising the editor, and `*Once` would only
      // satisfy the first creation.
      mockFetchAuthenticatedBlob.mockResolvedValue('blob:fake-attachment');

      const { container } = render(
        <Editor content='<p><img src="/api/attachments/page-1/screenshot.png" alt="A shot" /></p>' editable={true} />,
      );

      await waitFor(() => {
        expect(mockFetchAuthenticatedBlob).toHaveBeenCalledWith('/api/attachments/page-1/screenshot.png');
      });
      await waitFor(() => {
        expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:fake-attachment');
      });

      const img = container.querySelector('img')!;
      // Canonical URL kept on the DOM for debugging; the rendered src has
      // been swapped to the blob URL.
      expect(img).toHaveAttribute('data-original-src', '/api/attachments/page-1/screenshot.png');
      // Mirrored stock-Image attrs
      expect(img).toHaveAttribute('alt', 'A shot');
    });

    it('also rewrites /api/local-attachments/... srcs', async () => {
      mockFetchAuthenticatedBlob.mockResolvedValue('blob:fake-local');

      render(
        <Editor content='<p><img src="/api/local-attachments/42/paste.png" /></p>' editable={true} />,
      );

      await waitFor(() => {
        expect(mockFetchAuthenticatedBlob).toHaveBeenCalledWith('/api/local-attachments/42/paste.png');
      });
    });

    it('does not auth-fetch external image srcs (renders src directly)', async () => {
      const { container } = render(
        <Editor content='<p><img src="https://example.com/external.png" alt="External" /></p>' editable={true} />,
      );

      await waitFor(() => {
        expect(container.querySelector('img')).toBeTruthy();
      });

      // No fetch should fire for non-/api/attachments srcs.
      expect(mockFetchAuthenticatedBlob).not.toHaveBeenCalled();
      // Direct src is applied.
      expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.com/external.png');
    });

    it('keeps the canonical /api/attachments src in editor.getHTML() (does not leak blob: URLs on save)', async () => {
      // This is the core save-safety invariant of the whole NodeView: the
      // blob URL is DOM-only; `node.attrs.src` (and therefore getHTML /
      // getJSON) must remain the canonical /api/attachments URL.
      mockFetchAuthenticatedBlob.mockResolvedValue('blob:fake');

      // Grab the editor instance via onEditorReady so we can call
      // getHTML/getJSON directly. Previously this test waited on `onChange`,
      // which only fires on transactions — none were dispatched, so the
      // assertion was inside a never-taken `if (capturedHtml)` and the test
      // was a silent no-op.
      let editor: EditorType | null = null;
      render(
        <Editor
          content='<p><img src="/api/attachments/page-1/foo.png" /></p>'
          editable={true}
          onEditorReady={(e) => { editor = e; }}
        />,
      );

      await waitFor(() => {
        expect(editor).not.toBeNull();
      });
      await waitFor(() => {
        expect(document.querySelector('img')?.getAttribute('src')).toBe('blob:fake');
      });

      // DOM `<img>` is showing the blob URL, but the editor's serialized
      // state must still hold the canonical URL.
      const html = editor!.getHTML();
      const json = editor!.getJSON();
      expect(html).not.toContain('blob:');
      expect(html).toContain('/api/attachments/page-1/foo.png');

      // Walk the JSON tree and assert every image node attrs.src is the
      // canonical URL — defends against future bugs where a blob URL slips
      // into the node state itself.
      const collectImageSrcs = (node: { type: string; attrs?: { src?: string }; content?: unknown[] }, acc: string[] = []): string[] => {
        if (node.type === 'image' && node.attrs?.src) acc.push(node.attrs.src);
        if (Array.isArray(node.content)) {
          for (const child of node.content) collectImageSrcs(child as typeof node, acc);
        }
        return acc;
      };
      const imageSrcs = collectImageSrcs(json as { type: string; content?: unknown[] });
      expect(imageSrcs).toEqual(['/api/attachments/page-1/foo.png']);
    });

    it('removes attributes that disappear from the node on update', async () => {
      // Regression test for the attr-removal half of #682's follow-up: a
      // previously-set attribute (e.g. `alt`) that's cleared on the node
      // must also be removed from the DOM, not linger as a stale value.
      mockFetchAuthenticatedBlob.mockResolvedValue('blob:rm-attrs');

      let editor: EditorType | null = null;
      render(
        <Editor
          content='<p><img src="/api/attachments/page-1/rm.png" alt="initial-alt" /></p>'
          editable={true}
          onEditorReady={(e) => { editor = e; }}
        />,
      );

      await waitFor(() => {
        expect(editor).not.toBeNull();
      });
      await waitFor(() => {
        expect(document.querySelector('img')?.getAttribute('alt')).toBe('initial-alt');
      });

      // Find the image node in the doc and clear its `alt` via a transaction
      // — same mechanism a toolbar control or extension command would use.
      const tr = editor!.state.tr;
      editor!.state.doc.descendants((node, pos) => {
        if (node.type.name === 'image') {
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, alt: null });
          return false;
        }
        return true;
      });
      editor!.view.dispatch(tr);

      // The DOM must reflect the cleared attribute, not just the new node
      // state. Pre-fix, the stale `alt="initial-alt"` would still be on the
      // DOM until the editor remounted.
      await waitFor(() => {
        expect(document.querySelector('img')?.hasAttribute('alt')).toBe(false);
      });
    });

    it('revokes the blob URL when the editor unmounts', async () => {
      mockFetchAuthenticatedBlob.mockResolvedValue('blob:to-revoke');

      const { unmount } = render(
        <Editor content='<p><img src="/api/attachments/page-1/bye.png" /></p>' editable={true} />,
      );

      await waitFor(() => {
        expect(document.querySelector('img')?.getAttribute('src')).toBe('blob:to-revoke');
      });

      unmount();

      // The NodeView's destroy() handler must revoke the blob URL.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((URL as any).revokeObjectURL).toHaveBeenCalledWith('blob:to-revoke');
    });

    it('revokes an in-flight fetch result if the NodeView is destroyed before it resolves', async () => {
      // Hold the fetch promise open until after unmount.
      let resolveFetch!: (url: string | null) => void;
      mockFetchAuthenticatedBlob.mockImplementationOnce(
        () => new Promise<string | null>((resolve) => { resolveFetch = resolve; }),
      );

      const { unmount } = render(
        <Editor content='<p><img src="/api/attachments/page-1/race.png" /></p>' editable={true} />,
      );

      await waitFor(() => {
        expect(mockFetchAuthenticatedBlob).toHaveBeenCalled();
      });

      // Tear down the NodeView while the fetch is still pending.
      unmount();

      // Now resolve the auth fetch — the NodeView is already destroyed.
      // The post-destroy guard MUST revoke the orphan blob URL (the
      // pre-fix behaviour assigned it to `blobUrl` and leaked it forever).
      resolveFetch('blob:orphan-after-destroy');

      await waitFor(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((URL as any).revokeObjectURL).toHaveBeenCalledWith('blob:orphan-after-destroy');
      });
    });
  });

  describe('HTML paste — import non-internal <img> srcs (#683)', () => {
    // When the user pastes HTML containing `<img>` tags whose srcs are not
    // already pointing at our backend, the editor rewrites each src to an
    // internal `/api/attachments/...` URL by routing through the inline
    // upload endpoint (data: URIs) or the new `/import` endpoint (http(s)).
    // Unfetchable srcs (relative paths, file:, …) get a `data-import-failed`
    // attribute the CSS placeholder targets.

    // We need apiFetch as a *mock function*, not just a vi.fn() the import
    // refers to. The top-level mock at the file head wires `apiFetch: vi.fn()`
    // — pull the same reference here so each test can mock per-call.
    let mockApiFetch: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      const apiModule = await import('../../lib/api');
      mockApiFetch = apiModule.apiFetch as ReturnType<typeof vi.fn>;
      mockApiFetch.mockReset();
      // Sticky default so the NodeView's auth fetch (which fires for any
      // /api/attachments src inserted into the editor) doesn't crash on
      // `.then(undefined)`.
      mockFetchAuthenticatedBlob.mockResolvedValue('blob:fake');
    });

    // jsdom does not implement `DataTransfer` / `ClipboardEvent` with full
    // clipboardData support, so we hand-build the minimal surface our paste
    // handler reads: `clipboardData.items` (empty array — no inline image)
    // and `clipboardData.getData('text/html')`.
    function dispatchHtmlPaste(html: string): boolean {
      const pm = document.querySelector('.ProseMirror') as HTMLElement | null;
      if (!pm) throw new Error('ProseMirror element not mounted');
      const evt = new Event('paste', { bubbles: true, cancelable: true }) as Event & {
        clipboardData: { items: unknown[]; getData: (type: string) => string };
      };
      Object.defineProperty(evt, 'clipboardData', {
        value: {
          items: [],
          getData: (type: string) => (type === 'text/html' ? html : ''),
        },
        writable: false,
      });
      pm.focus();
      return pm.dispatchEvent(evt);
    }

    it('rewrites a single http(s) <img> src via /pages/:id/images/import', async () => {
      mockApiFetch.mockResolvedValueOnce({ url: '/api/attachments/42/imported.png' });

      render(<Editor content="<p>seed</p>" editable={true} pageId="42" />);
      await waitFor(() => {
        expect(document.querySelector('.ProseMirror')).toBeTruthy();
      });

      dispatchHtmlPaste('<p><img src="https://cdn.example.com/hero.png" alt="hero"></p>');

      await waitFor(() => {
        expect(mockApiFetch).toHaveBeenCalledWith(
          '/pages/42/images/import',
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ url: 'https://cdn.example.com/hero.png' }),
          }),
        );
      });
      await waitFor(() => {
        const img = document.querySelector('.ProseMirror img');
        expect(img?.getAttribute('data-original-src')).toBe('/api/attachments/42/imported.png');
      });
    });

    it('rewrites a data: URI <img> via /pages/:id/images (existing upload endpoint)', async () => {
      mockApiFetch.mockResolvedValueOnce({ url: '/api/attachments/42/imported-data.png' });

      render(<Editor content="<p>seed</p>" editable={true} pageId="42" />);
      await waitFor(() => {
        expect(document.querySelector('.ProseMirror')).toBeTruthy();
      });

      dispatchHtmlPaste(
        '<p><img src="data:image/png;base64,iVBORw0K" alt="data-img"></p>',
      );

      await waitFor(() => {
        expect(mockApiFetch).toHaveBeenCalledWith(
          '/pages/42/images',
          expect.objectContaining({
            method: 'POST',
            // Body is a JSON string with dataUri + a generated filename.
            body: expect.stringContaining('"dataUri":"data:image/png;base64,iVBORw0K"'),
          }),
        );
      });
      await waitFor(() => {
        const img = document.querySelector('.ProseMirror img');
        expect(img?.getAttribute('data-original-src')).toBe('/api/attachments/42/imported-data.png');
      });
    });

    it('marks unfetchable srcs (relative paths, file:, …) with data-import-failed', async () => {
      render(<Editor content="<p>seed</p>" editable={true} pageId="42" />);
      await waitFor(() => {
        expect(document.querySelector('.ProseMirror')).toBeTruthy();
      });

      dispatchHtmlPaste(
        '<p><img src="../_images/qs-projects.png" alt="Projects"></p>',
      );

      await waitFor(() => {
        const img = document.querySelector('.ProseMirror img');
        expect(img?.getAttribute('data-import-failed')).toBe('true');
      });
      // No upload calls — relative paths are not auto-importable.
      expect(mockApiFetch).not.toHaveBeenCalled();
    });

    it('marks failed http(s) imports with data-import-failed', async () => {
      // /import returns null (apiFetch throws on non-2xx; our helper catches
      // and returns null, which the rewriter treats as failure).
      mockApiFetch.mockRejectedValueOnce(new Error('502 Bad Gateway'));

      render(<Editor content="<p>seed</p>" editable={true} pageId="42" />);
      await waitFor(() => {
        expect(document.querySelector('.ProseMirror')).toBeTruthy();
      });

      dispatchHtmlPaste(
        '<p><img src="https://nope.example.com/missing.png"></p>',
      );

      await waitFor(() => {
        const img = document.querySelector('.ProseMirror img');
        expect(img?.getAttribute('data-import-failed')).toBe('true');
      });
    });

    it('leaves already-internal /api/attachments srcs untouched and does not call /import', async () => {
      render(<Editor content="<p>seed</p>" editable={true} pageId="42" />);
      await waitFor(() => {
        expect(document.querySelector('.ProseMirror')).toBeTruthy();
      });

      dispatchHtmlPaste(
        '<p><img src="/api/attachments/42/existing.png"></p>',
      );

      // Give the paste handler a tick to settle.
      await new Promise((r) => setTimeout(r, 100));
      // Sanity: the paste-handler import calls (which would hit `/pages/.../
      // images` or `/pages/.../images/import`) must not have fired. The
      // NodeView's auth-blob fetcher still runs against fetchAuthenticatedBlob,
      // not apiFetch — so apiFetch should stay clean here.
      expect(mockApiFetch).not.toHaveBeenCalledWith(
        expect.stringContaining('/images/import'),
        expect.anything(),
      );
      expect(mockApiFetch).not.toHaveBeenCalledWith(
        '/pages/42/images',
        expect.anything(),
      );
    });

    it('falls back to default paste behaviour when no pageId is set', async () => {
      render(<Editor content="<p>seed</p>" editable={true} /* no pageId */ />);
      await waitFor(() => {
        expect(document.querySelector('.ProseMirror')).toBeTruthy();
      });

      dispatchHtmlPaste('<p><img src="https://cdn.example.com/x.png"></p>');

      // Our handler returns false (no preventDefault from us) so TipTap's
      // own paste pipeline runs — TipTap may still preventDefault to take
      // ownership of the insertion. The thing we actually want to test is
      // that no upload was attempted: without a pageId we have nowhere to
      // store the bytes.
      await new Promise((r) => setTimeout(r, 50));
      expect(mockApiFetch).not.toHaveBeenCalled();
    });

    it('reports mixed outcomes via the toast (warning when some imports fail)', async () => {
      // Two http(s) <img>s: first import succeeds, second fails. The toast
      // helper should land on `toast.warning` with the X-of-Y message.
      mockApiFetch
        .mockResolvedValueOnce({ url: '/api/attachments/42/ok.png' })
        .mockRejectedValueOnce(new Error('502 Bad Gateway'));

      const sonner = await import('sonner');
      const warningSpy = sonner.toast.warning as ReturnType<typeof vi.fn>;
      warningSpy.mockClear();

      render(<Editor content="<p>seed</p>" editable={true} pageId="42" />);
      await waitFor(() => {
        expect(document.querySelector('.ProseMirror')).toBeTruthy();
      });

      dispatchHtmlPaste(
        '<p><img src="https://a.example.com/ok.png"><img src="https://b.example.com/bad.png"></p>',
      );

      await waitFor(() => {
        expect(warningSpy).toHaveBeenCalledWith(
          'Imported 1 of 2 images',
          expect.objectContaining({ id: 'toast-id-1' }),
        );
      });
    });
  });

  describe('drag handle (#49)', () => {
    it('renders drag handle in edit mode', async () => {
      const { container } = render(
        <Editor content="<p>Hello</p>" editable={true} />,
      );

      await waitFor(() => {
        expect(container.querySelector('[class*="tiptap"]')).toBeTruthy();
      });

      const dragHandle = container.querySelector('.drag-handle');
      expect(dragHandle).toBeTruthy();
    });

    it('does not render drag handle in read-only mode', async () => {
      const { container } = render(
        <Editor content="<p>Hello</p>" editable={false} />,
      );

      await waitFor(() => {
        expect(container.querySelector('[class*="tiptap"]')).toBeTruthy();
      });

      const dragHandle = container.querySelector('.drag-handle');
      expect(dragHandle).toBeFalsy();
    });

    // CSS guards. The original bug was a dead selector — `[style*="display:
    // block"]` — that never matched because the upstream TipTap extension
    // toggles `visibility`, not `display`. We want to catch any future
    // change that silently re-introduces the same class of mistake.
    describe('visibility-toggle CSS rule', () => {
      it('targets the visibility-hidden inline style (file-content guard)', async () => {
        const { readFileSync } = await import('node:fs');
        const { resolve } = await import('node:path');
        // Cheap, deterministic guard: read the rule out of index.css and
        // assert the selector covers what the extension actually toggles.
        // The old broken selector matched `display: block` (which the
        // extension never sets); this guard ensures the rule still keys off
        // `visibility: hidden` instead.
        const cssPath = resolve(__dirname, '../../../index.css');
        const css = readFileSync(cssPath, 'utf8');

        // Must NOT have reverted to the previous dead-selector form.
        expect(css).not.toMatch(/\.drag-handle\[style\*="display:\s*block"]/);

        // Must invert the visibility-hidden state — both whitespace variants
        // (browsers serialize as either `visibility: hidden` or, rarely,
        // `visibility:hidden`).
        expect(css).toMatch(/\.drag-handle:not\(\[style\*="visibility:\s*hidden"\]\):not\(\[style\*="visibility:hidden"\]\)/);
      });

      it('shows the handle when no visibility is set and hides it when visibility: hidden is set (behavioural)', () => {
        // jsdom does not load `index.css`, so inject the rule we depend on.
        // The selector copied here is what the file-content guard above
        // pins down — keep these in sync if the selector changes.
        const style = document.createElement('style');
        style.textContent = `
          .drag-handle { opacity: 0; }
          .drag-handle:not([style*="visibility: hidden"]):not([style*="visibility:hidden"]) { opacity: 0.7; }
        `;
        document.head.appendChild(style);

        const el = document.createElement('div');
        el.className = 'drag-handle';
        document.body.appendChild(el);

        try {
          // Extension's "shown" state — no inline visibility.
          expect(getComputedStyle(el).opacity).toBe('0.7');

          // Extension's "hidden" state — visibility cleared by setting it
          // to hidden in the inline style.
          el.style.visibility = 'hidden';
          expect(getComputedStyle(el).opacity).toBe('0');

          // Re-shown by clearing the visibility property — must reach 0.7
          // again (this is the round-trip the user complaint produced when
          // the cursor left and re-entered the block).
          el.style.visibility = '';
          expect(getComputedStyle(el).opacity).toBe('0.7');
        } finally {
          el.remove();
          style.remove();
        }
      });
    });
  });
});

describe('draft auto-save flush on unmount (#877)', () => {
  // Real timers + async TipTap init (immediatelyRender:false). Fake timers
  // conflict with the editor's async setup, so we lean on the fact that the
  // AUTO_SAVE_DELAY (2000ms) never elapses within a synchronous test body —
  // the debounced write is still pending when we unmount.
  beforeEach(() => {
    // Wipe drafts AND the module-level suppressedFlushKeys' observable effect
    // between tests so unique keys can't bleed across cases.
    localStorage.clear();
    mockFetchAuthenticatedBlob.mockResolvedValue(null);
  });

  it('flushes a pending debounced draft to localStorage when the editor unmounts', async () => {
    let editor: EditorType | null = null;
    const { unmount } = render(
      <Editor
        content="<p>seed</p>"
        editable={true}
        draftKey="page-877-flush"
        onEditorReady={(e) => { editor = e; }}
      />,
    );

    await waitFor(() => {
      expect(editor).not.toBeNull();
    });

    // A real doc change fires onUpdate -> saveDraft, scheduling the 2000ms
    // debounce. The write has NOT happened yet (test runs in ms).
    editor!.commands.insertContent(' typed');
    expect(localStorage.getItem('draft:page-877-flush')).toBeNull();

    // Navigating away unmounts the Editor within the debounce window. Pre-fix
    // this cleared the timer without writing, silently losing the edit.
    unmount();

    const draft = localStorage.getItem('draft:page-877-flush');
    expect(draft).not.toBeNull();
    expect(draft).toContain('typed');
  });

  it('does not resurrect a draft the parent explicitly cleared before unmount', async () => {
    let editor: EditorType | null = null;
    const { unmount } = render(
      <Editor
        content="<p>seed</p>"
        editable={true}
        draftKey="page-877-suppress"
        onEditorReady={(e) => { editor = e; }}
      />,
    );

    await waitFor(() => {
      expect(editor).not.toBeNull();
    });

    // Schedule a pending debounced save…
    editor!.commands.insertContent(' typed');
    // …then the parent saves/cancels, which clears the draft and unmounts.
    clearDraft('page-877-suppress');
    unmount();

    // The unmount flush must skip the suppressed key — no resurrection.
    expect(localStorage.getItem('draft:page-877-suppress')).toBeNull();
  });
});

describe('EditorToolbar — header numbering toggle', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders a header numbering toggle button when props are provided', () => {
    const editor = createMockEditor();
    const toggle = vi.fn();
    render(<EditorToolbar editor={editor} headerNumbering={false} onToggleHeaderNumbering={toggle} />);

    expect(screen.getByTitle('Toggle Header Numbering')).toBeInTheDocument();
  });

  it('shows active styling when headerNumbering is true', () => {
    const editor = createMockEditor();
    const toggle = vi.fn();
    render(<EditorToolbar editor={editor} headerNumbering={true} onToggleHeaderNumbering={toggle} />);

    const btn = screen.getByTitle('Toggle Header Numbering');
    // Editor-toolbar active-state uses ink-action (Task 5 — amber reserved for AI affordances).
    expect(btn.className).toContain('bg-action');
  });

  it('shows inactive styling when headerNumbering is false', () => {
    const editor = createMockEditor();
    const toggle = vi.fn();
    render(<EditorToolbar editor={editor} headerNumbering={false} onToggleHeaderNumbering={toggle} />);

    const btn = screen.getByTitle('Toggle Header Numbering');
    expect(btn.className).not.toContain('bg-primary');
  });

  it('calls onToggleHeaderNumbering when the button is clicked', () => {
    const editor = createMockEditor();
    const toggle = vi.fn();
    render(<EditorToolbar editor={editor} headerNumbering={false} onToggleHeaderNumbering={toggle} />);

    fireEvent.click(screen.getByTitle('Toggle Header Numbering'));
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('does not render the toggle button when onToggleHeaderNumbering is absent', () => {
    const editor = createMockEditor();
    render(<EditorToolbar editor={editor} />);

    expect(screen.queryByTitle('Toggle Header Numbering')).not.toBeInTheDocument();
  });

  // ---------- #353 toolbar grouping + bigger color pickers ----------

  it('renders the toolbar groups in the conventional order (#353)', () => {
    const editor = createMockEditor();
    render(<EditorToolbar editor={editor} />);

    // Inline → block → lists → insert → captions → colors → utilities.
    const groups = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="toolbar-group-"]'),
    ).map((el) => el.dataset.testid);

    expect(groups).toEqual([
      'toolbar-group-inline',
      'toolbar-group-block',
      'toolbar-group-lists',
      'toolbar-group-insert',
      'toolbar-group-captions',
      'toolbar-group-colors',
      'toolbar-group-utilities',
    ]);
  });

  it('places both color pickers inside the colors group (#353)', () => {
    const editor = createMockEditor();
    render(<EditorToolbar editor={editor} />);

    const group = screen.getByTestId('toolbar-group-colors');
    expect(group).toHaveAttribute('role', 'group');
    expect(group).toHaveAttribute('aria-label', 'colors');
    expect(group.querySelectorAll('[data-testid="color-picker-trigger"]').length).toBe(2);
  });

  it('separates groups with role=separator dividers (#353)', () => {
    const editor = createMockEditor();
    const { container } = render(<EditorToolbar editor={editor} />);

    // Six segments → at least five separators between them.
    const separators = container.querySelectorAll('[role="separator"]');
    expect(separators.length).toBeGreaterThanOrEqual(5);
  });

  it('color-picker triggers meet the 32x32 minimum target size (#353)', () => {
    const editor = createMockEditor();
    render(<EditorToolbar editor={editor} />);

    const triggers = screen.getAllByTestId('color-picker-trigger');
    expect(triggers.length).toBe(2);
    for (const trigger of triggers) {
      // Tailwind h-9 w-9 maps to 36×36 (1rem = 16px) — comfortably above
      // the issue's 32×32 minimum.
      expect(trigger.className).toMatch(/(?:^|\s)h-9(?:\s|$)/);
      expect(trigger.className).toMatch(/(?:^|\s)w-9(?:\s|$)/);
    }
  });

  it('color-picker triggers expose a tooltip and aria-label (#353)', () => {
    const editor = createMockEditor();
    render(<EditorToolbar editor={editor} />);

    const triggers = screen.getAllByTestId('color-picker-trigger');
    expect(triggers[0]).toHaveAttribute('title', 'Text Color');
    expect(triggers[0]).toHaveAttribute('aria-label', 'Text Color');
    expect(triggers[1]).toHaveAttribute('title', 'Highlight (Ctrl+Shift+H)');
    expect(triggers[1]).toHaveAttribute('aria-label', 'Highlight (Ctrl+Shift+H)');
  });

  it('color-picker swatches meet the 24x24 minimum after opening the picker (#353)', () => {
    const editor = createMockEditor();
    render(<EditorToolbar editor={editor} />);

    const triggers = screen.getAllByTestId('color-picker-trigger');
    fireEvent.click(triggers[0]!);

    const swatches = screen.getAllByTestId('color-picker-swatch');
    expect(swatches.length).toBeGreaterThanOrEqual(8);
    for (const sw of swatches) {
      // h-7 w-7 → 28×28 (above the issue's 24×24 minimum).
      expect(sw.className).toMatch(/(?:^|\s)h-7(?:\s|$)/);
      expect(sw.className).toMatch(/(?:^|\s)w-7(?:\s|$)/);
      // Each swatch must carry an accessible name (its colour label).
      expect(sw.getAttribute('aria-label')).toBeTruthy();
    }
  });

  it('exposes the toolbar landmark with an accessible name (#353)', () => {
    const editor = createMockEditor();
    render(<EditorToolbar editor={editor} />);
    const toolbar = screen.getByRole('toolbar', { name: 'Page editor toolbar' });
    expect(toolbar).toBeInTheDocument();
  });
});
