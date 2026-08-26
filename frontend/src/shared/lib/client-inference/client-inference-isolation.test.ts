import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ClientModelIdSchema } from '@compendiq/contracts';

const here = dirname(fileURLToPath(import.meta.url));

function read(rel: string): string {
  return readFileSync(resolve(here, rel), 'utf8');
}

describe('client inference isolation (#1418 SPEC-039/011/016)', () => {
  it('does not mention huggingface or onnxruntime from the editor graph', () => {
    const editor = read('../../../shared/components/article/Editor.tsx');
    const extension = read('../../../shared/components/article/InlineCompletionExtension.ts');
    expect(editor).not.toMatch(/huggingface|onnxruntime/i);
    expect(extension).not.toMatch(/huggingface|onnxruntime/i);
  });

  it('does not set COEP', () => {
    const nginx = read('../../../../nginx-security-headers.conf');
    expect(nginx).not.toMatch(/Cross-Origin-Embedder-Policy/i);
  });

  it('pins ClientModelIdSchema to the one instruct checkpoint', () => {
    expect(ClientModelIdSchema.options).toEqual(['qwen2.5-0.5b-instruct-q4']);
  });

  it('keeps transformers.js inside the inference worker only', () => {
    expect(read('./client-inference.worker.ts')).toMatch(/@huggingface\/transformers/);
    expect(read('./client-inference-manager.ts')).not.toMatch(/@huggingface\/transformers/);
  });

  it('skips the onnxruntime-node CUDA nuget download on npm ci', () => {
    // linux/x64 postinstall otherwise fetches Microsoft.ML.OnnxRuntime.Gpu.Linux
    // from nuget.org; CI/Docker must stay green without that (#1418).
    const workflow = read('../../../../../.github/workflows/pr-check.yml');
    const dockerfile = read('../../../../../frontend/Dockerfile');
    expect(workflow).toMatch(/ONNXRUNTIME_NODE_INSTALL:\s*skip/);
    expect(dockerfile).toMatch(/ENV ONNXRUNTIME_NODE_INSTALL=skip/);
  });

  it('serializes complete/rewrite instead of overlapping generator() calls', () => {
    const worker = read('./client-inference.worker.ts');
    expect(worker).toMatch(/chain = chain\.then/);
    expect(worker).not.toMatch(/void onRequest\(event\.data\)/);
  });

  it('sets ORT wasmPaths to same-origin Vite URLs and never names a CDN', () => {
    const worker = read('./client-inference.worker.ts');
    const env = read('./configure-client-inference-env.ts');
    const urls = read('./ort-wasm-urls.ts');
    expect(worker).toMatch(/configureClientInferenceEnv/);
    expect(env).toMatch(/wasmPaths/);
    expect(urls).toMatch(/onnxruntime-web/);
    expect(urls).toMatch(/\?url/);
    expect(`${worker}\n${env}\n${urls}`).not.toMatch(/jsdelivr|huggingface\.co/i);
  });

  it('imports ORT jsep wasm through the package exports map, not a deep /dist/ path', () => {
    // Vite 8 / Rolldown honours exports. `onnxruntime-web/dist/...` is
    // `./dist/...` in the map, which is not exported, so `vite build`
    // (frontend Docker image) fails with "is not exported under the
    // conditions [module, browser, production, import]".
    const urls = read('./ort-wasm-urls.ts');
    expect(urls).not.toMatch(/onnxruntime-web\/dist\//);
    const specifiers = [...urls.matchAll(/from 'onnxruntime-web\/([^']+)\?url'/g)].map(
      (match) => match[1],
    );
    expect(specifiers).toEqual([
      'ort-wasm-simd-threaded.jsep.mjs',
      'ort-wasm-simd-threaded.jsep.wasm',
    ]);
    const pkg = JSON.parse(
      readFileSync(resolve(here, '../../../../../node_modules/onnxruntime-web/package.json'), 'utf8'),
    ) as { exports: Record<string, unknown> };
    for (const spec of specifiers) {
      expect(pkg.exports[`./${spec}`], `${spec} must be a package export`).toBeTruthy();
    }
  });

  it('runs a production frontend build in PR Check, not only in the Docker image', () => {
    const workflow = read('../../../../../.github/workflows/pr-check.yml');
    expect(workflow).toMatch(/npm run build -w frontend/);
  });
});
