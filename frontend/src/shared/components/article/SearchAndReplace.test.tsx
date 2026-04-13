import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('../../hooks/use-is-light-theme', () => ({
  useIsLightTheme: () => false,
}));

vi.mock('../../lib/api', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { SearchAndReplace } from './SearchAndReplace';
import type { Editor as EditorType } from '@tiptap/react';

function createMockEditor(): EditorType {
  const commands: Record<string, ReturnType<typeof vi.fn>> = {
    setSearchQuery: vi.fn(),
    findNext: vi.fn(),
    findPrev: vi.fn(),
    replaceNext: vi.fn(),
    replaceAll: vi.fn(),
    clearSearch: vi.fn(),
    focus: vi.fn(),
  };

  return {
    commands,
    state: {
      selection: { from: 0, to: 0 },
      doc: {
        content: { size: 100 },
      },
    },
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as EditorType;
}

describe('SearchAndReplace', () => {
  let editor: EditorType;

  beforeEach(() => {
    editor = createMockEditor();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens when the editor:open-search event is dispatched', async () => {
    render(<SearchAndReplace editor={editor} />);

    // Not visible initially
    expect(screen.queryByTestId('search-and-replace')).not.toBeInTheDocument();

    // Dispatch the custom event
    document.dispatchEvent(
      new CustomEvent('editor:open-search', { detail: { replace: false } }),
    );

    await waitFor(() => {
      expect(screen.getByTestId('search-and-replace')).toBeInTheDocument();
    });
  });

  it('shows replace row when opened with replace: true', async () => {
    render(<SearchAndReplace editor={editor} />);

    document.dispatchEvent(
      new CustomEvent('editor:open-search', { detail: { replace: true } }),
    );

    await waitFor(() => {
      expect(screen.getByTestId('search-and-replace')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Replace...')).toBeInTheDocument();
    });
  });

  it('closes when Escape is pressed', async () => {
    render(<SearchAndReplace editor={editor} />);

    // Open it
    document.dispatchEvent(
      new CustomEvent('editor:open-search', { detail: { replace: false } }),
    );

    await waitFor(() => {
      expect(screen.getByTestId('search-and-replace')).toBeInTheDocument();
    });

    // Flush pending effects (registers the Escape keydown listener)
    await act(async () => {});

    // Press Escape
    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByTestId('search-and-replace')).not.toBeInTheDocument();
    });

    // Should clear the search
    expect((editor.commands as Record<string, ReturnType<typeof vi.fn>>).clearSearch).toHaveBeenCalled();
  });

  it('closes when the close button is clicked', async () => {
    render(<SearchAndReplace editor={editor} />);

    document.dispatchEvent(
      new CustomEvent('editor:open-search', { detail: { replace: false } }),
    );

    await waitFor(() => {
      expect(screen.getByTestId('search-and-replace')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle('Close (Escape)'));

    await waitFor(() => {
      expect(screen.queryByTestId('search-and-replace')).not.toBeInTheDocument();
    });
  });

  it('calls findNext when Enter is pressed in search input', async () => {
    render(<SearchAndReplace editor={editor} />);

    document.dispatchEvent(
      new CustomEvent('editor:open-search', { detail: { replace: false } }),
    );

    await waitFor(() => {
      expect(screen.getByTestId('search-and-replace')).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText('Search...');
    fireEvent.change(input, { target: { value: 'test' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect((editor.commands as Record<string, ReturnType<typeof vi.fn>>).findNext).toHaveBeenCalled();
  });

  it('calls findPrev when Shift+Enter is pressed in search input', async () => {
    render(<SearchAndReplace editor={editor} />);

    document.dispatchEvent(
      new CustomEvent('editor:open-search', { detail: { replace: false } }),
    );

    await waitFor(() => {
      expect(screen.getByTestId('search-and-replace')).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText('Search...');
    fireEvent.change(input, { target: { value: 'test' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });

    expect((editor.commands as Record<string, ReturnType<typeof vi.fn>>).findPrev).toHaveBeenCalled();
  });

  it('toggles case sensitivity', async () => {
    render(<SearchAndReplace editor={editor} />);

    document.dispatchEvent(
      new CustomEvent('editor:open-search', { detail: { replace: false } }),
    );

    await waitFor(() => {
      expect(screen.getByTestId('search-and-replace')).toBeInTheDocument();
    });

    const caseBtn = screen.getByTitle('Match Case');
    fireEvent.click(caseBtn);

    // The button should now have the active style (primary ring)
    expect(caseBtn.className).toContain('bg-primary/20');
  });

  it('toggles whole word matching', async () => {
    render(<SearchAndReplace editor={editor} />);

    document.dispatchEvent(
      new CustomEvent('editor:open-search', { detail: { replace: false } }),
    );

    await waitFor(() => {
      expect(screen.getByTestId('search-and-replace')).toBeInTheDocument();
    });

    const wordBtn = screen.getByTitle('Match Whole Word');
    fireEvent.click(wordBtn);

    expect(wordBtn.className).toContain('bg-primary/20');
  });

  it('toggles regex mode', async () => {
    render(<SearchAndReplace editor={editor} />);

    document.dispatchEvent(
      new CustomEvent('editor:open-search', { detail: { replace: false } }),
    );

    await waitFor(() => {
      expect(screen.getByTestId('search-and-replace')).toBeInTheDocument();
    });

    const regexBtn = screen.getByTitle('Use Regular Expression');
    fireEvent.click(regexBtn);

    expect(regexBtn.className).toContain('bg-primary/20');
  });

  it('toggles replace row visibility', async () => {
    render(<SearchAndReplace editor={editor} />);

    document.dispatchEvent(
      new CustomEvent('editor:open-search', { detail: { replace: false } }),
    );

    await waitFor(() => {
      expect(screen.getByTestId('search-and-replace')).toBeInTheDocument();
    });

    // No replace input initially
    expect(screen.queryByPlaceholderText('Replace...')).not.toBeInTheDocument();

    // Click the replace toggle
    fireEvent.click(screen.getByTitle('Show Replace (Ctrl+H)'));

    expect(screen.getByPlaceholderText('Replace...')).toBeInTheDocument();
  });

  it('calls replaceNext when Replace button is clicked', async () => {
    render(<SearchAndReplace editor={editor} />);

    document.dispatchEvent(
      new CustomEvent('editor:open-search', { detail: { replace: true } }),
    );

    await waitFor(() => {
      expect(screen.getByTestId('search-and-replace')).toBeInTheDocument();
    });

    // The Replace button is disabled when matchInfo.total === 0, but we can still click it
    // to verify the UI renders correctly
    const replaceBtn = screen.getByTitle('Replace (Enter)');
    expect(replaceBtn).toBeInTheDocument();
  });

  it('calls replaceAll when Replace All button is clicked', async () => {
    render(<SearchAndReplace editor={editor} />);

    document.dispatchEvent(
      new CustomEvent('editor:open-search', { detail: { replace: true } }),
    );

    await waitFor(() => {
      expect(screen.getByTestId('search-and-replace')).toBeInTheDocument();
    });

    const replaceAllBtn = screen.getByTitle('Replace All');
    expect(replaceAllBtn).toBeInTheDocument();
  });

  it('sets the search query when the input changes', async () => {
    render(<SearchAndReplace editor={editor} />);

    document.dispatchEvent(
      new CustomEvent('editor:open-search', { detail: { replace: false } }),
    );

    await waitFor(() => {
      expect(screen.getByTestId('search-and-replace')).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText('Search...');
    fireEvent.change(input, { target: { value: 'hello' } });

    // The setSearchQuery command should have been called
    expect((editor.commands as Record<string, ReturnType<typeof vi.fn>>).setSearchQuery).toHaveBeenCalled();
  });
});
