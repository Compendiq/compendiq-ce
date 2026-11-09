import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClientInferenceManager, type ClientInferenceOrgPolicy } from './client-inference-manager';
import type { WorkerEvent, WorkerRequest } from './worker-protocol';
import { CLIENT_INFERENCE_MODEL_ID, LOCAL_COMPLETION_PROVIDER } from './worker-protocol';
import type { DeviceGpuProfile } from './device-gpu-profile';
import { ApiError } from '../api';

const COMPACT: DeviceGpuProfile = {
  hasWebGPU: true,
  tier: 'medium',
  recommendedModelTier: 'compact',
  adapterName: 'test',
};

class FakeWorker {
  onmessage: ((event: MessageEvent<WorkerEvent>) => void) | null = null;
  autoReady = true;
  private autoResult: string | null = ' hello';
  messages: WorkerRequest[] = [];

  constructor(opts?: { autoReady?: boolean; autoResult?: string | null }) {
    this.autoReady = opts?.autoReady ?? true;
    this.autoResult = opts?.autoResult === undefined ? ' hello' : opts.autoResult;
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

const INACTIVE_POLICY: ClientInferenceOrgPolicy = {
  active: false,
  mode: 'allowed',
  allowedModels: [],
  enforceWebGpuOnly: false,
};

async function waitForLoad(worker: FakeWorker): Promise<WorkerRequest> {
  for (let i = 0; i < 25; i++) {
    const load = worker.messages.find((m) => m.type === 'load');
    if (load) return load;
    await Promise.resolve();
  }
  throw new Error('worker did not receive load');
}

function compactManager(
  worker: FakeWorker,
  hasCache = true,
  fetchOrgPolicy?: () => Promise<ClientInferenceOrgPolicy>,
): ClientInferenceManager {
  return new ClientInferenceManager({
    fetchArticlePolicy: async () => ({ authorized: true, pageId: 42, aiPolicy: 'all', aiPolicyRevision: 0 }),
    createWorker: () => worker as unknown as Worker,
    probe: async () => COMPACT,
    hasCache: async () => hasCache,
    fetchOrgPolicy: fetchOrgPolicy ?? (async () => INACTIVE_POLICY),
  });
}

describe('ClientInferenceManager (#1418)', () => {
  afterEach(() => vi.useRealTimers());

  it('falls through immediately when the worker is not ready (SPEC-005)', async () => {
    const worker = new FakeWorker({ autoReady: false });
    const mgr = compactManager(worker, false);
    mgr.setFlags({ adminEnabled: true, userEnabled: true });
    const decision = await mgr.decideComplete({
      input: { pageId: 42, prefix: 'Rotate the', maxTokens: 48 },
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
      input: { pageId: 42, prefix: 'Rotate the', maxTokens: 48 },
      signal: new AbortController().signal,
      assigned: false,
      withoutServer: true,
      wordMode: false,
    });
    expect(first).toEqual({ kind: 'off' });
    await Promise.resolve();
    await Promise.resolve();
    const decision = await mgr.decideComplete({
      input: { pageId: 42, prefix: 'Rotate the', maxTokens: 48 },
      signal: new AbortController().signal,
      assigned: false,
      withoutServer: true,
      wordMode: false,
    });
    expect(decision).toEqual({
      kind: 'local',
      response: {
        completion: ' hello',
        model: `client:${CLIENT_INFERENCE_MODEL_ID}`,
        provider: LOCAL_COMPLETION_PROVIDER,
      },
    });
  });

  it('can warm a cached local-only model through the editor availability gate', async () => {
    const worker = new FakeWorker();
    const mgr = compactManager(worker);
    mgr.setFlags({ adminEnabled: true, userEnabled: true });
    await mgr.ensureProbed();
    const args = {
      input: { pageId: 42, prefix: 'The capital of France is ', maxTokens: 8 },
      signal: new AbortController().signal,
      assigned: false,
      withoutServer: true,
      wordMode: true,
    };
    try {
      // The editor never calls decideComplete while this gate is closed.
      expect(mgr.decideGhostAvailability(false, true)).toBe(true);
      await mgr.decideComplete(args);
      await waitForLoad(worker);
      await Promise.resolve();
      expect((await mgr.decideComplete(args)).kind).toBe('local');

      // Returning to a hidden tab must not strand the same cached model.
      const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      visibility.mockRestore();
      expect(mgr.isReady()).toBe(false);
      expect(mgr.decideGhostAvailability(false, true)).toBe(true);
      await mgr.decideComplete(args);
      await vi.waitFor(() => expect(mgr.isReady()).toBe(true));
      expect((await mgr.decideComplete(args)).kind).toBe('local');
    } finally {
      mgr.dispose();
    }
  });

  it('stays off when unassigned and withoutServer is false (SPEC-018)', async () => {
    const worker = new FakeWorker();
    const mgr = compactManager(worker);
    mgr.setFlags({ adminEnabled: true, userEnabled: true });
    const decision = await mgr.decideComplete({
      input: { pageId: 42, prefix: 'Rotate the', maxTokens: 48 },
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
      input: { pageId: 42, prefix: 'Rotate the', maxTokens: 48 },
      signal: new AbortController().signal,
      assigned: true,
      withoutServer: true,
      wordMode: false,
    });
    await waitForLoad(worker);
    await Promise.resolve();
    await Promise.resolve();
    const controller = new AbortController();
    const pending = mgr.decideComplete({
      input: { pageId: 42, prefix: 'Rotate the', maxTokens: 48 },
      signal: controller.signal,
      assigned: true,
      withoutServer: true,
      wordMode: false,
    });
    await Promise.resolve();
    await Promise.resolve();
    await vi.waitFor(() => expect(worker.messages.some((m) => m.type === 'complete')).toBe(true));
    const complete = worker.messages.filter((m) => m.type === 'complete').at(-1);
    expect(complete).toBeDefined();
    controller.abort();
    await expect(pending).resolves.toEqual({ kind: 'off' });
    expect(worker.messages).toContainEqual(expect.objectContaining({ type: 'abort', targetId: complete!.id }));
    worker.emit({ id: complete!.id, type: 'result', text: ' late' });
    await Promise.resolve();
    await expect(pending).resolves.toEqual({ kind: 'off' });
  });

  it.each(['none', 'missing', 'offline', 'changed'])('refuses local %s policy without a server fallback', async (mode) => {
    const worker = new FakeWorker();
    let reads = 0;
    const mgr = new ClientInferenceManager({
      createWorker: () => worker as unknown as Worker,
      probe: async () => COMPACT, hasCache: async () => true,
      fetchOrgPolicy: async () => INACTIVE_POLICY,
      fetchArticlePolicy: async () => {
        reads++;
        if (mode === 'offline') throw new Error('offline');
        if (mode === 'missing') return {};
        return { authorized: true, pageId: 42, aiPolicy: mode === 'none' ? 'none' : 'local_only', aiPolicyRevision: reads > 1 ? 1 : 0 };
      },
    });
    mgr.setFlags({ adminEnabled: true, userEnabled: true });
    const args = { input: { pageId: 42, prefix: 'private', maxTokens: 8 },
      signal: new AbortController().signal, assigned: true, withoutServer: true, wordMode: true };
    await mgr.decideComplete(args);
    await waitForLoad(worker);
    await vi.waitFor(() => expect(mgr.isReady()).toBe(true));
    expect(await mgr.decideComplete(args)).toEqual({ kind: 'off' });
    expect(worker.messages.filter((m) => m.type === 'complete')).toHaveLength(mode === 'changed' ? 1 : 0);
    mgr.dispose();
  });

  it('rejects a local result aborted during its final authoritative policy read', async () => {
    const worker = new FakeWorker();
    const controller = new AbortController();
    let reads = 0;
    const mgr = new ClientInferenceManager({
      createWorker: () => worker as unknown as Worker,
      probe: async () => COMPACT,
      hasCache: async () => true,
      fetchOrgPolicy: async () => INACTIVE_POLICY,
      fetchArticlePolicy: async () => {
        if (++reads === 2) controller.abort();
        return { authorized: true, pageId: 42, aiPolicy: 'local_only', aiPolicyRevision: 0 };
      },
    });
    mgr.setFlags({ adminEnabled: true, userEnabled: true });
    const args = { input: { pageId: 42, prefix: 'private' }, signal: controller.signal,
      assigned: true, withoutServer: true, wordMode: false };
    await mgr.decideComplete(args);
    await waitForLoad(worker);
    await vi.waitFor(() => expect(mgr.isReady()).toBe(true));
    expect(await mgr.decideComplete(args)).toEqual({ kind: 'off' });
    expect(reads).toBe(2);
    mgr.dispose();
  });

  it.each(['before', 'after', 'unbound'])('blocks %s authorization without cached permission', async (when) => {
    const worker = new FakeWorker();
    let reads = 0;
    const mgr = new ClientInferenceManager({
      createWorker: () => worker as unknown as Worker,
      probe: async () => COMPACT, hasCache: async () => true,
      fetchOrgPolicy: async () => INACTIVE_POLICY,
      fetchArticlePolicy: async () => {
        reads++;
        if (when === 'before' || (when === 'after' && reads === 2)) throw new ApiError(403, 'Forbidden');
        return { authorized: when !== 'unbound', pageId: 42, aiPolicy: 'local_only', aiPolicyRevision: 0 };
      },
    });
    mgr.setFlags({ adminEnabled: true, userEnabled: true });
    const args = { input: { pageId: 42, prefix: 'private draft' }, signal: new AbortController().signal,
      assigned: true, withoutServer: true, wordMode: false };
    await mgr.decideComplete(args);
    await waitForLoad(worker);
    await vi.waitFor(() => expect(mgr.isReady()).toBe(true));
    expect(await mgr.decideComplete(args)).toEqual({ kind: 'off' });
    expect(worker.messages.filter((m) => m.type === 'complete')).toHaveLength(when === 'after' ? 1 : 0);
    mgr.dispose();
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
      input: { pageId: 42, prefix: 'Rotate the', maxTokens: 48 },
      signal: new AbortController().signal,
      assigned: true,
      withoutServer: true,
      wordMode: false,
    });
    await Promise.resolve();
    await Promise.resolve();
    const pending = mgr.decideComplete({
      input: { pageId: 42, prefix: 'Rotate the', maxTokens: 48 },
      signal: new AbortController().signal,
      assigned: true,
      withoutServer: true,
      wordMode: false,
    });
    await Promise.resolve();
    mgr.setFlags({ adminEnabled: false, userEnabled: true });
    await expect(pending).resolves.toEqual({ kind: 'server' });
  });

  it('does not retry a terminal GPU load on the next keystroke', async () => {
    const worker = new FakeWorker({ autoReady: false });
    const mgr = compactManager(worker, true);
    mgr.setFlags({ adminEnabled: true, userEnabled: true });
    const args = {
      input: { pageId: 42, prefix: 'Rotate the', maxTokens: 48 },
      signal: new AbortController().signal,
      assigned: true,
      withoutServer: true,
      wordMode: false,
    };
    await mgr.decideComplete(args);
    const load = await waitForLoad(worker);
    expect(load).toBeDefined();
    worker.emit({ id: load.id, type: 'error', code: 'webgpu', message: 'no adapter' });
    await Promise.resolve();
    const loadsBefore = worker.messages.filter((m) => m.type === 'load').length;
    await mgr.decideComplete(args);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(worker.messages.filter((m) => m.type === 'load')).toHaveLength(loadsBefore);
    expect(mgr.lastErrorCategory()).toBe('webgpu');
  });

  it('retries load after an explicit predownload following a terminal failure', async () => {
    const worker = new FakeWorker({ autoReady: false });
    const mgr = new ClientInferenceManager({
      fetchArticlePolicy: async () => ({ authorized: true, pageId: 42, aiPolicy: 'all', aiPolicyRevision: 0 }),
    createWorker: () => worker as unknown as Worker,
      probe: async () => COMPACT,
      hasCache: async () => true,
      fetchManifest: async () => ({
        enabled: true,
        models: [{
          id: 'qwen2.5-0.5b-instruct-q4',
          kind: 'onnx',
          bytes: 1,
          installed: true,
          available: true,
          files: [{ name: 'config.json', bytes: 1 }],
        }],
      }),
      downloadFile: async () => new Blob(['x']),
      fetchOrgPolicy: async () => INACTIVE_POLICY,
    });
    mgr.setFlags({ adminEnabled: true, userEnabled: true });
    await mgr.decideComplete({
      input: { pageId: 42, prefix: 'Rotate the', maxTokens: 48 },
      signal: new AbortController().signal,
      assigned: true,
      withoutServer: true,
      wordMode: false,
    });
    const load = await waitForLoad(worker);
    worker.emit({ id: load.id, type: 'error', code: 'oom', message: 'out of memory' });
    await Promise.resolve();
    worker.autoReady = true;
    await mgr.predownload();
    await Promise.resolve();
    await Promise.resolve();
    expect(worker.messages.filter((m) => m.type === 'load').length).toBeGreaterThan(1);
  });

  it('rejects predownload when cached bytes cannot start the GPU model', async () => {
    const worker = new FakeWorker({ autoReady: false });
    const mgr = new ClientInferenceManager({
      fetchArticlePolicy: async () => ({ authorized: true, pageId: 42, aiPolicy: 'all', aiPolicyRevision: 0 }),
    createWorker: () => worker as unknown as Worker,
      probe: async () => COMPACT,
      fetchManifest: async () => ({
        enabled: true,
        models: [{
          id: 'qwen2.5-0.5b-instruct-q4',
          kind: 'onnx',
          bytes: 1,
          installed: true,
          available: true,
          files: [{ name: 'config.json', bytes: 1 }],
        }],
      }),
      downloadFile: async () => new Blob(['x']),
      fetchOrgPolicy: async () => INACTIVE_POLICY,
    });
    mgr.setFlags({ adminEnabled: true, userEnabled: true });
    try {
      const downloading = mgr.predownload();
      const rejected = expect(downloading).rejects.toThrow(/could not start/);
      const load = await waitForLoad(worker);
      worker.emit({ id: load.id, type: 'error', code: 'webgpu', message: 'module import failed' });
      await rejected;
      expect(mgr.isReady()).toBe(false);
    } finally {
      mgr.dispose();
    }
  });

  it('probes for a missing browser model once, not on every typing pause', async () => {
    const worker = new FakeWorker();
    const fetchManifest = vi.fn(async () => ({
      enabled: true,
      models: [{
        id: 'qwen2.5-0.5b-instruct-q4',
        kind: 'onnx' as const,
        bytes: 1,
        installed: true,
        available: true,
        files: [{ name: 'config.json', bytes: 1 }],
      }],
    }));
    // No hasCache seam: jsdom has no OPFS, so the real probe reports no model.
    const mgr = new ClientInferenceManager({
      fetchArticlePolicy: async () => ({ authorized: true, pageId: 42, aiPolicy: 'all', aiPolicyRevision: 0 }),
    createWorker: () => worker as unknown as Worker,
      probe: async () => COMPACT,
      fetchManifest,
      downloadFile: async () => new Blob(['x']),
      fetchOrgPolicy: async () => INACTIVE_POLICY,
    });
    mgr.setFlags({ adminEnabled: true, userEnabled: true });
    const args = {
      input: { pageId: 42, prefix: 'The capital of France is ', maxTokens: 8 },
      signal: new AbortController().signal,
      assigned: false,
      withoutServer: true,
      wordMode: true,
    };
    try {
      for (let i = 0; i < 5; i++) {
        expect(await mgr.decideComplete(args)).toEqual({ kind: 'off' });
        await Promise.resolve();
        await Promise.resolve();
      }
      expect(fetchManifest).toHaveBeenCalledTimes(1);
      expect(worker.messages.some((m) => m.type === 'load')).toBe(false);

      // A download in this browser is the one event that changes the verdict.
      await mgr.predownload();
      await vi.waitFor(() => expect(mgr.isReady()).toBe(true));
      expect((await mgr.decideComplete(args)).kind).toBe('local');
    } finally {
      mgr.dispose();
    }
  });

  it('coalesces concurrent load posts', async () => {
    const worker = new FakeWorker({ autoReady: false });
    const mgr = compactManager(worker, true);
    mgr.setFlags({ adminEnabled: true, userEnabled: true });
    const args = {
      input: { pageId: 42, prefix: 'Rotate the', maxTokens: 48 },
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
      fetchArticlePolicy: async () => ({ authorized: true, pageId: 42, aiPolicy: 'all', aiPolicyRevision: 0 }),
    createWorker: () => worker as unknown as Worker,
      probe: async () => COMPACT,
      hasCache: async () => true,
      accessToken: () => 'tok-9',
      fetchOrgPolicy: async () => INACTIVE_POLICY,
    });
    mgr.setFlags({ adminEnabled: true, userEnabled: true });
    await mgr.decideComplete({
      input: { pageId: 42, prefix: 'Rotate the', maxTokens: 48 },
      signal: new AbortController().signal,
      assigned: true,
      withoutServer: true,
      wordMode: false,
    });
    expect(await waitForLoad(worker)).toMatchObject({
      type: 'load',
      accessToken: 'tok-9',
    });
  });

  it('loads the active Hub model id from the manifest', async () => {
    const worker = new FakeWorker({ autoReady: false });
    const mgr = new ClientInferenceManager({
      fetchArticlePolicy: async () => ({ authorized: true, pageId: 42, aiPolicy: 'all', aiPolicyRevision: 0 }),
    createWorker: () => worker as unknown as Worker,
      probe: async () => COMPACT,
      hasCache: async () => true,
      fetchManifest: async () => ({
        enabled: true,
        activeModelId: 'HuggingFaceTB--SmolLM2-135M-Instruct',
        models: [{
          id: 'HuggingFaceTB--SmolLM2-135M-Instruct',
          kind: 'onnx',
          bytes: 1,
          installed: true,
          available: true,
          files: [{ name: 'config.json', bytes: 1 }],
        }],
      }),
      fetchOrgPolicy: async () => INACTIVE_POLICY,
    });
    mgr.setFlags({ adminEnabled: true, userEnabled: true });
    await mgr.decideComplete({
      input: { pageId: 42, prefix: 'Rotate the', maxTokens: 48 },
      signal: new AbortController().signal,
      assigned: true,
      withoutServer: true,
      wordMode: false,
    });
    expect(await waitForLoad(worker)).toMatchObject({
      type: 'load',
      modelId: 'HuggingFaceTB--SmolLM2-135M-Instruct',
    });
  });

  it('reports whether the model is downloaded and clears it cleanly', async () => {
    const worker = new FakeWorker();
    let cached = true;
    const mgr = new ClientInferenceManager({
      fetchArticlePolicy: async () => ({ authorized: true, pageId: 42, aiPolicy: 'all', aiPolicyRevision: 0 }),
    createWorker: () => worker as unknown as Worker,
      probe: async () => COMPACT,
      hasCache: async () => cached,
    });
    expect(await mgr.isModelDownloaded()).toBe(true);
    cached = false;
    expect(await mgr.isModelDownloaded()).toBe(false);
  });

  it('does not start the worker when org policy is disabled_server_only', async () => {
    const worker = new FakeWorker();
    const mgr = compactManager(worker, true, async () => ({
      active: true,
      mode: 'disabled_server_only',
      allowedModels: [],
      enforceWebGpuOnly: false,
    }));
    mgr.setFlags({ adminEnabled: true, userEnabled: true });
    const decision = await mgr.decideComplete({
      input: { pageId: 42, prefix: 'hello ', suffix: '', maxTokens: 16 },
      signal: new AbortController().signal,
      assigned: true,
      withoutServer: true,
      wordMode: false,
    });
    expect(decision.kind).toBe('server');
    expect(worker.messages.some((m) => m.type === 'complete')).toBe(false);
  });

  it('refuses server fallback for mandated_offline_only when local is not ready', async () => {
    const worker = new FakeWorker({ autoReady: false });
    const mgr = compactManager(worker, false, async () => ({
      active: true,
      mode: 'mandated_offline_only',
      allowedModels: [],
      enforceWebGpuOnly: false,
    }));
    mgr.setFlags({ adminEnabled: true, userEnabled: true });
    const decision = await mgr.decideComplete({
      input: { pageId: 42, prefix: 'hello ', suffix: '', maxTokens: 16 },
      signal: new AbortController().signal,
      assigned: true,
      withoutServer: true,
      wordMode: false,
    });
    expect(decision.kind).toBe('off');
  });

  it('runs mandated_offline_only locally when the worker is ready', async () => {
    const worker = new FakeWorker();
    const mgr = compactManager(worker, true, async () => ({
      active: true,
      mode: 'mandated_offline_only',
      allowedModels: [],
      enforceWebGpuOnly: false,
    }));
    mgr.setFlags({ adminEnabled: true, userEnabled: true });
    const first = await mgr.decideComplete({
      input: { pageId: 42, prefix: 'hello ', suffix: '', maxTokens: 16 },
      signal: new AbortController().signal,
      assigned: true,
      withoutServer: false,
      wordMode: false,
    });
    expect(first.kind).toBe('off');
    await Promise.resolve();
    await Promise.resolve();
    const decision = await mgr.decideComplete({
      input: { pageId: 42, prefix: 'hello ', suffix: '', maxTokens: 16 },
      signal: new AbortController().signal,
      assigned: true,
      withoutServer: false,
      wordMode: false,
    });
    expect(decision.kind).toBe('local');
  });

  it('refuses predownload when org policy disables on-device inference', async () => {
    const worker = new FakeWorker();
    const mgr = compactManager(worker, true, async () => ({
      active: true,
      mode: 'disabled_server_only',
      allowedModels: [],
      enforceWebGpuOnly: false,
    }));
    await expect(mgr.predownload()).rejects.toThrow(/disabled by organization policy/);
  });
  it('treats a missing policy endpoint as allowed', async () => {
    const worker = new FakeWorker();
    const mgr = new ClientInferenceManager({
      fetchArticlePolicy: async () => ({ authorized: true, pageId: 42, aiPolicy: 'all', aiPolicyRevision: 0 }),
    createWorker: () => worker as unknown as Worker,
      probe: async () => COMPACT,
      hasCache: async () => true,
      fetchOrgPolicy: async () => {
        throw new ApiError(404, 'Not Found');
      },
    });
    mgr.setFlags({ adminEnabled: true, userEnabled: true });
    await mgr.decideComplete({
      input: { pageId: 42, prefix: 'hello ', suffix: '', maxTokens: 16 },
      signal: new AbortController().signal,
      assigned: true,
      withoutServer: true,
      wordMode: false,
    });
    await Promise.resolve();
    await Promise.resolve();
    const decision = await mgr.decideComplete({
      input: { pageId: 42, prefix: 'hello ', suffix: '', maxTokens: 16 },
      signal: new AbortController().signal,
      assigned: true,
      withoutServer: true,
      wordMode: false,
    });
    expect(decision.kind).toBe('local');
  });

  it('fails closed to disabled_server_only when the policy read errors', async () => {
    const worker = new FakeWorker();
    const mgr = new ClientInferenceManager({
      fetchArticlePolicy: async () => ({ authorized: true, pageId: 42, aiPolicy: 'all', aiPolicyRevision: 0 }),
    createWorker: () => worker as unknown as Worker,
      probe: async () => COMPACT,
      hasCache: async () => true,
      fetchOrgPolicy: async () => {
        throw new ApiError(503, 'unavailable');
      },
    });
    mgr.setFlags({ adminEnabled: true, userEnabled: true });
    const decision = await mgr.decideComplete({
      input: { pageId: 42, prefix: 'hello ', suffix: '', maxTokens: 16 },
      signal: new AbortController().signal,
      assigned: true,
      withoutServer: true,
      wordMode: false,
    });
    expect(decision.kind).toBe('server');
    expect(worker.messages.some((m) => m.type === 'complete')).toBe(false);
  });

  it('treats an empty policy payload as allowed', async () => {
    const worker = new FakeWorker();
    const mgr = new ClientInferenceManager({
      fetchArticlePolicy: async () => ({ authorized: true, pageId: 42, aiPolicy: 'all', aiPolicyRevision: 0 }),
    createWorker: () => worker as unknown as Worker,
      probe: async () => COMPACT,
      hasCache: async () => true,
      fetchOrgPolicy: async () => undefined as unknown as ClientInferenceOrgPolicy,
    });
    expect(() => mgr.setFlags({ adminEnabled: true, userEnabled: true })).not.toThrow();
    await mgr.refreshOrgPolicy();
    expect(mgr.orgPolicySnapshot()).toEqual(INACTIVE_POLICY);
  });
});

describe('ClientInferenceManager active-model switch (#1812)', () => {
  const MODEL_A = 'onnx-community--Qwen2.5-0.5B-Instruct';
  const MODEL_B = 'HuggingFaceTB--SmolLM2-135M-Instruct';
  const COMPLETE = {
    input: { pageId: 42, prefix: 'Rotate the', maxTokens: 48 },
    assigned: true,
    withoutServer: true,
    wordMode: false,
  };

  function switchableManager(worker: FakeWorker) {
    const selection = { active: MODEL_A };
    const mgr = new ClientInferenceManager({
      fetchArticlePolicy: async () => ({ authorized: true, pageId: 42, aiPolicy: 'all', aiPolicyRevision: 0 }),
      createWorker: () => worker as unknown as Worker,
      probe: async () => COMPACT,
      hasCache: async () => true,
      fetchManifest: async () => ({
        enabled: true,
        activeModelId: selection.active,
        models: [MODEL_A, MODEL_B].map((id) => ({
          id, kind: 'onnx' as const, bytes: 1, installed: true, available: true,
          files: [{ name: 'config.json', bytes: 1 }],
        })),
      }),
      downloadFile: async () => new Blob(['x']),
      fetchOrgPolicy: async () => INACTIVE_POLICY,
    });
    mgr.setFlags({ adminEnabled: true, userEnabled: true });
    return { mgr, selection };
  }

  const summary = (worker: FakeWorker) => worker.messages
    .filter((m) => m.type !== 'abort')
    .map((m) => (m.type === 'load' ? `load:${m.modelId}` : m.type));

  it('reloads the newly active model, unloads the old one and reports it', async () => {
    const worker = new FakeWorker();
    const { mgr, selection } = switchableManager(worker);
    await mgr.decideComplete({ ...COMPLETE, signal: new AbortController().signal });
    await vi.waitFor(() => expect(mgr.isReady()).toBe(true));
    expect(mgr.loadedModel()).toBe(MODEL_A);

    selection.active = MODEL_B;
    await mgr.predownload();
    expect(mgr.isReady()).toBe(true);
    expect(mgr.loadedModel()).toBe(MODEL_B);

    const decision = await mgr.decideComplete({ ...COMPLETE, signal: new AbortController().signal });
    expect(decision).toMatchObject({ kind: 'local', response: { model: `client:${MODEL_B}` } });
    expect(summary(worker)).toEqual([`load:${MODEL_A}`, 'unload', `load:${MODEL_B}`, 'complete']);
  });

  it('never lets a superseded in-flight load become ready', async () => {
    const worker = new FakeWorker({ autoReady: false });
    const { mgr, selection } = switchableManager(worker);
    await mgr.decideComplete({ ...COMPLETE, signal: new AbortController().signal });
    const loadA = await waitForLoad(worker);

    selection.active = MODEL_B;
    let downloaded = false;
    const downloading = mgr.predownload().then(() => { downloaded = true; });
    await vi.waitFor(() => expect(summary(worker)).toContain(`load:${MODEL_B}`));
    const loadB = worker.messages.filter((m) => m.type === 'load').at(-1)!;

    worker.emit({ id: loadA.id, type: 'ready', modelId: MODEL_A });
    await Promise.resolve();
    expect(mgr.isReady()).toBe(false);
    expect(mgr.loadedModel()).toBeNull();
    expect(downloaded).toBe(false);

    worker.emit({ id: loadB.id, type: 'ready', modelId: MODEL_B });
    await downloading;
    expect(mgr.isReady()).toBe(true);
    expect(mgr.loadedModel()).toBe(MODEL_B);
  });

  it('keeps a ready model when the active selection did not change', async () => {
    const worker = new FakeWorker();
    const { mgr } = switchableManager(worker);
    await mgr.decideComplete({ ...COMPLETE, signal: new AbortController().signal });
    await vi.waitFor(() => expect(mgr.isReady()).toBe(true));
    await mgr.predownload();
    expect(summary(worker)).toEqual([`load:${MODEL_A}`]);
    expect(mgr.loadedModel()).toBe(MODEL_A);
  });
});
