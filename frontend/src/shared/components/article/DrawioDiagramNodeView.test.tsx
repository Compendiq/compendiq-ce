import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DrawioDiagramNodeView } from './DrawioDiagramNodeView';
import type { NodeViewProps } from '@tiptap/react';

// Mock the DrawioEditor component to avoid loading the iframe in tests
vi.mock('../diagrams/DrawioEditor', () => ({
  DrawioEditor: ({ onSave, onClose }: { onSave: (d: string, x: string) => Promise<void>; onClose: () => void }) => (
    <div data-testid="mock-drawio-editor">
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

  it('opens DrawioEditor when edit button is clicked', () => {
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
    expect(screen.getByTestId('mock-drawio-editor')).toBeTruthy();
  });

  it('opens DrawioEditor on placeholder click for new diagrams', () => {
    render(<DrawioDiagramNodeView {...makeProps()} />);

    fireEvent.click(screen.getByTestId('drawio-placeholder'));
    expect(screen.getByTestId('mock-drawio-editor')).toBeTruthy();
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
          xml: null,
          pngDataUri: null,
          editHref: '#',
        },
      } as NodeViewProps['node'],
    });

    render(<DrawioDiagramNodeView {...props} />);
    fireEvent.click(screen.getByTestId('drawio-edit-btn'));
    fireEvent.click(screen.getByTestId('mock-save'));

    await vi.waitFor(() => {
      expect(updateAttributes).toHaveBeenCalledWith({
        pngDataUri: 'data:image/png;base64,abc',
        xml: '<mxGraphModel/>',
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

  it('closes DrawioEditor when close is clicked', () => {
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
    expect(screen.getByTestId('mock-drawio-editor')).toBeTruthy();

    fireEvent.click(screen.getByTestId('mock-close'));
    expect(screen.queryByTestId('mock-drawio-editor')).toBeNull();
  });
});
