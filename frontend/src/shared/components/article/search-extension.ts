import { Extension } from '@tiptap/core';
import {
  search as searchPlugin,
  SearchQuery,
  getSearchState,
  setSearchState,
  findNext,
  findPrev,
  replaceNext,
  replaceAll,
} from 'prosemirror-search';

export { SearchQuery, getSearchState };

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    searchAndReplace: {
      /**
       * Set the search query to find and highlight matches.
       */
      setSearchQuery: (query: SearchQuery) => ReturnType;
      /**
       * Move to the next search match.
       */
      findNext: () => ReturnType;
      /**
       * Move to the previous search match.
       */
      findPrev: () => ReturnType;
      /**
       * Replace the current match and move to the next one.
       */
      replaceNext: () => ReturnType;
      /**
       * Replace all matches.
       */
      replaceAll: () => ReturnType;
      /**
       * Clear the search query and highlights.
       */
      clearSearch: () => ReturnType;
    };
  }
}

export const SearchAndReplaceExtension = Extension.create({
  name: 'searchAndReplace',

  addProseMirrorPlugins() {
    return [searchPlugin()];
  },

  addCommands() {
    return {
      setSearchQuery:
        (query: SearchQuery) =>
        ({ tr, dispatch }) => {
          if (dispatch) {
            dispatch(setSearchState(tr, query));
          }
          return true;
        },

      findNext:
        () =>
        ({ state, dispatch }) => {
          return findNext(state, dispatch);
        },

      findPrev:
        () =>
        ({ state, dispatch }) => {
          return findPrev(state, dispatch);
        },

      replaceNext:
        () =>
        ({ state, dispatch }) => {
          return replaceNext(state, dispatch);
        },

      replaceAll:
        () =>
        ({ state, dispatch }) => {
          return replaceAll(state, dispatch);
        },

      clearSearch:
        () =>
        ({ tr, dispatch }) => {
          if (dispatch) {
            dispatch(setSearchState(tr, new SearchQuery({ search: '' })));
          }
          return true;
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      'Mod-f': () => {
        // Emit a custom event that the UI component listens for
        document.dispatchEvent(new CustomEvent('editor:open-search', { detail: { replace: false } }));
        return true;
      },
      'Mod-h': () => {
        document.dispatchEvent(new CustomEvent('editor:open-search', { detail: { replace: true } }));
        return true;
      },
    };
  },
});
