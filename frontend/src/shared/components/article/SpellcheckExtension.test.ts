import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SpellcheckExtension,
  collectSpellcheckChunks,
  spellcheckPluginKey,
} from './SpellcheckExtension';
import type { SpellLang } from '../../lib/spellcheck/spellcheck-engine';

const here = dirname(fileURLToPath(import.meta.url));

describe('SpellcheckExtension (#1418 SPEC-030)', () => {
  it('is a distinct TipTap extension, not folded into inline completion', () => {
    expect(SpellcheckExtension.name).toBe('spellcheck');
    expect(SpellcheckExtension.name).not.toBe('inlineCompletion');
  });

  it('uses a 200ms debounce and a wavy interactive-border class', () => {
    const source = readFileSync(resolve(here, 'SpellcheckExtension.ts'), 'utf8');
    expect(source).toMatch(/200/);
    expect(source).toMatch(/spellcheck-miss/);
    expect(source).toMatch(/codeBlock/);
  });
});

describe('collectSpellcheckChunks', () => {
  let editor: Editor;

  afterEach(() => {
    editor?.destroy();
  });

  function mount(content: string): Editor {
    editor = new Editor({
      extensions: [StarterKit],
      content,
    });
    return editor;
  }

  it('uses ProseMirror positions, not textBetween offsets, for a second paragraph', () => {
    const ed = mount('<p>Hello</p><p>World</p>');
    expect(collectSpellcheckChunks(ed.state.doc)).toEqual([
      { text: 'Hello', base: 1 },
      { text: 'World', base: 8 },
    ]);
  });

  it('skips codeBlock and inline code', () => {
    const ed = mount('<p>Hello</p><pre><code>xyzzy</code></pre><p>Use <code>foo</code> here</p>');
    const chunks = collectSpellcheckChunks(ed.state.doc);
    expect(chunks.every((c) => !c.text.includes('xyzzy') && !c.text.includes('foo'))).toBe(true);
    expect(chunks.some((c) => c.text.includes('Hello'))).toBe(true);
    expect(chunks.some((c) => c.text.includes('here'))).toBe(true);
  });
});

type SpellMessage =
  | { id: string; type: 'load'; langs: SpellLang[]; dictionaries: Array<{ lang: SpellLang; aff: string; dic: string }> }
  | { id: string; type: 'check'; chunks: Array<{ text: string; base: number }> };

class FakeSpellWorker {
  onmessage: ((event: MessageEvent<{ type: string; id?: string; ranges?: Array<{ from: number; to: number; word: string }> }>) => void) | null = null;
  messages: SpellMessage[] = [];
  private loaded = false;

  postMessage(data: SpellMessage): void {
    this.messages.push(data);
    queueMicrotask(() => {
      if (data.type === 'load') {
        this.loaded = true;
        this.onmessage?.({ data: { id: data.id, type: 'ready' } } as MessageEvent<{ type: string; id?: string }>);
        return;
      }
      if (data.type === 'check') {
        if (!this.loaded) {
          this.onmessage?.({
            data: { id: data.id, type: 'misses', ranges: [] },
          } as MessageEvent<{ type: string; id?: string; ranges: never[] }>);
          return;
        }
        const world = data.chunks.find((c) => c.text.includes('World'));
        const idx = world?.text.indexOf('World') ?? -1;
        const ranges = world && idx >= 0
          ? [{ from: world.base + idx, to: world.base + idx + 5, word: 'World' }]
          : [];
        this.onmessage?.({
          data: { id: data.id, type: 'misses', ranges },
        } as MessageEvent<{ type: string; id?: string; ranges: Array<{ from: number; to: number; word: string }> }>);
      }
    });
  }

  terminate(): void {}
}

describe('SpellcheckExtension decorations', () => {
  let editor: Editor;

  afterEach(() => {
    editor?.destroy();
    vi.useRealTimers();
  });

  it('decorates the second paragraph using document positions after dictionaries are ready', async () => {
    vi.useFakeTimers();
    const worker = new FakeSpellWorker();
    const fetchDictionaries = vi.fn(async (langs: SpellLang[]) => langs.map((lang) => ({
      lang,
      aff: 'AFF',
      dic: 'DIC',
    })));
    const element = document.createElement('div');
    document.body.appendChild(element);
    editor = new Editor({
      element,
      content: '<p>Hello</p><p>World</p>',
      extensions: [
        StarterKit,
        SpellcheckExtension.configure({
          enabled: true,
          languages: ['en_US'],
          createWorker: () => worker as unknown as Worker,
          fetchDictionaries,
        }),
      ],
    });
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchDictionaries).toHaveBeenCalled();
    expect(worker.messages.some((m) => m.type === 'load')).toBe(true);
    const deco = spellcheckPluginKey.getState(editor.state)?.decorations;
    const hits = deco?.find().filter((d) => d.from === 8 && d.to === 13);
    expect(hits?.length).toBe(1);
  });
});
