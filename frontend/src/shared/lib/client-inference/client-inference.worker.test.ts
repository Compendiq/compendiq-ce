import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerEvent, WorkerRequest } from './worker-protocol';

const { generatedPrompts } = vi.hoisted(() => ({ generatedPrompts: [] as string[] }));

// The external GPU boundary has room for one model, as on a constrained
// device. Dropping the JS pipeline reference does not release its session.
// A model id starting with `base-` ships no chat template, like a non-instruct
// checkpoint picked through the admin search.
vi.mock('@huggingface/transformers', () => {
  let residentModels = 0;
  return {
    env: { backends: { onnx: { wasm: {} } } },
    pipeline: async (_task: string, modelId: string) => {
      if (residentModels > 0) throw new Error('std::bad_alloc');
      residentModels += 1;
      const generate = async (prompt: string) => {
        generatedPrompts.push(prompt);
        return [{ generated_text: ' continuation' }];
      };
      const templated = !modelId.startsWith('base-');
      return Object.assign(generate, {
        tokenizer: {
          chat_template: templated ? '{{ messages }}' : undefined,
          apply_chat_template: () => {
            if (!templated) throw new Error('Cannot use apply_chat_template() because tokenizer.chat_template is not set');
            return 'formatted prompt';
          },
        },
        dispose: async () => { residentModels -= 1; },
      });
    },
  };
});

/**
 * Boot the worker module under a captured transport. The module registers its
 * `self.onmessage` at load, so each test re-imports it after `resetModules`.
 */
async function bootWorker() {
  const events: WorkerEvent[] = [];
  vi.spyOn(self, 'postMessage').mockImplementation((event: WorkerEvent) => {
    events.push(event);
  });
  // Dynamic on purpose: the module-load boundary is what installs the handler.
  await import('./client-inference.worker');
  const send = (request: WorkerRequest) => {
    self.onmessage!(new MessageEvent('message', { data: request }));
  };
  const response = async (id: string) => {
    await vi.waitFor(() => expect(events.find((event) => event.id === id)).toBeDefined());
    return events.find((event) => event.id === id);
  };
  return { send, response };
}

describe('client inference worker', () => {
  afterEach(() => {
    self.onmessage = null;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('can load again after unload without retaining the previous GPU session', async () => {
    const { send, response } = await bootWorker();
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

  it('applies the chat template when the model ships one', async () => {
    const { send, response } = await bootWorker();
    send({ id: 'load', type: 'load', modelId: 'qwen2.5-0.5b-instruct-q4' });
    expect(await response('load')).toMatchObject({ type: 'ready' });
    send({ id: 'complete', type: 'complete', prefix: 'The capital of France is ', maxTokens: 8 });
    expect(await response('complete')).toMatchObject({ type: 'result', text: ' continuation' });
    expect(generatedPrompts.at(-1)).toBe('formatted prompt');
    send({ id: 'done', type: 'unload' });
    send({ id: 'after', type: 'complete', prefix: 'x', maxTokens: 8 });
    await response('after');
  });

  it('completes with the bare prompt when the model ships no chat template', async () => {
    const { send, response } = await bootWorker();
    send({ id: 'load', type: 'load', modelId: 'base-smollm' });
    expect(await response('load')).toMatchObject({ type: 'ready' });
    send({ id: 'complete', type: 'complete', prefix: 'The capital of France is ', maxTokens: 8 });
    // A result, never a `load` error — that code latches the manager's loadFailed.
    expect(await response('complete')).toMatchObject({ type: 'result', text: ' continuation' });
    expect(generatedPrompts.at(-1)).toContain('The capital of France is ');
    send({ id: 'done', type: 'unload' });
    send({ id: 'after', type: 'complete', prefix: 'x', maxTokens: 8 });
    await response('after');
  });
});
