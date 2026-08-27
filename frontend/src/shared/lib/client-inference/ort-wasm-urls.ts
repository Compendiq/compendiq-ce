// onnxruntime-web exports these as `./ort-wasm-simd-threaded.jsep.{mjs,wasm}`,
// not `./dist/...`. Vite 8 / Rolldown honours the map, so a deep /dist/
// import fails `vite build` (the frontend Docker image).
import jsepMjs from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs?url';
import jsepWasm from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url';

export function ortWasmPaths(): { mjs: string; wasm: string } {
  return { mjs: jsepMjs, wasm: jsepWasm };
}
