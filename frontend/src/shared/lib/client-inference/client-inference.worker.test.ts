import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerEvent, WorkerRequest } from './worker-protocol';

// The external GPU boundary has room for one model, as on a constrained
// device. Dropping the JS pipeline reference does not release its session.
vi.mock('@huggingface/transformers', () => {
  let residentModels = 0;
  return {
    env: { backends: { onnx: { wasm: {} } } },
    pipeline: async () => {
      if (residentModels > 0) throw new Error('std::bad_alloc');
      residentModels += 1;
      const generate = async () => [{ generated_text: ' continuation' }];
      return Object.assign(generate, {
        tokenizer: { apply_chat_template: () => 'formatted prompt' },
        dispose: async () => { residentModels -= 1; },
      });
    },
  };
});

describe('client inference worker resource lifetime', () => {
  afterEach(() => {
    self.onmessage = null;
    vi.restoreAllMocks();
  });

  it('can load again after unload without retaining the previous GPU session', async () => {
    const events: WorkerEvent[] = [];
    vi.spyOn(self, 'postMessage').mockImplementation((event: WorkerEvent) => {
      events.push(event);
    });
    // Module loading is the boundary: install the worker transport before its
    // top-level onmessage handler is registered.
    await import('./client-inference.worker');
    const send = (request: WorkerRequest) => {
      self.onmessage!(new MessageEvent('message', { data: request }));
    };
    const response = async (id: string) => {
      await vi.waitFor(() => expect(events.find((event) => event.id === id)).toBeDefined());
      return events.find((event) => event.id === id);
    };
    send({ id: 'first', type: 'load', modelId: 'qwen2.5-0.5b-instruct-q4' });
    expect(await response('first')).toMatchObject({ type: 'ready' });
    send({ id: 'unload', type: 'unload' });
    send({ id: 'second', type: 'load', modelId: 'qwen2.5-0.5b-instruct-q4' });
    expect(await response('second')).toMatchObject({ type: 'ready' });
    // No inference is legal after the final unload, and its response is also
    // a barrier that makes resource cleanup finish before this test returns.
    send({ id: 'done', type: 'unload' });
    send({ id: 'after-unload', type: 'complete', prefix: 'hello', maxTokens: 8 });
    expect(await response('after-unload')).toMatchObject({ type: 'error', code: 'load' });
  });
});
