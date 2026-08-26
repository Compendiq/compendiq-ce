import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { apiFetchBlob } from '../../lib/api';
import type { SpellLang } from '../../lib/spellcheck/spellcheck-engine';

export const spellcheckPluginKey = new PluginKey<SpellcheckState>('spellcheck');

export interface SpellcheckState {
  decorations: DecorationSet;
}

export type SpellcheckDictionary = { lang: SpellLang; aff: string; dic: string };

export interface SpellcheckOptions {
  enabled: boolean | (() => boolean);
  languages: SpellLang[] | (() => SpellLang[]);
  createWorker?: () => Worker;
  fetchDictionaries?: (langs: SpellLang[]) => Promise<SpellcheckDictionary[]>;
  onStatus?: (status: 'ready' | 'failed') => void;
}

type MissRange = { from: number; to: number; word: string };

function valueOf<T>(value: T | (() => T)): T {
  return typeof value === 'function' ? (value as () => T)() : value;
}

export function collectSpellcheckChunks(doc: PMNode): Array<{ text: string; base: number }> {
  const chunks: Array<{ text: string; base: number }> = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'codeBlock') return false;
    if (!node.isText || !node.text) return;
    if (node.marks.some((mark) => mark.type.name === 'code')) return;
    chunks.push({ text: node.text, base: pos });
  });
  return chunks;
}

async function defaultFetchDictionaries(langs: SpellLang[]): Promise<SpellcheckDictionary[]> {
  const loaded: SpellcheckDictionary[] = [];
  for (const lang of langs) {
    const id = lang === 'en_US' ? 'hunspell-en_US' : 'hunspell-de_DE';
    const prefix = lang === 'en_US' ? 'en_US' : 'de_DE';
    try {
      const [aff, dic] = await Promise.all([
        apiFetchBlob(`/models/client-assets/${id}/${prefix}.aff`),
        apiFetchBlob(`/models/client-assets/${id}/${prefix}.dic`),
      ]);
      loaded.push({ lang, aff: await aff.text(), dic: await dic.text() });
    } catch {
      // One missing pack must not block the other language.
    }
  }
  return loaded;
}

export const SpellcheckExtension = Extension.create<SpellcheckOptions>({
  name: 'spellcheck',

  addOptions() {
    return {
      enabled: false,
      languages: ['en_US', 'de_DE'],
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    let worker: Worker | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let seq = 0;
    let latestCheckId = '';

    const startWorker = (view: EditorView): Worker | null => {
      if (worker) return worker;
      const create = options.createWorker ?? (() => new Worker(
        new URL('../../lib/spellcheck/spellcheck.worker.ts', import.meta.url),
        { type: 'module' },
      ));
      try {
        worker = create();
        worker.onmessage = (event: MessageEvent<{
          type: string;
          id?: string;
          ranges?: MissRange[];
        }>) => {
          const data = event.data;
          if (data.type === 'ready') {
            options.onStatus?.('ready');
            schedule(view, true);
            return;
          }
          if (data.type === 'error') {
            options.onStatus?.('failed');
            return;
          }
          if (data.type === 'misses' && data.ranges && data.id === latestCheckId) {
            view.dispatch(view.state.tr.setMeta(spellcheckPluginKey, data.ranges));
          }
        };
        const fetchDicts = options.fetchDictionaries ?? defaultFetchDictionaries;
        void fetchDicts(valueOf(options.languages))
          .then((dictionaries) => {
            if (!worker) return;
            if (dictionaries.length === 0) {
              options.onStatus?.('failed');
              return;
            }
            worker.postMessage({
              id: 'load',
              type: 'load',
              langs: dictionaries.map((d) => d.lang),
              dictionaries,
            });
          })
          .catch(() => options.onStatus?.('failed'));
        return worker;
      } catch {
        return null;
      }
    };

    const schedule = (view: EditorView, immediate = false) => {
      if (!valueOf(options.enabled)) return;
      if (debounce) clearTimeout(debounce);
      const run = () => {
        const w = startWorker(view);
        if (!w) return;
        const id = `chk-${seq++}`;
        latestCheckId = id;
        w.postMessage({
          id,
          type: 'check',
          chunks: collectSpellcheckChunks(view.state.doc),
        });
      };
      if (immediate) run();
      else debounce = setTimeout(run, 200);
    };

    return [
      new Plugin<SpellcheckState>({
        key: spellcheckPluginKey,
        state: {
          init: () => ({ decorations: DecorationSet.empty }),
          apply(tr, value) {
            const mapped = { decorations: value.decorations.map(tr.mapping, tr.doc) };
            const misses = tr.getMeta(spellcheckPluginKey) as MissRange[] | undefined;
            if (!misses) return mapped;
            const decorations = misses.map((miss) => Decoration.inline(miss.from, miss.to, {
              class: 'spellcheck-miss',
            }));
            return { decorations: DecorationSet.create(tr.doc, decorations) };
          },
        },
        props: {
          decorations(state) {
            return spellcheckPluginKey.getState(state)?.decorations ?? DecorationSet.empty;
          },
        },
        view(view) {
          if (valueOf(options.enabled)) startWorker(view);
          schedule(view);
          return {
            update(v, prev) {
              if (!valueOf(options.enabled)) return;
              startWorker(v);
              if (v.state.doc.eq(prev.doc)) return;
              schedule(v);
            },
            destroy() {
              if (debounce) clearTimeout(debounce);
              worker?.terminate();
              worker = null;
            },
          };
        },
      }),
    ];
  },
});
