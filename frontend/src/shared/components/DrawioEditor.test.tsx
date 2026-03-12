import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { DrawioEditor, DRAWIO_ORIGIN } from './DrawioEditor';

describe('DrawioEditor', () => {
  const defaultXml = '<mxGraphModel><root></root></mxGraphModel>';
  const defaultOnSave = vi.fn().mockResolvedValue(undefined);
  const defaultOnClose = vi.fn();

  // Helper to simulate postMessage from the draw.io iframe
  function postFromDrawio(data: Record<string, unknown>) {
    const event = new MessageEvent('message', {
      origin: DRAWIO_ORIGIN,
      data: JSON.stringify(data),
    });
    window.dispatchEvent(event);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // Mock window.confirm for unsaved changes dialog
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the overlay and iframe', () => {
    render(
      <DrawioEditor xml={defaultXml} onSave={defaultOnSave} onClose={defaultOnClose} />,
    );

    expect(screen.getByTestId('drawio-editor-overlay')).toBeTruthy();
    expect(screen.getByTestId('drawio-iframe')).toBeTruthy();
  });

  it('shows loading spinner initially', () => {
    render(
      <DrawioEditor xml={defaultXml} onSave={defaultOnSave} onClose={defaultOnClose} />,
    );

    expect(screen.getByTestId('drawio-loading')).toBeTruthy();
  });

  it('sends load action with XML when iframe sends init event', async () => {
    const postMessageSpy = vi.fn();
    render(
      <DrawioEditor xml={defaultXml} onSave={defaultOnSave} onClose={defaultOnClose} />,
    );

    // Mock the iframe's contentWindow.postMessage
    const iframe = screen.getByTestId('drawio-iframe') as HTMLIFrameElement;
    Object.defineProperty(iframe, 'contentWindow', {
      value: { postMessage: postMessageSpy },
      writable: true,
    });

    await act(async () => {
      postFromDrawio({ event: 'init' });
    });

    expect(postMessageSpy).toHaveBeenCalledWith(
      JSON.stringify({ action: 'load', xml: defaultXml }),
      DRAWIO_ORIGIN,
    );
  });

  it('hides loading spinner after init event', async () => {
    render(
      <DrawioEditor xml={defaultXml} onSave={defaultOnSave} onClose={defaultOnClose} />,
    );

    // Stub iframe contentWindow
    const iframe = screen.getByTestId('drawio-iframe') as HTMLIFrameElement;
    Object.defineProperty(iframe, 'contentWindow', {
      value: { postMessage: vi.fn() },
      writable: true,
    });

    await act(async () => {
      postFromDrawio({ event: 'init' });
    });

    expect(screen.queryByTestId('drawio-loading')).toBeNull();
  });

  it('requests PNG export when save event is received', async () => {
    const postMessageSpy = vi.fn();
    render(
      <DrawioEditor xml={defaultXml} onSave={defaultOnSave} onClose={defaultOnClose} />,
    );

    const iframe = screen.getByTestId('drawio-iframe') as HTMLIFrameElement;
    Object.defineProperty(iframe, 'contentWindow', {
      value: { postMessage: postMessageSpy },
      writable: true,
    });

    const updatedXml = '<mxGraphModel><root><updated/></root></mxGraphModel>';

    await act(async () => {
      postFromDrawio({ event: 'init' });
    });

    postMessageSpy.mockClear();

    await act(async () => {
      postFromDrawio({ event: 'save', xml: updatedXml });
    });

    expect(postMessageSpy).toHaveBeenCalledWith(
      expect.stringContaining('"action":"export"'),
      DRAWIO_ORIGIN,
    );

    const exportMsg = JSON.parse(postMessageSpy.mock.calls[0][0]);
    expect(exportMsg.format).toBe('xmlpng');
    expect(exportMsg.xml).toBe(updatedXml);
  });

  it('calls onSave with data URI and XML when export event is received', async () => {
    const postMessageSpy = vi.fn();
    render(
      <DrawioEditor xml={defaultXml} onSave={defaultOnSave} onClose={defaultOnClose} />,
    );

    const iframe = screen.getByTestId('drawio-iframe') as HTMLIFrameElement;
    Object.defineProperty(iframe, 'contentWindow', {
      value: { postMessage: postMessageSpy },
      writable: true,
    });

    const updatedXml = '<mxGraphModel><root><saved/></root></mxGraphModel>';
    const dataUri = 'data:image/png;base64,iVBORw0KGgo...';

    // Init -> Save -> Export sequence
    await act(async () => {
      postFromDrawio({ event: 'init' });
    });
    await act(async () => {
      postFromDrawio({ event: 'save', xml: updatedXml });
    });
    await act(async () => {
      postFromDrawio({ event: 'export', data: dataUri });
    });

    await waitFor(() => {
      expect(defaultOnSave).toHaveBeenCalledWith(dataUri, updatedXml);
    });
  });

  it('sends exit action after onSave completes', async () => {
    const postMessageSpy = vi.fn();
    render(
      <DrawioEditor xml={defaultXml} onSave={defaultOnSave} onClose={defaultOnClose} />,
    );

    const iframe = screen.getByTestId('drawio-iframe') as HTMLIFrameElement;
    Object.defineProperty(iframe, 'contentWindow', {
      value: { postMessage: postMessageSpy },
      writable: true,
    });

    await act(async () => {
      postFromDrawio({ event: 'init' });
    });
    await act(async () => {
      postFromDrawio({ event: 'save', xml: defaultXml });
    });
    await act(async () => {
      postFromDrawio({ event: 'export', data: 'data:image/png;base64,abc' });
    });

    await waitFor(() => {
      const calls = postMessageSpy.mock.calls.map(([msg]: [string]) => JSON.parse(msg));
      const exitCall = calls.find((c: Record<string, unknown>) => c.action === 'exit');
      expect(exitCall).toBeTruthy();
    });
  });

  it('calls onClose when exit event is received from iframe', async () => {
    render(
      <DrawioEditor xml={defaultXml} onSave={defaultOnSave} onClose={defaultOnClose} />,
    );

    await act(async () => {
      postFromDrawio({ event: 'exit' });
    });

    expect(defaultOnClose).toHaveBeenCalled();
  });

  it('ignores messages from non-drawio origins', async () => {
    const postMessageSpy = vi.fn();
    render(
      <DrawioEditor xml={defaultXml} onSave={defaultOnSave} onClose={defaultOnClose} />,
    );

    const iframe = screen.getByTestId('drawio-iframe') as HTMLIFrameElement;
    Object.defineProperty(iframe, 'contentWindow', {
      value: { postMessage: postMessageSpy },
      writable: true,
    });

    // Message from wrong origin
    const event = new MessageEvent('message', {
      origin: 'https://evil.example.com',
      data: JSON.stringify({ event: 'init' }),
    });
    window.dispatchEvent(event);

    // Should NOT have sent a load message
    expect(postMessageSpy).not.toHaveBeenCalled();
    // Loading spinner should still be visible
    expect(screen.getByTestId('drawio-loading')).toBeTruthy();
  });

  it('ignores malformed message data', async () => {
    render(
      <DrawioEditor xml={defaultXml} onSave={defaultOnSave} onClose={defaultOnClose} />,
    );

    // Send non-JSON data from correct origin
    const event = new MessageEvent('message', {
      origin: DRAWIO_ORIGIN,
      data: 'not-json',
    });

    // Should not throw
    expect(() => window.dispatchEvent(event)).not.toThrow();
    expect(screen.getByTestId('drawio-loading')).toBeTruthy();
  });

  it('calls onClose on Escape key when no unsaved changes', async () => {
    render(
      <DrawioEditor xml={defaultXml} onSave={defaultOnSave} onClose={defaultOnClose} />,
    );

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(defaultOnClose).toHaveBeenCalled();
    // Should not show confirm dialog when no unsaved changes
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it('shows confirm dialog on Escape key when there are unsaved changes', async () => {
    const postMessageSpy = vi.fn();
    render(
      <DrawioEditor xml={defaultXml} onSave={defaultOnSave} onClose={defaultOnClose} />,
    );

    const iframe = screen.getByTestId('drawio-iframe') as HTMLIFrameElement;
    Object.defineProperty(iframe, 'contentWindow', {
      value: { postMessage: postMessageSpy },
      writable: true,
    });

    // Trigger autosave event to mark unsaved changes
    await act(async () => {
      postFromDrawio({ event: 'init' });
    });
    await act(async () => {
      postFromDrawio({ event: 'autosave' });
    });

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining('unsaved changes'),
    );
  });

  it('does not close when confirm is cancelled on Escape with unsaved changes', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    const postMessageSpy = vi.fn();
    render(
      <DrawioEditor xml={defaultXml} onSave={defaultOnSave} onClose={defaultOnClose} />,
    );

    const iframe = screen.getByTestId('drawio-iframe') as HTMLIFrameElement;
    Object.defineProperty(iframe, 'contentWindow', {
      value: { postMessage: postMessageSpy },
      writable: true,
    });

    await act(async () => {
      postFromDrawio({ event: 'init' });
    });
    await act(async () => {
      postFromDrawio({ event: 'autosave' });
    });

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(defaultOnClose).not.toHaveBeenCalled();
  });

  it('renders iframe with correct src URL', () => {
    render(
      <DrawioEditor xml={defaultXml} onSave={defaultOnSave} onClose={defaultOnClose} />,
    );

    const iframe = screen.getByTestId('drawio-iframe') as HTMLIFrameElement;
    expect(iframe.src).toContain('embed.diagrams.net');
    expect(iframe.src).toContain('embed=1');
    expect(iframe.src).toContain('proto=json');
  });
});
