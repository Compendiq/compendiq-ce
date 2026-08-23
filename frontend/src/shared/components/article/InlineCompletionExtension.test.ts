import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import type { InlineCompletionRequest, InlineCompletionResponse } from '@compendiq/contracts';
import {
  InlineCompletionExtension,
  inlineCompletionPluginKey,
} from './InlineCompletionExtension';

interface HarnessOptions {
  content?: string;
  delayMs?: number | null;
  codeOnly?: boolean;
  coarse?: boolean;
  isMac?: boolean;
  request?: (
    input: InlineCompletionRequest,
    signal: AbortSignal,
  ) => Promise<InlineCompletionResponse | undefined>;
  onSuggestionStateChange?: (active: boolean) => void;
}

function defaultRequest() {
  return vi.fn(async (): Promise<InlineCompletionResponse> => ({
    completion: ' access token.',
    model: 'm',
    provider: 'p',
  }));
}

function mount(options: HarnessOptions = {}) {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const request = options.request ?? defaultRequest();
  const editor = new Editor({
    element,
    content: options.content ?? '<p>Rotate the</p>',
    extensions: [
      StarterKit,
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      InlineCompletionExtension.configure({
        enabled: true,
        delayMs: options.delayMs === undefined ? 500 : options.delayMs,
        codeOnly: options.codeOnly ?? false,
        requestCompletion: request,
        isCoarsePointer: () => options.coarse ?? false,
        isMac: () => options.isMac ?? false,
        onSuggestionStateChange: options.onSuggestionStateChange,
      }),
    ],
  });
  editor.commands.focus('end');
  return { editor, element, request };
}

function key(editor: Editor, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  editor.view.dom.dispatchEvent(event);
  return event;
}

async function typeAndResolve(editor: Editor, delayMs = 500): Promise<void> {
  editor.commands.insertContent(' ');
  await vi.advanceTimersByTimeAsync(delayMs);
  await Promise.resolve();
  await Promise.resolve();
}

describe('InlineCompletionExtension (#1417)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('debounces typing, sends bounded cursor context, and renders aria-hidden ghost text', async () => {
    const onState = vi.fn();
    const { editor, request } = mount({ onSuggestionStateChange: onState });
    await typeAndResolve(editor);

    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.mocked(request).mock.calls[0]![0]).toMatchObject({
      prefix: 'Rotate the ',
      maxTokens: 48,
    });
    const ghost = document.querySelector('[data-testid="inline-completion-ghost"]');
    expect(ghost).toHaveTextContent('access token.');
    expect(ghost).toHaveAttribute('aria-hidden', 'true');
    expect(ghost).toHaveClass('cq-inline-completion-ghost', 'pointer-events-none', 'select-none');
    expect(onState).toHaveBeenLastCalledWith(true);
    editor.destroy();
  });

  it('accepts the full suggestion with Tab in one history transaction', async () => {
    const { editor } = mount();
    await typeAndResolve(editor);
    const before = editor.getText();
    const event = key(editor, { key: 'Tab', code: 'Tab' });
    expect(event.defaultPrevented).toBe(true);
    expect(editor.getText()).toBe(`${before}access token.`);
    expect(inlineCompletionPluginKey.getState(editor.state)?.activeSuggestion).toBeNull();
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getText()).toBe(before);
    editor.destroy();
  });

  it('accepts one word with Ctrl+] off macOS and keeps the remainder as ghost text', async () => {
    const request = vi.fn(async () => ({
      completion: ' access token before expiry.', model: 'm', provider: 'p',
    }));
    const { editor } = mount({ request, isMac: false });
    await typeAndResolve(editor);
    key(editor, { key: ']', code: 'BracketRight', ctrlKey: true });
    expect(editor.getText()).toBe('Rotate the access ');
    expect(document.querySelector('[data-testid="inline-completion-ghost"]')).toHaveTextContent(
      'token before expiry.',
    );
    editor.destroy();
  });

  it('uses Alt+] for word acceptance on macOS', async () => {
    const { editor } = mount({ isMac: true });
    await typeAndResolve(editor);
    key(editor, { key: ']', code: 'BracketRight', altKey: true });
    expect(editor.getText()).toBe('Rotate the access ');
    editor.destroy();
  });

  it('Escape dismisses and stops propagation', async () => {
    const { editor } = mount();
    await typeAndResolve(editor);
    const parentListener = vi.fn();
    editor.view.dom.parentElement?.addEventListener('keydown', parentListener);
    const event = key(editor, { key: 'Escape', code: 'Escape' });
    expect(event.defaultPrevented).toBe(true);
    expect(parentListener).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="inline-completion-ghost"]')).toBeNull();
    editor.destroy();
  });

  it('leaves Tab to ProseMirror when there is no suggestion, including in a table', () => {
    const { editor } = mount({
      content: '<table><tbody><tr><td><p>Cell</p></td></tr></tbody></table>',
      delayMs: null,
    });
    editor.commands.focus('end');
    const event = key(editor, { key: 'Tab', code: 'Tab' });
    expect(event.defaultPrevented).toBe(false);
    editor.destroy();
  });

  it('does not request suggestions inside tables', async () => {
    const { editor, request } = mount({
      content: '<table><tbody><tr><td><p>Cell</p></td></tr></tbody></table>',
    });
    // Position 8 is the end of "Cell" inside the sole table cell. `focus('end')`
    // may create/select a trailing paragraph after a terminal table.
    editor.commands.setTextSelection(8);
    editor.commands.insertContent(' text');
    await vi.advanceTimersByTimeAsync(500);
    expect(request).not.toHaveBeenCalled();
    editor.destroy();
  });

  it('does not request or intercept keys while IME composition is active', async () => {
    const { editor, request } = mount();
    Object.defineProperty(editor.view, 'composing', { configurable: true, value: true });
    editor.commands.insertContent(' ');
    await vi.advanceTimersByTimeAsync(500);
    expect(request).not.toHaveBeenCalled();
    expect(key(editor, { key: 'Tab', code: 'Tab' }).defaultPrevented).toBe(false);
    editor.destroy();
  });

  it('aborts an in-flight request when typing moves the cursor context', async () => {
    let signal: AbortSignal | undefined;
    const request = vi.fn((_input, currentSignal: AbortSignal) => {
      signal = currentSignal;
      return new Promise<InlineCompletionResponse | undefined>(() => {});
    });
    const { editor } = mount({ request });
    editor.commands.insertContent(' ');
    await vi.advanceTimersByTimeAsync(500);
    expect(signal?.aborted).toBe(false);
    editor.commands.insertContent('x');
    expect(signal?.aborted).toBe(true);
    editor.destroy();
  });

  it('suppresses requests on coarse pointers and outside code blocks in code-only mode', async () => {
    const coarse = mount({ coarse: true });
    await typeAndResolve(coarse.editor);
    expect(coarse.request).not.toHaveBeenCalled();
    coarse.editor.destroy();

    const prose = mount({ codeOnly: true });
    await typeAndResolve(prose.editor);
    expect(prose.request).not.toHaveBeenCalled();
    prose.editor.destroy();

    const code = mount({ content: '<pre><code>const token =</code></pre>', codeOnly: true });
    await typeAndResolve(code.editor);
    expect(code.request).toHaveBeenCalledOnce();
    code.editor.destroy();
  });

  it('supports manual-only mode through Alt+\\ force request', async () => {
    const { editor, request } = mount({ delayMs: null });
    editor.commands.insertContent(' ');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(request).not.toHaveBeenCalled();
    const event = key(editor, { key: '\\', code: 'Backslash', altKey: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(event.defaultPrevented).toBe(true);
    expect(request).toHaveBeenCalledOnce();
    editor.destroy();
  });
});
