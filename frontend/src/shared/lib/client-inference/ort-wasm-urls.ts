// Match Transformers v4's onnxruntime-web/webgpu backend: it uses the
// asyncify runtime, not the older JSEP module (which lacks webgpuInit).
// Use package exports so Vite emits both files as same-origin assets.
import wasmMjs from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';
import wasmBinary from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';

export function ortWasmPaths(): { mjs: string; wasm: string } {
  return { mjs: wasmMjs, wasm: wasmBinary };
}
