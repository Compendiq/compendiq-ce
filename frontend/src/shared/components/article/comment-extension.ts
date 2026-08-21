import { Mark, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { cn } from '../../lib/cn';

export interface CommentMarkAttributes {
  commentId: string | number;
  resolved?: boolean;
}

export interface CommentExtensionOptions {
  HTMLAttributes: Record<string, unknown>;
  onCommentClick?: (commentId: string, event: MouseEvent) => void;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    comment: {
      /**
       * Set a comment mark on the selected range.
       */
      setComment: (attributes: CommentMarkAttributes) => ReturnType;
      /**
       * Remove comment mark from the current range.
       */
      unsetComment: () => ReturnType;
      /**
       * Toggle comment mark.
       */
      toggleComment: (attributes: CommentMarkAttributes) => ReturnType;
      /**
       * Update resolved state for all comment marks matching commentId in the document.
       */
      resolveCommentMark: (options: { commentId: string | number; resolved: boolean }) => ReturnType;
    };
  }
}

export const commentPluginKey = new PluginKey('commentClick');

/**
 * TipTap Comment Mark Extension (#1408)
 *
 * Annotates inline text selections with persistent comment anchors.
 * Tracks commentId and resolved status across edits, document splits,
 * and undo/redo operations.
 */
export const CommentMark = Mark.create<CommentExtensionOptions>({
  name: 'comment',

  addOptions() {
    return {
      HTMLAttributes: {},
      onCommentClick: undefined,
    };
  },

  inclusive: false,
  excludes: '',

  addAttributes() {
    return {
      commentId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-comment-id'),
        renderHTML: (attributes: Record<string, unknown>) => {
          if (!attributes.commentId) return {};
          return {
            'data-comment-id': String(attributes.commentId),
          };
        },
      },
      resolved: {
        default: false,
        parseHTML: (element) => element.getAttribute('data-comment-resolved') === 'true',
        renderHTML: (attributes: Record<string, unknown>) => {
          if (!attributes.resolved) return {};
          return {
            'data-comment-resolved': 'true',
          };
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'mark[data-comment-id]',
      },
      {
        tag: 'span[data-comment-id]',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    const isResolved = HTMLAttributes['data-comment-resolved'] === 'true';
    return [
      'mark',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        class: cn('comment-mark', isResolved && 'comment-resolved'),
      }),
      0,
    ];
  },

  addCommands() {
    return {
      setComment:
        (attributes) =>
        ({ commands }) => {
          return commands.setMark(this.name, attributes);
        },
      unsetComment:
        () =>
        ({ commands }) => {
          return commands.unsetMark(this.name);
        },
      toggleComment:
        (attributes) =>
        ({ commands }) => {
          return commands.toggleMark(this.name, attributes);
        },
      resolveCommentMark:
        ({ commentId, resolved }) =>
        ({ tr, state, dispatch }) => {
          const targetId = String(commentId);
          let found = false;
          state.doc.descendants((node, pos) => {
            if (!node.isText) return;
            node.marks.forEach((mark) => {
              if (mark.type.name === 'comment' && String(mark.attrs.commentId) === targetId) {
                found = true;
                if (dispatch) {
                  const newMark = mark.type.create({
                    ...mark.attrs,
                    resolved,
                  });
                  tr.removeMark(pos, pos + node.nodeSize, mark.type);
                  tr.addMark(pos, pos + node.nodeSize, newMark);
                }
              }
            });
          });
          return found;
        },
    };
  },

  addProseMirrorPlugins() {
    const onCommentClick = this.options.onCommentClick;
    return [
      new Plugin({
        key: commentPluginKey,
        props: {
          handleClick: (_view, _pos, event) => {
            const target = event.target as HTMLElement | null;
            const commentEl = target?.closest('[data-comment-id]');
            if (!commentEl) return false;
            const commentId = commentEl.getAttribute('data-comment-id');
            if (commentId) {
              if (onCommentClick) {
                onCommentClick(commentId, event);
              }
              // Dispatch global custom event for bidirectional sidebar navigation
              if (typeof window !== 'undefined') {
                window.dispatchEvent(
                  new CustomEvent('compendiq:comment-select', {
                    detail: { commentId },
                  }),
                );
              }
              return true;
            }
            return false;
          },
        },
      }),
    ];
  },
});
