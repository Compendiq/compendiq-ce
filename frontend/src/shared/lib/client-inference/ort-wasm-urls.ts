import jsepMjs from 'onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs?url';
import jsepWasm from 'onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url';

export function ortWasmPaths(): { mjs: string; wasm: string } {
  return { mjs: jsepMjs, wasm: jsepWasm };
}
