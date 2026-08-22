import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { CommentMark } from './comment-extension';
import { SafeHighlight } from './article-extensions';

describe('CommentMark TipTap extension', () => {
  let editor: Editor;

  beforeEach(() => {
    editor = new Editor({
      extensions: [StarterKit, CommentMark],
      content: '<p>The quick brown fox jumps over the lazy dog.</p>',
    });
  });

  it('sets a comment mark on text selection', () => {
    // Select "brown fox" (from: 11, to: 20)
    editor.commands.setTextSelection({ from: 11, to: 20 });
    editor.commands.setComment({ commentId: 'c-101' });

    const html = editor.getHTML();
    expect(html).toContain('data-comment-id="c-101"');
    expect(html).toContain('class="comment-mark"');
    expect(html).toContain('brown fox');
  });

  it('unsets a comment mark', () => {
    editor.commands.setTextSelection({ from: 11, to: 20 });
    editor.commands.setComment({ commentId: 'c-101' });
    expect(editor.getHTML()).toContain('data-comment-id="c-101"');

    editor.commands.setTextSelection({ from: 11, to: 20 });
    editor.commands.unsetComment();
    expect(editor.getHTML()).not.toContain('data-comment-id="c-101"');
  });

  it('parses HTML with data-comment-id and data-comment-resolved', () => {
    const customEditor = new Editor({
      extensions: [StarterKit, CommentMark],
      content: '<p>Hello <mark data-comment-id="42" data-comment-resolved="true">world</mark>!</p>',
    });

    const mark = customEditor.state.doc.nodeAt(7)?.marks.find((m) => m.type.name === 'comment');
    expect(mark).toBeDefined();
    expect(mark?.attrs.commentId).toBe('42');
    expect(mark?.attrs.resolved).toBe(true);

    const rendered = customEditor.getHTML();
    expect(rendered).toContain('data-comment-id="42"');
    expect(rendered).toContain('data-comment-resolved="true"');
    expect(rendered).toContain('comment-resolved');
  });

  it('resolves comment mark across matching nodes', () => {
    editor.commands.setTextSelection({ from: 5, to: 10 });
    editor.commands.setComment({ commentId: 'c-202' });

    expect(editor.getHTML()).not.toContain('comment-resolved');

    editor.commands.resolveCommentMark({ commentId: 'c-202', resolved: true });

    const html = editor.getHTML();
    expect(html).toContain('data-comment-resolved="true"');
    expect(html).toContain('comment-resolved');

    editor.commands.resolveCommentMark({ commentId: 'c-202', resolved: false });
    expect(editor.getHTML()).not.toContain('comment-resolved');
  });

  it('unsets comment mark by commentId across matching nodes', () => {
    editor.commands.setTextSelection({ from: 5, to: 10 });
    editor.commands.setComment({ commentId: 'c-202' });
    expect(editor.getHTML()).toContain('data-comment-id="c-202"');

    // Move cursor somewhere else
    editor.commands.setTextSelection(1);
    editor.commands.unsetCommentMark({ commentId: 'c-202' });

    expect(editor.getHTML()).not.toContain('data-comment-id="c-202"');
  });

  it('is not inclusive so typing at the edge does not extend the comment mark', () => {
    editor.commands.setTextSelection({ from: 11, to: 16 }); // "brown"
    editor.commands.setComment({ commentId: 'c-303' });

    // Move cursor right after "brown" (pos: 16) and insert text
    editor.commands.setTextSelection(16);
    editor.commands.insertContent('ish');

    // "ish" should NOT carry the comment mark
    const markAtInserted = editor.state.doc.nodeAt(17)?.marks.find((m) => m.type.name === 'comment');
    expect(markAtInserted).toBeUndefined();
  });

  it('dispatches custom event on comment mark click', () => {
    const eventSpy = vi.fn();
    window.addEventListener('compendiq:comment-select', eventSpy);

    const onCommentClick = vi.fn();
    const customEditor = new Editor({
      extensions: [
        StarterKit,
        CommentMark.configure({ onCommentClick }),
      ],
      content: '<p>Text with <mark data-comment-id="thread-99">target comment</mark></p>',
    });

    const targetEl = customEditor.view.dom.querySelector('[data-comment-id="thread-99"]') as HTMLElement;
    expect(targetEl).not.toBeNull();

    // Create click event with targetEl as target
    const clickEvent = new MouseEvent('click', { bubbles: true });
    Object.defineProperty(clickEvent, 'target', { value: targetEl, enumerable: true });

    customEditor.view.someProp('handleClick', (f) => f(customEditor.view, 10, clickEvent));

    expect(eventSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ commentId: 'thread-99' }),
      }),
    );
    expect(onCommentClick).toHaveBeenCalledWith('thread-99', clickEvent);

    window.removeEventListener('compendiq:comment-open-sidebar', eventSpy);
    window.removeEventListener('compendiq:comment-select', eventSpy);
    customEditor.destroy();
  });

  it('preserves data-comment-id without converting to standard yellow highlight when Highlight extension is active', () => {
    const editorWithHighlight = new Editor({
      extensions: [
        StarterKit,
        CommentMark,
        SafeHighlight.configure({ multicolor: true }),
      ],
      content: '<p>Some <mark data-comment-id="note-123">noted text</mark> and normal <mark>highlighted text</mark></p>',
    });

    const html = editorWithHighlight.getHTML();
    // Must preserve data-comment-id and class="comment-mark" on the note
    expect(html).toContain('data-comment-id="note-123"');
    expect(html).toContain('class="comment-mark"');
    expect(html).toContain('noted text');

    // Re-parse the generated HTML into another editor to simulate page save and reload
    const reloadedEditor = new Editor({
      extensions: [
        StarterKit,
        CommentMark,
        SafeHighlight.configure({ multicolor: true }),
      ],
      content: html,
    });

    const reloadedHtml = reloadedEditor.getHTML();
    expect(reloadedHtml).toContain('data-comment-id="note-123"');
    expect(reloadedHtml).toContain('class="comment-mark"');

    editorWithHighlight.destroy();
    reloadedEditor.destroy();
  });
});
