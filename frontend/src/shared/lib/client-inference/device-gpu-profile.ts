export type GpuTier = 'high' | 'medium' | 'low' | 'unsupported';

export interface DeviceGpuProfile {
  hasWebGPU: boolean;
  adapterName?: string;
  maxBufferSize?: number;
  tier: GpuTier;
  recommendedModelTier: 'compact' | 'server_only';
}

const LOW_BUFFER_BYTES = 256 * 1024 * 1024;
const HIGH_BUFFER_BYTES = 1024 * 1024 * 1024;

export const UNSUPPORTED_GPU_PROFILE: DeviceGpuProfile = {
  hasWebGPU: false,
  tier: 'unsupported',
  recommendedModelTier: 'server_only',
};

type GpuNavigator = Navigator & {
  gpu?: {
    requestAdapter: () => Promise<{
      limits?: { maxBufferSize?: number };
      info?: { device?: string; description?: string };
    } | null>;
  };
};

export async function probeDeviceGpu(): Promise<DeviceGpuProfile> {
  try {
    const gpu = (navigator as GpuNavigator).gpu;
    if (!gpu?.requestAdapter) return { ...UNSUPPORTED_GPU_PROFILE };
    const adapter = await gpu.requestAdapter();
    if (!adapter) return { ...UNSUPPORTED_GPU_PROFILE };
    const maxBufferSize = adapter.limits?.maxBufferSize;
    const adapterName = adapter.info?.device || adapter.info?.description;
    let tier: GpuTier = 'high';
    if (!maxBufferSize || maxBufferSize < LOW_BUFFER_BYTES) tier = 'low';
    else if (maxBufferSize < HIGH_BUFFER_BYTES) tier = 'medium';
    return {
      hasWebGPU: true,
      adapterName: adapterName || undefined,
      maxBufferSize,
      tier,
      recommendedModelTier: tier === 'low' ? 'server_only' : 'compact',
    };
  } catch {
    return { ...UNSUPPORTED_GPU_PROFILE };
  }
}
