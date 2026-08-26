import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClientInferenceManager } from './client-inference-manager';
import type { WorkerEvent, WorkerRequest } from './worker-protocol';
import { LOCAL_COMPLETION_MODEL, LOCAL_COMPLETION_PROVIDER } from './worker-protocol';
import type { DeviceGpuProfile } from './device-gpu-profile';

const COMPACT: DeviceGpuProfile = {
  hasWebGPU: true,
  tier: 'medium',
  recommendedModelTier: 'compact',
  adapterName: 'test',
};

class FakeWorker {
  onmessage: ((event: MessageEvent<WorkerEvent>) => void) | null = null;
  private autoReady = true;
  private autoResult: string | null = ' hello';
  messages: WorkerRequest[] = [];

  constructor(opts?: { autoReady?: boolean; autoResult?: string | null }) {
    this.autoReady = opts?.autoReady ?? true;
    this.autoResult = opts?.autoResult ?? ' hello';
  }

  postMessage(data: WorkerRequest): void {
    this.messages.push(data);
    queueMicrotask(() => {
      if (data.type === 'load' && this.autoReady) {
        this.emit({ id: data.id, type: 'ready', modelId: data.modelId });
      }
      if (data.type === 'complete' && this.autoResult != null) {
        this.emit({ id: data.id, type: 'result', text: this.autoResult });
      }
      if (data.type === 'rewrite' && this.autoResult != null) {
        this.emit({ id: data.id, type: 'result', text: this.autoResult });
      }
    });
  }

  emit(event: WorkerEvent): void {
    this.onmessage?.({ data: event } as MessageEvent<WorkerEvent>);
  }

  terminate(): void {}
}

function compactManager(worker: FakeWorker, hasCache = true): ClientInferenceManager {
  return new ClientInferenceManager({
    createWorker: () => worker as unknown as Worker,
    probe: async () => COMPACT,
    hasCache: async () => hasCache,
  });
}

describe('ClientInferenceManager (#1418)', () => {
  afterEach(() => vi.useRealTimers());

  it('falls through immediately when the worker is not ready (SPEC-005)', async () => {
    const worker = new FakeWorker({ autoReady: false });
    const mgr = compactManager(worker, false);
    mgr.setFlags({ adminEnabled: true, userEnabled: true });
    const decision = await mgr.decideComplete({
      input: { prefix: 'Rotate the', maxTokens: 48 },
      signal: new AbortController().signal,
      assigned: true,
      withoutServer: true,
      wordMode: false,
    });
    expect(decision).toEqual({ kind: 'server' });
    expect(worker.messages.some((m) => m.type === 'complete')).toBe(false);
  });

  it('runs locally when ready and returns the webgpu provider (SPEC-023)', async () => {
    const worker = new FakeWorker();
    const mgr = compactManager(worker);
    mgr.setFlags({ adminEnabled: true, userEnabled: true });
    const first = await mgr.decideComplete({
      input: { prefix: 'Rotate the', maxTokens: 48 },
      signal: new AbortController().signal,
      assigned: false,
      withoutServer: true,
      wordMode: false,
    });
    expect(first).toEqual({ kind: 'off' });
    await Promise.resolve();
    await Promise.resolve();
    const decision = await mgr.decideComplete({
      input: { prefix: 'Rotate the', maxTokens: 48 },
      signal: new AbortController().signal,
      assigned: false,
      withoutServer: true,
      wordMode: false,
    });
    expect(decision).toEqual({
      kind: 'local',
      response: {
        completion: ' hello',
        model: LOCAL_COMPLETION_MODEL,
        provider: LOCAL_COMPLETION_PROVIDER,
      },
    });
  });

  it('stays off when unassigned and withoutServer is false (SPEC-018)', async () => {
    const worker = new FakeWorker();
    const mgr = compactManager(worker);
    mgr.setFlags({ adminEnabled: true, userEnabled: true });
    const decision = await mgr.decideComplete({
      input: { prefix: 'Rotate the', maxTokens: 48 },
      signal: new AbortController().signal,
      assigned: false,
      withoutServer: false,
      wordMode: false,
    });
    expect(decision).toEqual({ kind: 'off' });
  });

  it('does not dispatch a late result after abort (SPEC-022)', async () => {
    const worker = new FakeWorker({ autoResult: null });
    const mgr = compactManager(worker);
    mgr.setFlags({ adminEnabled: true, userEnabled: true });
    await mgr.decideComplete({
      input: { prefix: 'Rotate the', maxTokens: 48 },
      signal: new AbortController().signal,
      assigned: true,
      withoutServer: true,
      wordMode: false,
    });
    await Promise.resolve();
    await Promise.resolve();
    const controller = new AbortController();
    const pending = mgr.decideComplete({
      input: { prefix: 'Rotate the', maxTokens: 48 },
      signal: controller.signal,
      assigned: true,
      withoutServer: true,
      wordMode: false,
    });
    await Promise.resolve();
    const complete = worker.messages.filter((m) => m.type === 'complete').at(-1);
    expect(complete).toBeDefined();
    controller.abort();
    await expect(pending).resolves.toEqual({ kind: 'server' });
    worker.emit({ id: complete!.id, type: 'result', text: ' late' });
    await Promise.resolve();
    await expect(pending).resolves.toEqual({ kind: 'server' });
  });

  it('does not fetch ONNX on construct (SPEC-019)', () => {
    const downloadFile = vi.fn();
    const mgr = new ClientInferenceManager({
      createWorker: () => new FakeWorker() as unknown as Worker,
      probe: async () => COMPACT,
      downloadFile,
    });
    mgr.setFlags({ adminEnabled: true, userEnabled: true });
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('resolves in-flight work when the worker is torn down', async () => {
    const worker = new FakeWorker({ autoResult: null });
    const mgr = compactManager(worker);
    mgr.setFlags({ adminEnabled: true, userEnabled: true });
    await mgr.decideComplete({
      input: { prefix: 'Rotate the', maxTokens: 48 },
      signal: new AbortController().signal,
      assigned: true,
      withoutServer: true,
      wordMode: false,
    });
    await Promise.resolve();
    await Promise.resolve();
    const pending = mgr.decideComplete({
      input: { prefix: 'Rotate the', maxTokens: 48 },
      signal: new AbortController().signal,
      assigned: true,
      withoutServer: true,
      wordMode: false,
    });
    await Promise.resolve();
    mgr.setFlags({ adminEnabled: false, userEnabled: true });
    await expect(pending).resolves.toEqual({ kind: 'server' });
  });

  it('coalesces concurrent load posts', async () => {
    const worker = new FakeWorker({ autoReady: false });
    const mgr = compactManager(worker, true);
    mgr.setFlags({ adminEnabled: true, userEnabled: true });
    const args = {
      input: { prefix: 'Rotate the', maxTokens: 48 },
      signal: new AbortController().signal,
      assigned: true,
      withoutServer: true,
      wordMode: false,
    };
    await mgr.decideComplete(args);
    await mgr.decideComplete(args);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(worker.messages.filter((m) => m.type === 'load')).toHaveLength(1);
  });

  it('posts the access token on load so the worker can authorize asset GETs', async () => {
    const worker = new FakeWorker({ autoReady: false });
    const mgr = new ClientInferenceManager({
      createWorker: () => worker as unknown as Worker,
      probe: async () => COMPACT,
      hasCache: async () => true,
      accessToken: () => 'tok-9',
    });
    mgr.setFlags({ adminEnabled: true, userEnabled: true });
    await mgr.decideComplete({
      input: { prefix: 'Rotate the', maxTokens: 48 },
      signal: new AbortController().signal,
      assigned: true,
      withoutServer: true,
      wordMode: false,
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(worker.messages.find((m) => m.type === 'load')).toMatchObject({
      type: 'load',
      accessToken: 'tok-9',
    });
  });
});
