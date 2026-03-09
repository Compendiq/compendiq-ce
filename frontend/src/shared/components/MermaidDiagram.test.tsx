import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Mock mermaid
const mockRender = vi.fn();
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: (...args: unknown[]) => mockRender(...args),
  },
}));

// Mock clipboard API
const mockWriteText = vi.fn().mockResolvedValue(undefined);
Object.assign(navigator, {
  clipboard: { writeText: mockWriteText },
});

import { MermaidDiagram } from './MermaidDiagram';

describe('MermaidDiagram', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRender.mockResolvedValue({ svg: '<svg>diagram</svg>' });
  });

  it('renders the toolbar with Mermaid Diagram label', () => {
    render(<MermaidDiagram code="graph TD\n  A --> B" />);
    expect(screen.getByText('Mermaid Diagram')).toBeInTheDocument();
  });

  it('calls mermaid.render with the code', async () => {
    const code = 'graph TD\n  A --> B';
    render(<MermaidDiagram code={code} />);

    await waitFor(() => {
      expect(mockRender).toHaveBeenCalled();
      const [, renderedCode] = mockRender.mock.calls[0];
      expect(renderedCode).toBe(code);
    });
  });

  it('strips markdown fences from code before rendering', async () => {
    render(<MermaidDiagram code={'```mermaid\ngraph TD\n  A --> B\n```'} />);

    await waitFor(() => {
      expect(mockRender).toHaveBeenCalled();
      const [, renderedCode] = mockRender.mock.calls[0];
      expect(renderedCode).toBe('graph TD\n  A --> B');
    });
  });

  it('shows error message when mermaid.render fails', async () => {
    mockRender.mockRejectedValue(new Error('Parse error'));

    render(<MermaidDiagram code="invalid mermaid code" />);

    await waitFor(() => {
      expect(screen.getByText(/Diagram rendering failed/)).toBeInTheDocument();
      expect(screen.getByText(/Parse error/)).toBeInTheDocument();
    });
  });

  it('displays raw code as fallback when rendering fails', async () => {
    mockRender.mockRejectedValue(new Error('Parse error'));

    render(<MermaidDiagram code="invalid code here" />);

    await waitFor(() => {
      expect(screen.getByText('invalid code here')).toBeInTheDocument();
    });
  });

  it('copies code to clipboard when copy button is clicked', async () => {
    const code = 'graph TD\n  A --> B';
    render(<MermaidDiagram code={code} />);

    const copyButton = screen.getByTitle('Copy Mermaid source');
    fireEvent.click(copyButton);

    expect(mockWriteText).toHaveBeenCalledWith(code);
  });

  it('shows download button after successful render', async () => {
    render(<MermaidDiagram code="graph TD\n  A --> B" />);

    await waitFor(() => {
      expect(screen.getByTitle('Download as SVG')).toBeInTheDocument();
    });
  });

  it('does not render when code is empty', () => {
    render(<MermaidDiagram code="" />);
    expect(mockRender).not.toHaveBeenCalled();
  });

  it('applies custom className', () => {
    const { container } = render(<MermaidDiagram code="graph TD\n  A --> B" className="mt-4" />);
    expect(container.firstChild).toHaveClass('mt-4');
  });

  it('renders diagrams with style directives and special characters', async () => {
    const code = [
      'graph LR',
      '    A[Start] --> B{vSphere Available?};',
      '    B -- Yes --> D[Create Snapshots (vc-003 & vc-004)];',
      '    style A fill:#f9f,stroke:#333,stroke-width:2px',
    ].join('\n');

    render(<MermaidDiagram code={code} />);

    await waitFor(() => {
      expect(mockRender).toHaveBeenCalled();
      const [, renderedCode] = mockRender.mock.calls[0];
      expect(renderedCode).toBe(code);
    });
  });
});
