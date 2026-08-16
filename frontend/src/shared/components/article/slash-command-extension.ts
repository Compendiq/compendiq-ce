import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState } from '@tiptap/pm/state';

export interface SlashCommandState {
  isOpen: boolean;
  query: string;
  range: { from: number; to: number } | null;
  version: number;
}

export const slashCommandPluginKey = new PluginKey<SlashCommandState>('slashCommand');

const SLASH_REGEX = /(?:^|\s)\/([a-zA-Z0-9_-]*)$/;

export function getSlashMatch(
  state: EditorState,
): { query: string; range: { from: number; to: number } } | null {
  const { selection } = state;
  if (!selection.empty) return null;

  const { $from } = selection;
  const parent = $from.parent;

  // Only trigger inside standard editable textblocks (skip code blocks, diagrams, etc.)
  if (!parent.isTextblock) return null;
  const parentType = parent.type.name;
  if (
    parentType === 'codeBlock' ||
    parentType === 'mermaidBlock' ||
    parentType === 'drawioDiagram'
  ) {
    return null;
  }

  // Get text in current textblock before the caret
  const textBefore = parent.textBetween(0, $from.parentOffset, undefined, '\ufffc');
  const match = SLASH_REGEX.exec(textBefore);
  if (!match) return null;

  const query = match[1] ?? '';
  const matchStr = match[0];
  const slashOffsetInParent = textBefore.length - matchStr.length + (matchStr.startsWith(' ') ? 1 : 0);
  const slashPos = $from.start() + slashOffsetInParent;

  return {
    query,
    range: {
      from: slashPos,
      to: $from.pos,
    },
  };
}

export type SlashKeyHandler = (event: KeyboardEvent) => boolean;

let activeSlashKeyHandler: SlashKeyHandler | null = null;

export function registerSlashKeyHandler(handler: SlashKeyHandler): () => void {
  activeSlashKeyHandler = handler;
  return () => {
    if (activeSlashKeyHandler === handler) {
      activeSlashKeyHandler = null;
    }
  };
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    slashCommand: {
      /**
       * Dismiss the slash command menu.
       */
      closeSlashCommand: () => ReturnType;
    };
  }
}

export const SlashCommandExtension = Extension.create({
  name: 'slashCommand',

  addCommands() {
    return {
      closeSlashCommand:
        () =>
        ({ tr, dispatch }) => {
          if (dispatch) {
            tr.setMeta(slashCommandPluginKey, { close: true });
          }
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<SlashCommandState>({
        key: slashCommandPluginKey,

        state: {
          init(): SlashCommandState {
            return {
              isOpen: false,
              query: '',
              range: null,
              version: 0,
            };
          },

          apply(tr, prevState, _oldState, newState): SlashCommandState {
            const meta = tr.getMeta(slashCommandPluginKey) as { close?: boolean } | undefined;
            if (meta?.close) {
              return {
                isOpen: false,
                query: '',
                range: null,
                version: prevState.version + 1,
              };
            }

            const match = getSlashMatch(newState);
            if (!match) {
              if (prevState.isOpen) {
                return {
                  isOpen: false,
                  query: '',
                  range: null,
                  version: prevState.version + 1,
                };
              }
              return prevState;
            }

            const hasChanged =
              !prevState.isOpen ||
              prevState.query !== match.query ||
              prevState.range?.from !== match.range.from ||
              prevState.range?.to !== match.range.to;

            return {
              isOpen: true,
              query: match.query,
              range: match.range,
              version: hasChanged ? prevState.version + 1 : prevState.version,
            };
          },
        },

        props: {
          handleKeyDown(view, event) {
            const pluginState = slashCommandPluginKey.getState(view.state);
            if (!pluginState?.isOpen) return false;

            if (activeSlashKeyHandler) {
              const handled = activeSlashKeyHandler(event);
              if (handled) return true;
            }

            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              view.dispatch(view.state.tr.setMeta(slashCommandPluginKey, { close: true }));
              return true;
            }

            return false;
          },
        },
      }),
    ];
  },
});
