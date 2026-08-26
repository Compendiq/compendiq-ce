import {
  buildContinuationPrompt,
  normalizeInlineCompletion,
  rewriteMaxNewTokens,
} from './instruct-format';
import { CLIENT_INFERENCE_MODEL_ID, type WorkerEvent, type WorkerRequest } from './worker-protocol';

let generator: ((input: unknown, gen?: Record<string, unknown>) => Promise<unknown>) | null = null;
let loadedModel: string | null = null;
const aborted = new Set<string>();

function post(event: WorkerEvent): void {
  self.postMessage(event);
}

async function ensurePipeline(modelId: string): Promise<void> {
  if (generator && loadedModel === modelId) return;
  const transformers = await import('@huggingface/transformers');
  transformers.env.allowRemoteModels = true;
  transformers.env.allowLocalModels = false;
  transformers.env.remoteHost = `${self.location.origin}/api/models/client-assets/`;
  transformers.env.remotePathTemplate = '{model}/';
  transformers.env.useBrowserCache = true;
  generator = await transformers.pipeline('text-generation', modelId, {
    device: 'webgpu',
    dtype: 'q4',
  });
  loadedModel = modelId;
}

function extractText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output) && output[0] && typeof output[0] === 'object') {
    const row = output[0] as { generated_text?: unknown };
    if (typeof row.generated_text === 'string') return row.generated_text;
  }
  return '';
}

async function onRequest(msg: WorkerRequest): Promise<void> {
  if (msg.type === 'abort') {
    aborted.add(msg.targetId);
    return;
  }
  if (msg.type === 'unload') {
    generator = null;
    loadedModel = null;
    return;
  }
  try {
    if (msg.type === 'load') {
      await ensurePipeline(msg.modelId);
      if (aborted.has(msg.id)) return;
      post({ id: msg.id, type: 'ready', modelId: msg.modelId });
      return;
    }
    if (!generator) {
      post({ id: msg.id, type: 'error', code: 'load', message: 'model not loaded' });
      return;
    }
    if (msg.type === 'complete') {
      const prompt = buildContinuationPrompt(msg.prefix, msg.suffix);
      const output = await generator(prompt, {
        max_new_tokens: Math.min(64, msg.maxTokens),
        return_full_text: false,
      });
      if (aborted.has(msg.id)) {
        post({ id: msg.id, type: 'error', code: 'aborted', message: 'aborted' });
        return;
      }
      post({ id: msg.id, type: 'result', text: normalizeInlineCompletion(extractText(output)) });
      return;
    }
    if (msg.type === 'rewrite') {
      const instruction = msg.instruction
        ?? (msg.task === 'grammar'
          ? 'Fix spelling and grammar.'
          : msg.task === 'clarity'
            ? 'Improve writing, keep meaning.'
            : 'Make the text more complete.');
      const prompt = `${instruction}\n\nRewrite the following as Markdown only, no HTML, no preamble:\n\n${msg.text}`;
      const output = await generator(prompt, {
        max_new_tokens: rewriteMaxNewTokens(msg.text.length),
        return_full_text: false,
      });
      if (aborted.has(msg.id)) {
        post({ id: msg.id, type: 'error', code: 'aborted', message: 'aborted' });
        return;
      }
      post({ id: msg.id, type: 'result', text: extractText(output).trim() });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'load failed';
    const code = /webgpu|adapter/i.test(message)
      ? 'webgpu'
      : /memory|oom/i.test(message)
        ? 'oom'
        : 'load';
    post({ id: msg.id, type: 'error', code, message });
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  void onRequest(event.data);
};

void CLIENT_INFERENCE_MODEL_ID;
