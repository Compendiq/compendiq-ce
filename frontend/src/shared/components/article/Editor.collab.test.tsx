import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import type { WebsocketProvider } from 'y-websocket';

vi.mock('../hooks/use-is-light-theme', () => ({
  useIsLightTheme: () => false,
}));

vi.mock('../../lib/api', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('../../hooks/use-authenticated-src', () => ({
  fetchAuthenticatedBlob: vi.fn().mockResolvedValue(null),
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    loading: vi.fn(() => 'toast-id-1'),
    dismiss: vi.fn(),
  },
}));

import { Editor } from './Editor';
import type { Editor as EditorType } from '@tiptap/react';
import { useUiStore } from '../../../stores/ui-store';

function stubProvider(ydoc: Y.Doc): WebsocketProvider {
  const awareness = new Awareness(ydoc);
  return { awareness } as unknown as WebsocketProvider;
}

function extensionNames(editor: EditorType): string[] {
  return editor.extensionManager.extensions.map((ext) => ext.name);
}

describe('Editor collaboration wiring', () => {
  beforeEach(() => {
    useUiStore.setState({ vimModeEnabled: false });
  });

  it('does not mount Collaboration when ydoc is omitted (flag off)', async () => {
    let editor: EditorType | null = null;
    render(
      <Editor
        content="<p>seed</p>"
        editable
        onEditorReady={(e) => {
          editor = e;
        }}
      />,
    );

    await waitFor(() => {
      expect(editor).not.toBeNull();
    });

    const names = extensionNames(editor!);
    expect(names).not.toContain('collaboration');
    expect(names).not.toContain('collaborationCaret');
    expect(names).toContain('undoRedo');
  });

  it('mounts Collaboration + CollaborationCaret and disables StarterKit undoRedo when ydoc is set', async () => {
    const ydoc = new Y.Doc();
    const provider = stubProvider(ydoc);
    let editor: EditorType | null = null;

    render(
      <Editor
        ydoc={ydoc}
        collabProvider={provider}
        caretUser={{ name: 'Ada', color: '#5C6B8A' }}
        editable
        onEditorReady={(e) => {
          editor = e;
        }}
      />,
    );

    await waitFor(() => {
      expect(editor).not.toBeNull();
    });

    const names = extensionNames(editor!);
    expect(names).toContain('collaboration');
    expect(names).toContain('collaborationCaret');
    expect(names).not.toContain('undoRedo');

    const collaboration = editor!.extensionManager.extensions.find((ext) => ext.name === 'collaboration');
    expect(collaboration?.options).toMatchObject({ document: ydoc, field: 'default' });

    const caret = editor!.extensionManager.extensions.find((ext) => ext.name === 'collaborationCaret');
    expect(caret?.options.provider).toBe(provider);
    expect(caret?.options.user).toMatchObject({ name: 'Ada', color: '#5C6B8A' });
  });
});
