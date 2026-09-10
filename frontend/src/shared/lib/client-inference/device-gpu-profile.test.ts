import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeDeviceGpu } from './device-gpu-profile';

describe('probeDeviceGpu (#1418 SPEC-037)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('never throws when WebGPU is missing', async () => {
    vi.stubGlobal('navigator', { gpu: undefined });
    await expect(probeDeviceGpu()).resolves.toMatchObject({
      hasWebGPU: false,
      tier: 'unsupported',
      recommendedModelTier: 'server_only',
    });
  });

  it('never throws when requestAdapter rejects', async () => {
    vi.stubGlobal('navigator', {
      gpu: { requestAdapter: () => Promise.reject(new Error('nope')) },
    });
    await expect(probeDeviceGpu()).resolves.toMatchObject({ recommendedModelTier: 'server_only' });
  });

  it('marks a tiny buffer as low / server_only', async () => {
    vi.stubGlobal('navigator', {
      gpu: {
        requestAdapter: async () => ({
          limits: { maxBufferSize: 1024 },
          info: { device: 'tiny' },
        }),
      },
    });
    await expect(probeDeviceGpu()).resolves.toMatchObject({
      hasWebGPU: true,
      tier: 'low',
      recommendedModelTier: 'server_only',
    });
  });

  it('recommends compact on a medium adapter', async () => {
    vi.stubGlobal('navigator', {
      gpu: {
        requestAdapter: async () => ({
          limits: { maxBufferSize: 512 * 1024 * 1024 },
          info: { device: 'gpu' },
        }),
      },
    });
    await expect(probeDeviceGpu()).resolves.toMatchObject({
      tier: 'medium',
      recommendedModelTier: 'compact',
    });
  });
});
