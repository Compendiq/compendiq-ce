import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { SpellLang } from '../../lib/spellcheck/spellcheck-engine';

export const spellcheckPluginKey = new PluginKey<SpellcheckState>('spellcheck');

export interface SpellcheckState {
  decorations: DecorationSet;
}

export interface SpellcheckOptions {
  enabled: boolean | (() => boolean);
  languages: SpellLang[] | (() => SpellLang[]);
  createWorker?: () => Worker;
}

type MissRange = { from: number; to: number; word: string };

function valueOf<T>(value: T | (() => T)): T {
  return typeof value === 'function' ? (value as () => T)() : value;
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

    const startWorker = (): Worker | null => {
      if (worker) return worker;
      const create = options.createWorker ?? (() => new Worker(
        new URL('../../lib/spellcheck/spellcheck.worker.ts', import.meta.url),
        { type: 'module' },
      ));
      try {
        worker = create();
        worker.postMessage({
          id: 'load',
          type: 'load',
          langs: valueOf(options.languages),
          origin: window.location.origin,
        });
        return worker;
      } catch {
        return null;
      }
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
          handleClick(view, pos) {
            if (!valueOf(options.enabled)) return false;
            const $pos = view.state.doc.resolve(pos);
            if ($pos.parent.type.name === 'codeBlock') return false;
            return false;
          },
        },
        view(view) {
          const schedule = () => {
            if (!valueOf(options.enabled)) return;
            if (debounce) clearTimeout(debounce);
            debounce = setTimeout(() => {
              const w = startWorker();
              if (!w) return;
              const id = `chk-${seq++}`;
              w.onmessage = (event: MessageEvent<{ type: string; ranges?: MissRange[] }>) => {
                if (event.data.type !== 'misses' || !event.data.ranges) return;
                view.dispatch(view.state.tr.setMeta(spellcheckPluginKey, event.data.ranges));
              };
              w.postMessage({
                id,
                type: 'check',
                text: view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '\n'),
                base: 0,
              });
            }, 200);
          };
          schedule();
          return {
            update(v, prev) {
              if (!valueOf(options.enabled)) return;
              if (v.state.doc.eq(prev.doc)) return;
              schedule();
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
