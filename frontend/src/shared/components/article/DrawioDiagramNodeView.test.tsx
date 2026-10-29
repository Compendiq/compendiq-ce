import { afterEach, describe, it, expect, vi } from 'vitest';
import { Blob as NativeBlob } from 'node:buffer';
import { drawioPngBytes } from '../../lib/drawio-source.test-fixtures';
import { render, screen, fireEvent } from '@testing-library/react';
import { DrawioDiagramNodeView } from './DrawioDiagramNodeView';
import type { NodeViewProps } from '@tiptap/react';

// Mock the DrawioEditor component to avoid loading the iframe in tests
vi.mock('../diagrams/DrawioEditor', () => ({
  DrawioEditor: ({ xml, onSave, onClose }: { xml: string; onSave: (d: string, x: string) => Promise<void>; onClose: () => void }) => (
    <div data-testid="mock-drawio-editor" data-xml={xml}>
      <button data-testid="mock-save" onClick={() => onSave('data:image/png;base64,abc', '<mxGraphModel/>')}>Save</button>
      <button data-testid="mock-close" onClick={onClose}>Close</button>
    </div>
  ),
}));

// Mock lucide-react icons to avoid render issues in jsdom
vi.mock('lucide-react', () => ({
  Pencil: () => <span data-testid="icon-pencil" />,
  Trash2: () => <span data-testid="icon-trash" />,
  Plus: () => <span data-testid="icon-plus" />,
  GripVertical: () => <span data-testid="icon-grip" />,
}));

function makeProps(overrides: Partial<NodeViewProps> = {}): NodeViewProps {
  return {
    node: {
      attrs: {
        src: null,
        alt: 'Diagram',
        diagramName: null,
        xml: null,
        pngDataUri: null,
        editHref: '#',
      },
      ...overrides.node,
    },
    updateAttributes: vi.fn(),
    deleteNode: vi.fn(),
    editor: {
      isEditable: true,
      ...overrides.editor,
    },
    // Minimal stubs for other NodeViewProps fields
    getPos: () => 0,
    extension: {} as NodeViewProps['extension'],
    HTMLAttributes: {},
    decorations: [],
    selected: false,
    ...overrides,
  } as unknown as NodeViewProps;
}

afterEach(() => vi.unstubAllGlobals());

describe('DrawioDiagramNodeView', () => {
  it('renders placeholder when no image is available', () => {
    render(<DrawioDiagramNodeView {...makeProps()} />);

    const placeholder = screen.getByTestId('drawio-placeholder');
    expect(placeholder).toBeTruthy();
    expect(placeholder.textContent).toContain('Click to create a draw.io diagram');
  });

  it('renders image preview when src is set', () => {
    const props = makeProps({
      node: {
        attrs: {
          src: '/api/attachments/page-1/diagram.png',
          alt: 'My Diagram',
          diagramName: 'system-arch',
          xml: null,
          pngDataUri: null,
          editHref: '#',
        },
      } as NodeViewProps['node'],
    });

    const { container } = render(<DrawioDiagramNodeView {...props} />);
    const img = container.querySelector('img');
    expect(img).toBeTruthy();
    expect(img?.getAttribute('src')).toBe('/api/attachments/page-1/diagram.png');
    expect(img?.getAttribute('alt')).toBe('My Diagram');
  });

  it('prefers pngDataUri over src for display', () => {
    const props = makeProps({
      node: {
        attrs: {
          src: '/api/attachments/page-1/old.png',
          alt: 'Diagram',
          diagramName: 'test',
          xml: '<mxGraphModel/>',
          pngDataUri: 'data:image/png;base64,newpng',
          editHref: '#',
        },
      } as NodeViewProps['node'],
    });

    const { container } = render(<DrawioDiagramNodeView {...props} />);
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe('data:image/png;base64,newpng');
  });

  it('shows edit and delete buttons on hover when editable', () => {
    const props = makeProps({
      node: {
        attrs: {
          src: '/test.png',
          alt: 'Diagram',
          diagramName: 'test',
          xml: null,
          pngDataUri: null,
          editHref: '#',
        },
      } as NodeViewProps['node'],
    });

    render(<DrawioDiagramNodeView {...props} />);
    expect(screen.getByTestId('drawio-edit-btn')).toBeTruthy();
    expect(screen.getByTestId('drawio-delete-btn')).toBeTruthy();
  });

  it('does not show edit/delete buttons when not editable', () => {
    const props = makeProps({
      node: {
        attrs: {
          src: '/test.png',
          alt: 'Diagram',
          diagramName: 'test',
          xml: null,
          pngDataUri: null,
          editHref: '#',
        },
      } as NodeViewProps['node'],
      editor: { isEditable: false } as NodeViewProps['editor'],
    });

    render(<DrawioDiagramNodeView {...props} />);
    expect(screen.queryByTestId('drawio-edit-btn')).toBeNull();
    expect(screen.queryByTestId('drawio-delete-btn')).toBeNull();
  });

  it('opens DrawioEditor when edit button is clicked', async () => {
    const props = makeProps({
      node: {
        attrs: {
          src: '/test.png',
          alt: 'Diagram',
          diagramName: 'test',
          xml: '<mxGraphModel/>',
          pngDataUri: null,
          editHref: '#',
        },
      } as NodeViewProps['node'],
    });

    render(<DrawioDiagramNodeView {...props} />);
    expect(screen.queryByTestId('mock-drawio-editor')).toBeNull();

    fireEvent.click(screen.getByTestId('drawio-edit-btn'));
    expect(await screen.findByTestId('mock-drawio-editor')).toBeTruthy();
  });

  it('opens DrawioEditor on placeholder click for new diagrams', () => {
    render(<DrawioDiagramNodeView {...makeProps()} />);

    fireEvent.click(screen.getByTestId('drawio-placeholder'));
    expect(screen.getByTestId('mock-drawio-editor')).toBeTruthy();
  });

  it('shows an unavailable preview for existing diagrams and opens their stored XML', async () => {
    const props = makeProps({
      node: { attrs: { diagramName: 'architecture', xml: '<mxGraphModel id="original"/>' } } as NodeViewProps['node'],
    });
    const { container } = render(<DrawioDiagramNodeView {...props} />);
    expect(screen.getByTestId('drawio-unavailable').textContent).toContain('Preview unavailable: architecture');
    expect(screen.queryByTestId('drawio-placeholder')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit diagram' }));
    expect((await screen.findByTestId('mock-drawio-editor')).getAttribute('data-xml')).toBe('<mxGraphModel id="original"/>');
  });

  it('loads the cached source for an existing diagram without inline XML', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true, text: async () => '<mxGraphModel id="cached"/>',
    } as Response);
    const props = makeProps({
      node: { attrs: { diagramName: 'architecture', drawioSource: '/api/attachments/123/architecture.drawio' } } as NodeViewProps['node'],
    });
    render(<DrawioDiagramNodeView {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit diagram' }));
    const editor = await screen.findByTestId('mock-drawio-editor');
    expect(editor.getAttribute('data-xml')).toBe('<mxGraphModel id="cached"/>');
    expect(fetchMock).toHaveBeenCalledWith('/api/attachments/123/architecture.drawio', expect.objectContaining({ credentials: 'include', cache: 'no-store' }));
    fetchMock.mockRestore();
  });

  it.each(['valid', 'missing', 'bad-200'] as const)('tries the preview without creating an empty diagram (%s)', async (payload) => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ close: vi.fn() }));
    const source = '/api/attachments/123/architecture.drawio';
    const preview = '/api/attachments/123/architecture.png';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input) === source || payload === 'missing') return { ok: false, status: 404 } as Response;
      return { ok: true, blob: async () => new NativeBlob([payload === 'valid' ? drawioPngBytes() : '<html>not a diagram</html>'], { type: 'image/png' }) } as unknown as Response;
    });
    const props = makeProps({
      node: { attrs: { diagramName: 'architecture', drawioSource: source, src: preview } } as NodeViewProps['node'],
    });
    render(<DrawioDiagramNodeView {...props} />);
    fireEvent.click(screen.getByTestId('drawio-edit-btn'));
    if (payload === 'valid') {
      expect((await screen.findByTestId('mock-drawio-editor')).getAttribute('data-xml'))
        .toContain('Standalone recovered preview');
    } else {
      expect(await screen.findByRole('alert')).toHaveTextContent('Could not load');
      expect(screen.queryByTestId('mock-drawio-editor')).toBeNull();
      expect(props.updateAttributes).not.toHaveBeenCalled();
    }
    expect(fetchMock).toHaveBeenCalledWith(source, expect.objectContaining({ cache: 'no-store' }));
    expect(fetchMock).toHaveBeenCalledWith(preview, expect.objectContaining({ cache: 'no-store' }));
    fetchMock.mockRestore();
  });

  it('does not open a blank editor when the source cannot be loaded', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: false, status: 404 } as Response);
    const updateAttributes = vi.fn();
    const props = makeProps({
      updateAttributes,
      node: { attrs: { diagramName: 'architecture', drawioSource: '/api/attachments/123/architecture.drawio' } } as NodeViewProps['node'],
    });
    render(<DrawioDiagramNodeView {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit diagram' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Could not load');
    expect(screen.queryByTestId('mock-drawio-editor')).toBeNull();
    expect(updateAttributes).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it('does not open a blank editor when an existing diagram has no source location', () => {
    const props = makeProps({
      node: { attrs: { diagramName: 'architecture' } } as NodeViewProps['node'],
    });
    render(<DrawioDiagramNodeView {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit diagram' }));
    expect(screen.getByRole('alert').textContent).toContain('source is unavailable');
    expect(screen.queryByTestId('mock-drawio-editor')).toBeNull();
  });

  it('does not fetch an external source URL supplied in page HTML', () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const props = makeProps({
      node: { attrs: { diagramName: 'architecture', drawioSource: 'https://example.test/source.drawio' } } as NodeViewProps['node'],
    });
    render(<DrawioDiagramNodeView {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit diagram' }));
    expect(screen.getByRole('alert').textContent).toContain('source is unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it('rejects an empty cached source instead of opening a blank editor', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true, text: async () => '  ',
    } as Response);
    const props = makeProps({
      node: { attrs: { diagramName: 'architecture', drawioSource: '/api/attachments/123/architecture.drawio' } } as NodeViewProps['node'],
    });
    render(<DrawioDiagramNodeView {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit diagram' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByTestId('mock-drawio-editor')).toBeNull();
    fetchMock.mockRestore();
  });

  it('shows unavailable preview without editing controls in read-only mode', () => {
    const props = makeProps({
      node: { attrs: { diagramName: 'architecture' } } as NodeViewProps['node'],
      editor: { isEditable: false } as NodeViewProps['editor'],
    });
    render(<DrawioDiagramNodeView {...props} />);
    expect(screen.getByTestId('drawio-unavailable')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('calls updateAttributes with diagram data on save', async () => {
    const updateAttributes = vi.fn();
    const props = makeProps({
      updateAttributes,
      node: {
        attrs: {
          src: '/test.png',
          alt: 'Diagram',
          diagramName: null,
          xml: '<mxGraphModel/>',
          pngDataUri: null,
          editHref: '#',
        },
      } as NodeViewProps['node'],
    });

    render(<DrawioDiagramNodeView {...props} />);
    fireEvent.click(screen.getByTestId('drawio-edit-btn'));
    fireEvent.click(await screen.findByTestId('mock-save'));

    await vi.waitFor(() => {
      expect(updateAttributes).toHaveBeenCalledWith({
        pngDataUri: 'data:image/png;base64,abc',
        xml: '<mxGraphModel/>',
        drawioSource: null,
        diagramName: expect.stringMatching(/^diagram-\d+$/),
      });
    });
  });

  it('calls deleteNode when delete button is clicked', () => {
    const deleteNode = vi.fn();
    const props = makeProps({
      deleteNode,
      node: {
        attrs: {
          src: '/test.png',
          alt: 'Diagram',
          diagramName: 'test',
          xml: null,
          pngDataUri: null,
          editHref: '#',
        },
      } as NodeViewProps['node'],
    });

    render(<DrawioDiagramNodeView {...props} />);
    fireEvent.click(screen.getByTestId('drawio-delete-btn'));
    expect(deleteNode).toHaveBeenCalled();
  });

  it('shows Confluence badge for diagrams without xml', () => {
    const props = makeProps({
      node: {
        attrs: {
          src: '/test.png',
          alt: 'Diagram',
          diagramName: 'imported-diagram',
          xml: null,
          pngDataUri: null,
          editHref: '#',
        },
      } as NodeViewProps['node'],
    });

    const { container } = render(<DrawioDiagramNodeView {...props} />);
    const badge = container.querySelector('.drawio-nodeview__badge');
    expect(badge).toBeTruthy();
    expect(badge?.textContent).toBe('Confluence');
  });

  it('does not show Confluence badge for diagrams with xml', () => {
    const props = makeProps({
      node: {
        attrs: {
          src: '/test.png',
          alt: 'Diagram',
          diagramName: 'local-diagram',
          xml: '<mxGraphModel/>',
          pngDataUri: null,
          editHref: '#',
        },
      } as NodeViewProps['node'],
    });

    const { container } = render(<DrawioDiagramNodeView {...props} />);
    const badge = container.querySelector('.drawio-nodeview__badge');
    expect(badge).toBeNull();
  });

  it('closes DrawioEditor when close is clicked', async () => {
    const props = makeProps({
      node: {
        attrs: {
          src: '/test.png',
          alt: 'Diagram',
          diagramName: 'test',
          xml: '<mxGraphModel/>',
          pngDataUri: null,
          editHref: '#',
        },
      } as NodeViewProps['node'],
    });

    render(<DrawioDiagramNodeView {...props} />);
    fireEvent.click(screen.getByTestId('drawio-edit-btn'));
    expect(await screen.findByTestId('mock-drawio-editor')).toBeTruthy();

    fireEvent.click(screen.getByTestId('mock-close'));
    expect(screen.queryByTestId('mock-drawio-editor')).toBeNull();
  });
});
