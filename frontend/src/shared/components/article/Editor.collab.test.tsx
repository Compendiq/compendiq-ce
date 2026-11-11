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

  it('keeps server-applied image markers through a local edit and stays editable (#1764)', async () => {
    // The room's document: a paragraph and a pasted image without markers.
    const server = new Y.Doc();
    const paragraph = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, 'image');
    paragraph.insert(0, [text]);
    const image = new Y.XmlElement('image');
    image.setAttribute('src', '/api/attachments/local-src/x.png');
    server.getXmlFragment('default').insert(0, [paragraph, image]);
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(server), 'provider');
    let editor: EditorType | null = null;
    render(
      <Editor
        ydoc={ydoc}
        collabProvider={stubProvider(ydoc)}
        caretUser={{ name: 'Ada', color: '#5C6B8A' }}
        editable
        onEditorReady={(e) => {
          editor = e;
        }}
      />,
    );
    await waitFor(() => {
      expect(editor?.getHTML()).toContain('/api/attachments/local-src/x.png');
    });

    // A Save marks the uploaded image in place on the server; the editor receives that update.
    const known = Y.encodeStateVector(ydoc);
    server.transact(() => {
      image.setAttribute('data-confluence-filename', 'x.png');
      image.setAttribute('data-confluence-image-source', 'attachment');
    });
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(server, known), 'provider');
    await waitFor(() => {
      expect(editor!.getHTML()).toContain('data-confluence-filename="x.png"');
    });
    expect(editor!.getHTML()).toContain('data-confluence-image-source="attachment"');
    expect(editor!.isEditable).toBe(true);

    // The next local edit must not strip them from the shared document.
    editor!.commands.insertContentAt(editor!.state.doc.content.size, '<p>LOCAL_EDIT</p>');
    await waitFor(() => {
      expect(editor!.getHTML()).toContain('LOCAL_EDIT');
    });
    const sharedImage = ydoc.getXmlFragment('default').toArray()
      .find((node): node is Y.XmlElement => node instanceof Y.XmlElement && node.nodeName === 'image');
    expect(sharedImage?.getAttributes()).toEqual({
      src: '/api/attachments/local-src/x.png',
      'data-confluence-filename': 'x.png',
      'data-confluence-image-source': 'attachment',
    });
  });
});
