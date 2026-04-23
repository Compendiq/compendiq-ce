import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { drainPendingDrawioDiagrams } from './drawio-save-drain';

/**
 * These tests stub just enough of the TipTap Editor shape to exercise the
 * drain logic: `state.doc.descendants`, `state.doc.nodeAt`, `state.tr`,
 * and `view.dispatch`. No ProseMirror runtime is pulled in.
 */

interface StubNode {
  type: { name: string };
  attrs: {
    diagramName: string | null;
    xml: string | null;
    pngDataUri: string | null;
    src: string | null;
  };
}

function makeEditor(nodes: Array<{ pos: number; node: StubNode }>) {
  const byPos = new Map(nodes.map((n) => [n.pos, n.node]));
  const dispatched: Array<{ pos: number; attrs: Record<string, unknown> }> = [];

  const trFactory = () => {
    const tr = {
      setNodeMarkup(pos: number, _type: unknown, attrs: Record<string, unknown>) {
        dispatched.push({ pos, attrs });
        // Mutate the stub so subsequent nodeAt calls in the same loop see
        // the new attrs (mirrors real ProseMirror semantics within one drain run).
        const node = byPos.get(pos);
        if (node) node.attrs = { ...node.attrs, ...(attrs as StubNode['attrs']) };
        return tr;
      },
    };
    return tr;
  };

  return {
    editor: {
      state: {
        doc: {
          descendants(cb: (node: StubNode, pos: number) => void) {
            for (const { pos, node } of nodes) cb(node, pos);
          },
          nodeAt(pos: number) {
            return byPos.get(pos) ?? null;
          },
        },
        get tr() {
          return trFactory();
        },
      },
      view: {
        dispatch: vi.fn(),
      },
    },
    dispatched,
  };
}

function diagramNode(attrs: Partial<StubNode['attrs']>): StubNode {
  return {
    type: { name: 'drawioDiagram' },
    attrs: {
      diagramName: null,
      xml: null,
      pngDataUri: null,
      src: null,
      ...attrs,
    },
  };
}

describe('drainPendingDrawioDiagrams (#302 Gap 3)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ success: true, filename: 'diagram.png' }),
      text: () => Promise.resolve('{"success":true,"filename":"diagram.png"}'),
      clone() {
        return this;
      },
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('no-ops when editor is null', async () => {
    const res = await drainPendingDrawioDiagrams(null, {
      attachmentPageId: 'page-1',
      pageSource: 'confluence',
    });
    expect(res).toEqual({ uploaded: 0, skipped: 0, failed: 0, errors: [] });
  });

  it('no-ops when no drawio nodes have a pngDataUri', async () => {
    const { editor } = makeEditor([
      { pos: 3, node: diagramNode({ src: '/already-there.png' }) },
      { pos: 7, node: diagramNode({}) }, // nothing set either
    ]);
    const res = await drainPendingDrawioDiagrams(editor as never, {
      attachmentPageId: 'page-1',
      pageSource: 'confluence',
    });
    expect(res.uploaded).toBe(0);
    expect(res.skipped).toBe(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('uploads each pending diagram and rewrites src + clears pngDataUri', async () => {
    const { editor, dispatched } = makeEditor([
      {
        pos: 5,
        node: diagramNode({
          diagramName: 'alpha',
          pngDataUri: 'data:image/png;base64,AAAA',
          xml: '<mxfile>alpha</mxfile>',
        }),
      },
      {
        pos: 42,
        node: diagramNode({
          pngDataUri: 'data:image/png;base64,BBBB',
        }),
      },
    ]);

    const res = await drainPendingDrawioDiagrams(editor as never, {
      attachmentPageId: 'conf-page-123',
      pageSource: 'confluence',
    });

    expect(res.uploaded).toBe(2);
    expect(res.failed).toBe(0);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);

    // First call: 'alpha' name preserved, xml passed through.
    const firstCall = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(firstCall[0]).toContain('/attachments/conf-page-123/alpha.png');
    const firstBody = JSON.parse((firstCall[1] as { body: string }).body);
    expect(firstBody.dataUri).toBe('data:image/png;base64,AAAA');
    expect(firstBody.xml).toBe('<mxfile>alpha</mxfile>');

    // Second call: auto-generated name based on Date.now + pos (deterministic prefix).
    const secondCall = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(secondCall[0]).toMatch(/\/attachments\/conf-page-123\/diagram-\d+-42\.png/);
    const secondBody = JSON.parse((secondCall[1] as { body: string }).body);
    expect(secondBody.xml).toBeUndefined(); // no xml on the 2nd diagram

    // Both nodes were rewritten via setNodeMarkup.
    expect(dispatched).toHaveLength(2);
    expect(dispatched[0]!.attrs.src).toBe('/api/attachments/conf-page-123/alpha.png');
    expect(dispatched[0]!.attrs.pngDataUri).toBeNull();
    expect(dispatched[1]!.attrs.src).toMatch(/^\/api\/attachments\/conf-page-123\/diagram-\d+-42\.png$/);
  });

  it('routes standalone pages to /api/local-attachments (#302 Gap 4)', async () => {
    const { editor, dispatched } = makeEditor([
      {
        pos: 5,
        node: diagramNode({
          diagramName: 'local-flow',
          pngDataUri: 'data:image/png;base64,AAAA',
          xml: '<mxfile>local</mxfile>',
        }),
      },
    ]);
    const res = await drainPendingDrawioDiagrams(editor as never, {
      attachmentPageId: '42',
      pageSource: 'standalone',
    });

    expect(res.uploaded).toBe(1);
    expect(res.skipped).toBe(0);
    expect(res.failed).toBe(0);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    // URL prefix is `/local-attachments`, not `/attachments`
    expect(call[0]).toContain('/local-attachments/42/local-flow.png');
    const body = JSON.parse((call[1] as { body: string }).body);
    expect(body.dataUri).toBe('data:image/png;base64,AAAA');
    expect(body.xml).toBe('<mxfile>local</mxfile>');

    // Node rewritten with the local URL
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.attrs.src).toBe('/api/local-attachments/42/local-flow.png');
  });

  it('reports failures without blocking other diagrams', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ success: true }),
        text: () => Promise.resolve('{"success":true}'),
        clone() { return this; },
      });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const { editor } = makeEditor([
      { pos: 5, node: diagramNode({ diagramName: 'broken', pngDataUri: 'data:image/png;base64,AAAA' }) },
      { pos: 6, node: diagramNode({ diagramName: 'works', pngDataUri: 'data:image/png;base64,BBBB' }) },
    ]);
    const res = await drainPendingDrawioDiagrams(editor as never, {
      attachmentPageId: 'page-1',
      pageSource: 'confluence',
    });
    expect(res.uploaded).toBe(1);
    expect(res.failed).toBe(1);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toMatch(/^broken:/);
  });

  it('fails cleanly when attachmentPageId is missing', async () => {
    const { editor } = makeEditor([
      { pos: 5, node: diagramNode({ pngDataUri: 'data:image/png;base64,AAAA' }) },
    ]);
    const res = await drainPendingDrawioDiagrams(editor as never, {
      attachmentPageId: null,
      pageSource: 'confluence',
    });
    expect(res.failed).toBe(1);
    expect(res.uploaded).toBe(0);
    expect(res.errors[0]).toMatch(/no attachment id/);
  });
});
