import { Extension } from '@tiptap/core';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { closeHistory } from '@tiptap/pm/history';
import { isInTable } from '@tiptap/pm/tables';
import type {
  InlineCompletionRequest,
  InlineCompletionResponse,
} from '@compendiq/contracts';
import { apiFetch } from '../../lib/api';

const PREFIX_CONTEXT_CHARS = 3_200; // ~800 tokens
const SUFFIX_CONTEXT_CHARS = 800; // ~200 tokens

export const inlineCompletionPluginKey = new PluginKey<InlineCompletionPluginState>(
  'inlineCompletion',
);

export interface InlineCompletionPluginState {
  activeSuggestion: string | null;
  suggestionRange: { from: number; to: number } | null;
  loading: boolean;
  abortController: AbortController | null;
  completionAccepted: boolean;
}

type InlineCompletionMeta =
  | { type: 'loading'; at: number; controller: AbortController }
  | { type: 'suggestion'; at: number; completion: string }
  | { type: 'wordAccepted'; at: number; remaining: string }
  | { type: 'accepted' }
  | { type: 'clear' };

export interface InlineCompletionOptions {
  enabled: boolean | (() => boolean);
  delayMs: number | null | (() => number | null);
  codeOnly: boolean | (() => boolean);
  pageId?: number;
  spaceKey?: string;
  title?: string;
  language?: string;
  getMetadata?: () => Pick<
    InlineCompletionRequest,
    'pageId' | 'spaceKey' | 'title' | 'language'
  >;
  maxTokens: number;
  onSuggestionStateChange?: (active: boolean) => void;
  requestCompletion: (
    input: InlineCompletionRequest,
    signal: AbortSignal,
  ) => Promise<InlineCompletionResponse | undefined>;
  isCoarsePointer: () => boolean;
  isMac: () => boolean;
}

const EMPTY_STATE: InlineCompletionPluginState = {
  activeSuggestion: null,
  suggestionRange: null,
  loading: false,
  abortController: null,
  completionAccepted: false,
};

function completionState(state: EditorState): InlineCompletionPluginState {
  return inlineCompletionPluginKey.getState(state) ?? EMPTY_STATE;
}

function dispatchMeta(view: EditorView, meta: InlineCompletionMeta): void {
  view.dispatch(view.state.tr.setMeta(inlineCompletionPluginKey, meta));
}

function isCodeBlock(state: EditorState): boolean {
  return state.selection.$from.parent.type.name === 'codeBlock';
}

function valueOf<T>(value: T | (() => T)): T {
  return typeof value === 'function' ? (value as () => T)() : value;
}

function contextAtCursor(
  state: EditorState,
  options: InlineCompletionOptions,
): InlineCompletionRequest | null {
  const { selection, doc } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  const at = selection.from;
  const prefix = doc.textBetween(
    Math.max(0, at - PREFIX_CONTEXT_CHARS),
    at,
    '\n',
    '\n',
  );
  const suffix = doc.textBetween(
    at,
    Math.min(doc.content.size, at + SUFFIX_CONTEXT_CHARS),
    '\n',
    '\n',
  );
  if (!prefix.trim()) return null;

  const codeLanguage = isCodeBlock(state)
    ? (selection.$from.parent.attrs.language as string | null | undefined)
    : undefined;
  const metadata = options.getMetadata?.() ?? options;
  return {
    pageId: metadata.pageId,
    spaceKey: metadata.spaceKey,
    title: metadata.title,
    prefix,
    suffix: suffix || undefined,
    language: codeLanguage ?? metadata.language,
    maxTokens: options.maxTokens,
  };
}

function nextWord(completion: string): { accepted: string; remaining: string } {
  const match = /^(\s*\S+(?:\s+|$))/u.exec(completion);
  const accepted = match?.[1] ?? completion;
  return { accepted, remaining: completion.slice(accepted.length) };
}

function acceptSuggestion(view: EditorView, wordOnly: boolean): boolean {
  const pluginState = completionState(view.state);
  const suggestion = pluginState.activeSuggestion;
  const at = pluginState.suggestionRange?.from;
  if (!suggestion || at == null) return false;

  const part = wordOnly
    ? nextWord(suggestion)
    : { accepted: suggestion, remaining: '' };
  // Keep acceptance separate from the user's immediately preceding typing;
  // one Undo removes exactly the AI insertion, not the pause-triggering text.
  let tr: Transaction = closeHistory(view.state.tr).insertText(part.accepted, at);
  const nextAt = at + part.accepted.length;
  tr = tr
    .setSelection(TextSelection.create(tr.doc, nextAt))
    .setMeta('addToHistory', true)
    .setMeta(inlineCompletionPluginKey, part.remaining
      ? { type: 'wordAccepted', at: nextAt, remaining: part.remaining }
      : { type: 'accepted' });
  view.dispatch(tr);
  return true;
}

function isWordAccept(event: KeyboardEvent, options: InlineCompletionOptions): boolean {
  if (event.key !== ']') return false;
  return options.isMac() ? event.altKey : event.ctrlKey;
}

function isForceRequest(event: KeyboardEvent): boolean {
  return (event.altKey && event.key === '\\')
    || (event.metaKey && event.shiftKey && event.code === 'Space');
}

async function defaultRequest(
  input: InlineCompletionRequest,
  signal: AbortSignal,
): Promise<InlineCompletionResponse | undefined> {
  return apiFetch<InlineCompletionResponse | undefined>('/llm/inline-completion', {
    method: 'POST',
    body: JSON.stringify(input),
    signal,
  });
}

export const InlineCompletionExtension = Extension.create<InlineCompletionOptions>({
  name: 'inlineCompletion',

  addOptions() {
    return {
      enabled: false,
      delayMs: 500,
      codeOnly: false,
      maxTokens: 48,
      requestCompletion: defaultRequest,
      isCoarsePointer: () =>
        typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true,
      isMac: () =>
        typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform),
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    let triggerNow: (() => void) | null = null;
    let cancelPending: (() => void) | null = null;

    return [
      new Plugin<InlineCompletionPluginState>({
        key: inlineCompletionPluginKey,
        state: {
          init: () => EMPTY_STATE,
          apply(tr, state) {
            const meta = tr.getMeta(inlineCompletionPluginKey) as InlineCompletionMeta | undefined;
            if (meta?.type === 'loading') {
              return {
                activeSuggestion: null,
                suggestionRange: { from: meta.at, to: meta.at },
                loading: true,
                abortController: meta.controller,
                completionAccepted: false,
              };
            }
            if (meta?.type === 'suggestion') {
              return {
                activeSuggestion: meta.completion,
                suggestionRange: { from: meta.at, to: meta.at },
                loading: false,
                abortController: null,
                completionAccepted: false,
              };
            }
            if (meta?.type === 'wordAccepted') {
              return {
                activeSuggestion: meta.remaining,
                suggestionRange: { from: meta.at, to: meta.at },
                loading: false,
                abortController: null,
                completionAccepted: true,
              };
            }
            if (meta?.type === 'accepted') {
              return { ...EMPTY_STATE, completionAccepted: true };
            }
            if (meta?.type === 'clear') return EMPTY_STATE;
            if (tr.docChanged || tr.selectionSet) return EMPTY_STATE;
            return state;
          },
        },
        props: {
          decorations(state) {
            const pluginState = completionState(state);
            const at = pluginState.suggestionRange?.from;
            if (!pluginState.activeSuggestion || at == null) return DecorationSet.empty;
            return DecorationSet.create(state.doc, [
              Decoration.widget(
                at,
                () => {
                  const ghost = document.createElement('span');
                  ghost.className =
                    'cq-inline-completion-ghost pointer-events-none select-none text-muted-foreground/60';
                  ghost.textContent = pluginState.activeSuggestion;
                  ghost.setAttribute('aria-hidden', 'true');
                  ghost.setAttribute('data-testid', 'inline-completion-ghost');
                  return ghost;
                },
                {
                  side: 1,
                  key: 'inline-completion-ghost',
                  stopEvent: () => true,
                  ignoreMutation: () => true,
                },
              ),
            ]);
          },
          handleKeyDown(view, event) {
            if (view.composing) return false;
            const hasSuggestion = completionState(view.state).activeSuggestion != null;
            if (hasSuggestion && event.key === 'Tab' && !event.shiftKey) {
              event.preventDefault();
              event.stopPropagation();
              return acceptSuggestion(view, false);
            }
            if (hasSuggestion && isWordAccept(event, options)) {
              event.preventDefault();
              event.stopPropagation();
              return acceptSuggestion(view, true);
            }
            if (hasSuggestion && event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              cancelPending?.();
              return true;
            }
            if (isForceRequest(event)) {
              event.preventDefault();
              event.stopPropagation();
              triggerNow?.();
              return true;
            }
            return false;
          },
        },
        view(initialView) {
          let view = initialView;
          let timer: ReturnType<typeof setTimeout> | undefined;
          let destroyed = false;

          const cancelTimer = () => {
            if (timer) clearTimeout(timer);
            timer = undefined;
          };

          const clear = () => {
            cancelTimer();
            const state = completionState(view.state);
            if (state.activeSuggestion || state.loading || state.abortController) {
              dispatchMeta(view, { type: 'clear' });
            }
          };

          const request = async () => {
            cancelTimer();
            if (
              destroyed
              || !valueOf(options.enabled)
              || view.composing
              || isInTable(view.state)
              || options.isCoarsePointer()
              || (valueOf(options.codeOnly) && !isCodeBlock(view.state))
            ) {
              clear();
              return;
            }
            const input = contextAtCursor(view.state, options);
            if (!input) {
              clear();
              return;
            }
            const at = view.state.selection.from;
            const controller = new AbortController();
            dispatchMeta(view, { type: 'loading', at, controller });
            try {
              const response = await options.requestCompletion(input, controller.signal);
              if (destroyed || controller.signal.aborted) return;
              const current = completionState(view.state);
              if (current.abortController !== controller || view.state.selection.from !== at) return;
              let completion = response?.completion
                ?.replace(/\r/g, '')
                .split(/\n|```/, 1)[0] ?? '';
              // Providers often include the separator they infer between the
              // prefix and continuation. If the user already typed it, avoid
              // rendering/accepting a doubled space.
              if (/\s$/u.test(input.prefix)) completion = completion.replace(/^[\t ]+/u, '');
              dispatchMeta(view, completion
                ? { type: 'suggestion', at, completion }
                : { type: 'clear' });
            } catch (err) {
              if (!controller.signal.aborted && !destroyed) {
                dispatchMeta(view, { type: 'clear' });
              }
              // Inline completion is ambient assistance. Network/provider
              // failures stay silent and the user's normal editor remains.
              void err;
            }
          };

          const schedule = (force: boolean) => {
            clear();
            if (!valueOf(options.enabled) || options.isCoarsePointer()) return;
            if (isInTable(view.state)) return;
            if (valueOf(options.codeOnly) && !isCodeBlock(view.state)) return;
            const configuredDelay = valueOf(options.delayMs);
            if (!force && configuredDelay == null) return;
            const delay = force ? 0 : configuredDelay ?? 0;
            timer = setTimeout(() => void request(), delay);
          };

          triggerNow = () => schedule(true);
          cancelPending = clear;

          return {
            update(nextView, prevState) {
              view = nextView;
              const previous = completionState(prevState);
              const current = completionState(nextView.state);
              if (
                previous.abortController
                && previous.abortController !== current.abortController
              ) {
                previous.abortController.abort();
              }
              if (!!previous.activeSuggestion !== !!current.activeSuggestion) {
                options.onSuggestionStateChange?.(!!current.activeSuggestion);
              }
              if (current.completionAccepted) return;
              if (!prevState.doc.eq(nextView.state.doc) || !prevState.selection.eq(nextView.state.selection)) {
                schedule(false);
              }
            },
            destroy() {
              destroyed = true;
              cancelTimer();
              completionState(view.state).abortController?.abort();
              options.onSuggestionStateChange?.(false);
              triggerNow = null;
              cancelPending = null;
            },
          };
        },
      }),
    ];
  },
});
