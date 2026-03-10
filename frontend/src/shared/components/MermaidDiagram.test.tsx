import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Mock mermaid - use vi.hoisted to ensure the mock fns are available before vi.mock runs
const { mockRender, mockInitialize } = vi.hoisted(() => ({
  mockRender: vi.fn(),
  mockInitialize: vi.fn(),
}));

vi.mock('mermaid', () => ({
  default: {
    initialize: (...args: unknown[]) => mockInitialize(...args),
    render: (...args: unknown[]) => mockRender(...args),
  },
}));

// Mock useIsLightTheme hook
const { mockIsLight } = vi.hoisted(() => ({
  mockIsLight: vi.fn().mockReturnValue(false),
}));

vi.mock('../hooks/use-is-light-theme', () => ({
  useIsLightTheme: () => mockIsLight(),
}));

// Mock clipboard API
const mockWriteText = vi.fn().mockResolvedValue(undefined);
Object.assign(navigator, {
  clipboard: { writeText: mockWriteText },
});

import {
  MermaidDiagram,
  sanitizeMermaidCode,
  initializeMermaid,
  loadMermaid,
  _resetMermaidCache,
} from './MermaidDiagram';

describe('MermaidDiagram', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    _resetMermaidCache();
    mockRender.mockResolvedValue({ svg: '<svg>diagram</svg>' });
    // Pre-warm the mermaid cache so the lazy import resolves instantly
    // in component effects. Without this, the dynamic import microtask
    // may not flush within the React test scheduler.
    await loadMermaid();
  });

  afterEach(() => {
    _resetMermaidCache();
  });

  it('renders the toolbar with Mermaid Diagram label', () => {
    render(<MermaidDiagram code="graph TD\n  A --> B" />);
    expect(screen.getByText('Mermaid Diagram')).toBeInTheDocument();
  });

  it('calls mermaid.render with the code after lazy-loading', async () => {
    const code = 'graph TD\n  A --> B';
    render(<MermaidDiagram code={code} />);

    await waitFor(() => {
      expect(mockRender).toHaveBeenCalled();
      const [, renderedCode] = mockRender.mock.calls[0];
      expect(renderedCode).toBe(code);
    });
  });

  it('hides loading skeleton after mermaid loads and renders', async () => {
    render(<MermaidDiagram code="graph TD\n  A --> B" />);

    await waitFor(() => {
      expect(mockRender).toHaveBeenCalled();
    });

    expect(screen.queryByTestId('mermaid-loading')).not.toBeInTheDocument();
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
    const { container } = render(
      <MermaidDiagram code="graph TD\n  A --> B" className="mt-4" />,
    );
    expect(container.firstChild).toHaveClass('mt-4');
  });

  it('sanitizes node labels with special characters before rendering', async () => {
    const code = 'graph TD\n  A[Deploy (30min downtime)] --> B[Done]';
    render(<MermaidDiagram code={code} />);

    await waitFor(() => {
      expect(mockRender).toHaveBeenCalled();
      const [, renderedCode] = mockRender.mock.calls[0];
      expect(renderedCode).toContain('A["Deploy (30min downtime)"]');
    });
  });

  it('re-renders when theme changes from dark to light', async () => {
    mockIsLight.mockReturnValue(false);
    const code = 'graph TD\n  A --> B';
    const { rerender } = render(<MermaidDiagram code={code} />);

    await waitFor(() => {
      expect(mockRender).toHaveBeenCalledTimes(1);
    });

    // Switch to light theme
    mockIsLight.mockReturnValue(true);
    rerender(<MermaidDiagram code={code} />);

    await waitFor(() => {
      expect(mockRender).toHaveBeenCalledTimes(2);
    });
  });

  it('uses forceDark prop to override theme detection', async () => {
    mockIsLight.mockReturnValue(true); // Light theme active
    const code = 'graph TD\n  A --> B';
    render(<MermaidDiagram code={code} forceDark={true} />);

    await waitFor(() => {
      expect(mockRender).toHaveBeenCalled();
      // initializeMermaid should have been called with isDark=true
      expect(mockInitialize).toHaveBeenCalledWith(
        expect.objectContaining({ theme: 'dark' }),
      );
    });
  });
});

describe('MermaidDiagram - loading state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetMermaidCache();
    mockRender.mockResolvedValue({ svg: '<svg>diagram</svg>' });
  });

  afterEach(() => {
    _resetMermaidCache();
  });

  it('shows a loading skeleton while mermaid loads', () => {
    // With a cold cache, the loading skeleton should appear immediately
    render(<MermaidDiagram code="graph TD\n  A --> B" />);
    expect(screen.getByTestId('mermaid-loading')).toBeInTheDocument();
    expect(screen.getByText('Loading diagram...')).toBeInTheDocument();
  });

  it('resolves loading after mermaid loads', async () => {
    render(<MermaidDiagram code="graph TD\n  A --> B" />);

    // Initially shows loading
    expect(screen.getByTestId('mermaid-loading')).toBeInTheDocument();

    // After the dynamic import resolves, loading should disappear
    await waitFor(() => {
      expect(screen.queryByTestId('mermaid-loading')).not.toBeInTheDocument();
    });
  });
});

describe('initializeMermaid', () => {
  beforeEach(() => {
    mockInitialize.mockClear();
    _resetMermaidCache();
  });

  afterEach(() => {
    _resetMermaidCache();
  });

  it('initializes with dark theme when isDark is true and mermaid API is provided', () => {
    const mockApi = { initialize: mockInitialize } as unknown as
      (typeof import('mermaid'))['default'];
    initializeMermaid(true, mockApi);
    expect(mockInitialize).toHaveBeenCalledWith(
      expect.objectContaining({
        startOnLoad: false,
        theme: 'dark',
        securityLevel: 'strict',
      }),
    );
  });

  it('initializes with default theme when isDark is false and mermaid API is provided', () => {
    const mockApi = { initialize: mockInitialize } as unknown as
      (typeof import('mermaid'))['default'];
    initializeMermaid(false, mockApi);
    expect(mockInitialize).toHaveBeenCalledWith(
      expect.objectContaining({
        startOnLoad: false,
        theme: 'default',
        securityLevel: 'strict',
      }),
    );
  });

  it('is a no-op when no mermaid API provided and cache is empty', () => {
    initializeMermaid(true);
    expect(mockInitialize).not.toHaveBeenCalled();
  });
});

describe('sanitizeMermaidCode', () => {
  it('quotes square-bracket labels containing parentheses', () => {
    const input = 'graph TD\n  A[Deploy (30min downtime)] --> B[Done]';
    const result = sanitizeMermaidCode(input);
    expect(result).toContain('A["Deploy (30min downtime)"]');
    // B[Done] has no special chars, should remain unquoted
    expect(result).toContain('B[Done]');
  });

  it('quotes square-bracket labels containing braces', () => {
    const input = 'graph TD\n  A[Config {key: value}] --> B[Next]';
    const result = sanitizeMermaidCode(input);
    expect(result).toContain('A["Config {key: value}"]');
    expect(result).toContain('B[Next]');
  });

  it('quotes curly-brace labels containing parentheses', () => {
    const input = 'graph TD\n  A{Check (status)} --> B[Done]';
    const result = sanitizeMermaidCode(input);
    expect(result).toContain('A{"Check (status)"}');
  });

  it('quotes round-paren labels containing brackets', () => {
    const input = 'graph TD\n  A(Start [phase 1]) --> B[Done]';
    const result = sanitizeMermaidCode(input);
    expect(result).toContain('A("Start [phase 1]")');
  });

  it('does not modify already-quoted labels', () => {
    const input = 'graph TD\n  A["Deploy (30min)"] --> B["Config {x}"]';
    const result = sanitizeMermaidCode(input);
    expect(result).toBe(input);
  });

  it('handles multiple nodes with special characters on one line', () => {
    const input = 'graph TD\n  A[Step (1)] --> B[Step (2)]';
    const result = sanitizeMermaidCode(input);
    expect(result).toContain('A["Step (1)"]');
    expect(result).toContain('B["Step (2)"]');
  });

  it('passes through clean code unchanged', () => {
    const input = 'graph TD\n  A[Start] --> B[End]\n  B --> C[Done]';
    const result = sanitizeMermaidCode(input);
    expect(result).toBe(input);
  });

  it('passes through non-flowchart diagrams unchanged when no special chars', () => {
    const input = 'sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi';
    const result = sanitizeMermaidCode(input);
    expect(result).toBe(input);
  });
});
