import { ClientModelIdSchema, type ClientAssetManifest, type ClientModelId, type InlineCompletionRequest, type InlineCompletionResponse } from '@compendiq/contracts';
import { apiFetch, apiFetchBlob } from '../api';
import { useAuthStore } from '../../../stores/auth-store';
import { probeDeviceGpu, type DeviceGpuProfile } from './device-gpu-profile';
import { capMaxTokens, normalizeInlineCompletion } from './instruct-format';
import { clearOpfsModel, hasOpfsModel, putOpfsFile } from './opfs-model-cache';
import {
  CLIENT_INFERENCE_MODEL_ID,
  IDLE_UNLOAD_MS,
  LOCAL_COMPLETION_MODEL,
  LOCAL_COMPLETION_PROVIDER,
  type ClientInferenceErrorCode,
  type WorkerEvent,
  type WorkerRequest,
} from './worker-protocol';

export type CompleteDecision =
  | { kind: 'local'; response: InlineCompletionResponse }
  | { kind: 'server' }
  | { kind: 'off' };

export type RewriteDecision =
  | { kind: 'local'; text: string }
  | { kind: 'server' };

export interface ClientInferenceManagerOptions {
  createWorker?: () => Worker;
  probe?: () => Promise<DeviceGpuProfile>;
  hasCache?: () => Promise<boolean>;
  fetchManifest?: () => Promise<ClientAssetManifest>;
  downloadFile?: (modelId: string, file: string) => Promise<Blob>;
  accessToken?: () => string | null;
  now?: () => number;
}

let singleton: ClientInferenceManager | null = null;

function activeOnnxId(manifest: ClientAssetManifest): ClientModelId {
  if (manifest.activeModelId) return manifest.activeModelId;
  const onnx = manifest.models.find((m) => m.kind === 'onnx' && m.installed);
  const parsed = onnx ? ClientModelIdSchema.safeParse(onnx.id) : null;
  return parsed?.success ? parsed.data : CLIENT_INFERENCE_MODEL_ID;
}
export function getClientInferenceManager(): ClientInferenceManager {
  singleton ??= new ClientInferenceManager({
    fetchManifest: () => apiFetch<ClientAssetManifest>('/models/client-assets'),
  });
  return singleton;
}

export function resetClientInferenceManager(): void {
  singleton?.dispose();
  singleton = null;
}

export class ClientInferenceManager {
  private worker: Worker | null = null;
  private ready = false;
  private probeCache: DeviceGpuProfile | null = null;
  private lastError: { code: ClientInferenceErrorCode; at: number } | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending = new Map<string, {
    resolve: (text: string) => void;
    reject: (err: Error) => void;
  }>();
  private readonly aborted = new Set<string>();
  private seq = 0;
  private adminEnabled = false;
  private userEnabled = false;
  private visibilityHandler: (() => void) | null = null;
  private loadWaiters: Array<() => void> = [];
  private loadInFlight: Promise<void> | null = null;
  private loadFailed = false;

  constructor(private readonly opts: ClientInferenceManagerOptions = {}) {}

  setFlags(flags: { adminEnabled: boolean; userEnabled: boolean }): void {
    this.adminEnabled = flags.adminEnabled;
    this.userEnabled = flags.userEnabled;
    if (!this.canUseGpu()) this.teardownWorker();
  }

  isReady(): boolean {
    return this.ready && this.canUseGpu();
  }

  lastProbe(): DeviceGpuProfile | null {
    return this.probeCache;
  }

  lastErrorCategory(): ClientInferenceErrorCode | null {
    return this.lastError?.code ?? null;
  }

  async ensureProbed(): Promise<DeviceGpuProfile> {
    if (this.probeCache) return this.probeCache;
    const probe = this.opts.probe ?? probeDeviceGpu;
    this.probeCache = await probe();
    return this.probeCache;
  }

  canUseGpu(): boolean {
    return this.adminEnabled
      && this.userEnabled
      && (this.probeCache?.recommendedModelTier ?? 'server_only') === 'compact';
  }

  decideGhostAvailability(assigned: boolean, withoutServer: boolean): boolean {
    if (assigned) return true;
    return this.userEnabled && withoutServer && this.isReady();
  }

  async decideComplete(args: {
    input: InlineCompletionRequest;
    signal: AbortSignal;
    assigned: boolean;
    withoutServer: boolean;
    wordMode: boolean;
  }): Promise<CompleteDecision> {
    if (!this.userEnabled) return { kind: args.assigned ? 'server' : 'off' };
    if (!args.assigned && !args.withoutServer) return { kind: 'off' };
    await this.ensureProbed();
    if (!this.canUseGpu()) {
      return { kind: args.assigned ? 'server' : 'off' };
    }
    if (!this.ready) {
      void this.maybeStartLoad();
      return { kind: args.assigned ? 'server' : 'off' };
    }
    const text = await this.requestWorker({
      id: this.nextId(),
      type: 'complete',
      prefix: args.input.prefix,
      suffix: args.input.suffix,
      maxTokens: capMaxTokens(args.input.maxTokens ?? 48, args.wordMode),
    }, args.signal);
    if (text == null) return { kind: args.assigned ? 'server' : 'off' };
    const completion = normalizeInlineCompletion(text);
    if (!completion) return { kind: args.assigned ? 'server' : 'off' };
    this.armIdleUnload();
    return {
      kind: 'local',
      response: {
        completion,
        model: LOCAL_COMPLETION_MODEL,
        provider: LOCAL_COMPLETION_PROVIDER,
      },
    };
  }

  async decideRewrite(args: {
    text: string;
    task: 'grammar' | 'clarity' | 'completeness';
    instruction?: string;
    signal: AbortSignal;
  }): Promise<RewriteDecision> {
    if (!this.userEnabled || !this.adminEnabled) return { kind: 'server' };
    await this.ensureProbed();
    if (!this.canUseGpu() || !this.ready) {
      void this.maybeStartLoad();
      return { kind: 'server' };
    }
    const text = await this.requestWorker({
      id: this.nextId(),
      type: 'rewrite',
      task: args.task,
      instruction: args.instruction,
      text: args.text,
    }, args.signal);
    if (text == null) return { kind: 'server' };
    if (/<[a-z][\s\S]*>/i.test(text) || /^\s*(sure|here|i have rewritten)/i.test(text)) {
      return { kind: 'server' };
    }
    this.armIdleUnload();
    return { kind: 'local', text };
  }

  async predownload(onProgress?: (loaded: number, total: number) => void): Promise<void> {
    const fetchManifest = this.opts.fetchManifest
      ?? (() => apiFetch<ClientAssetManifest>('/models/client-assets'));
    const downloadFile = this.opts.downloadFile
      ?? ((modelId: string, file: string) => apiFetchBlob(`/models/client-assets/${modelId}/${file}`));
    const manifest = await fetchManifest();
    const modelId = activeOnnxId(manifest);
    const onnx = manifest.models.find((m) => m.id === modelId);
    if (!onnx || onnx.files.length === 0) {
      throw new Error('On-device model is not installed on the server');
    }
    const total = onnx.files.reduce((sum, f) => sum + f.bytes, 0) || 1;
    let loaded = 0;
    onProgress?.(0, total);
    for (const file of onnx.files) {
      const blob = await downloadFile(onnx.id, file.name);
      await putOpfsFile(onnx.id, file.name, blob);
      loaded += file.bytes;
      onProgress?.(loaded, total);
    }
    this.loadFailed = false;
    await this.startLoad();
  }
  async isModelDownloaded(modelId?: string, files?: string[]): Promise<boolean> {
    if (this.opts.hasCache) {
      return this.opts.hasCache();
    }
    const resolvedId = modelId ?? (this.opts.fetchManifest
      ? activeOnnxId(await this.opts.fetchManifest())
      : CLIENT_INFERENCE_MODEL_ID);
    return hasOpfsModel(resolvedId, files);
  }

  async clearDownloadedModel(modelId?: string): Promise<void> {
    const resolvedId = modelId ?? (this.opts.fetchManifest
      ? activeOnnxId(await this.opts.fetchManifest())
      : CLIENT_INFERENCE_MODEL_ID);
    await clearOpfsModel(resolvedId);
    this.ready = false;
    this.teardownWorker();
  }


  dispose(): void {
    this.teardownWorker();
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }

  private async maybeStartLoad(): Promise<void> {
    if (this.loadFailed) return;
    if (this.opts.hasCache) {
      if (await this.opts.hasCache()) await this.startLoad();
      return;
    }
    const modelId = this.opts.fetchManifest
      ? activeOnnxId(await this.opts.fetchManifest())
      : CLIENT_INFERENCE_MODEL_ID;
    if (await hasOpfsModel(modelId)) await this.startLoad();
  }

  private async startLoad(): Promise<void> {
    if (this.loadFailed) return;
    if (this.ready) return;
    if (this.loadInFlight) return this.loadInFlight;
    this.loadInFlight = this.runLoad();
    return this.loadInFlight;
  }

  private async runLoad(): Promise<void> {
    try {
      await this.ensureProbed();
      if (!this.canUseGpu() || this.ready) return;
      this.ensureWorker();
      const id = this.nextId();
      const done = new Promise<void>((resolve) => {
        this.loadWaiters.push(resolve);
      });
      const token = this.opts.accessToken?.() ?? useAuthStore.getState().accessToken;
      const modelId = this.opts.fetchManifest
        ? activeOnnxId(await this.opts.fetchManifest())
        : CLIENT_INFERENCE_MODEL_ID;
      this.post({
        id,
        type: 'load',
        modelId,
        ...(token ? { accessToken: token } : {}),
      });
      await done;
    } finally {
      this.loadInFlight = null;
    }
  }


  private settleLoad(): void {
    const waiters = this.loadWaiters;
    this.loadWaiters = [];
    for (const waiter of waiters) waiter();
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const create = this.opts.createWorker ?? (() => new Worker(
      new URL('./client-inference.worker.ts', import.meta.url),
      { type: 'module' },
    ));
    const worker = create();
    worker.onmessage = (event: MessageEvent<WorkerEvent>) => this.onWorkerEvent(event.data);
    this.worker = worker;
    if (!this.visibilityHandler && typeof document !== 'undefined') {
      this.visibilityHandler = () => {
        if (document.visibilityState === 'hidden') this.unload();
      };
      document.addEventListener('visibilitychange', this.visibilityHandler);
    }
    return worker;
  }

  private onWorkerEvent(event: WorkerEvent): void {
    if (event.type === 'ready') {
      this.ready = true;
      this.settleLoad();
      return;
    }
    if (event.type === 'error') {
      this.lastError = { code: event.code, at: Date.now() };
      if (event.code === 'load' || event.code === 'webgpu' || event.code === 'oom') {
        this.ready = false;
        this.loadFailed = true;
        this.settleLoad();
      }
      const pending = this.pending.get(event.id);
      if (pending) {
        this.pending.delete(event.id);
        pending.reject(new Error(event.message));
      }
      return;
    }
    if (event.type === 'result') {
      if (this.aborted.has(event.id)) return;
      const pending = this.pending.get(event.id);
      if (pending) {
        this.pending.delete(event.id);
        pending.resolve(event.text);
      }
    }
  }

  private requestWorker(request: WorkerRequest, signal: AbortSignal): Promise<string | null> {
    if (signal.aborted) return Promise.resolve(null);
    this.ensureWorker();
    return new Promise((resolve) => {
      const onAbort = () => {
        this.aborted.add(request.id);
        this.post({ id: this.nextId(), type: 'abort', targetId: request.id });
        this.pending.delete(request.id);
        resolve(null);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(request.id, {
        resolve: (text) => {
          signal.removeEventListener('abort', onAbort);
          resolve(text);
        },
        reject: () => {
          signal.removeEventListener('abort', onAbort);
          resolve(null);
        },
      });
      this.post(request);
    });
  }

  private post(request: WorkerRequest): void {
    this.worker?.postMessage(request);
  }

  private unload(): void {
    this.ready = false;
    this.post({ id: this.nextId(), type: 'unload' });
    this.clearIdle();
  }

  private teardownWorker(): void {
    this.loadFailed = false;
    this.unload();
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const waiter of pending) waiter.reject(new Error('worker torn down'));
    this.settleLoad();
    this.worker?.terminate();
    this.worker = null;
  }

  private armIdleUnload(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => this.unload(), IDLE_UNLOAD_MS);
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private nextId(): string {
    this.seq += 1;
    return `ci-${this.seq}`;
  }
}

export async function requestInlineCompletionWithClient(args: {
  input: InlineCompletionRequest;
  signal: AbortSignal;
  assigned: boolean;
  withoutServer: boolean;
  wordMode: boolean;
  serverRequest: (
    input: InlineCompletionRequest,
    signal: AbortSignal,
  ) => Promise<InlineCompletionResponse | undefined>;
}): Promise<InlineCompletionResponse | undefined> {
  const decision = await getClientInferenceManager().decideComplete(args);
  if (decision.kind === 'local') return decision.response;
  if (decision.kind === 'off') return undefined;
  return args.serverRequest(args.input, args.signal);
}
