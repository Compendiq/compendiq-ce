# Client inference (WebGPU + Hunspell)

On-device editor micro-tasks for #1418 / ADR-026. The browser never talks to
`huggingface.co`. CI and the frontend image set `ONNXRUNTIME_NODE_INSTALL=skip`
so `onnxruntime-node`'s linux postinstall does not fetch CUDA EP binaries from
nuget.org — weights are operator-copied onto the volume, not fetched at
install time. On a Linux host, export the same variable before `npm ci`.

## Layout

Hub installs land at `org--name`, e.g.
`/app/data/client-models/onnx-community--Qwen2.5-0.5B-Instruct/`. The original
`qwen2.5-0.5b-instruct-q4/` layout is still served if present.

```
/app/data/client-models/<local-id>/
  config.json
  tokenizer.json
  tokenizer_config.json
  onnx/model_q4.onnx
```

Hunspell dictionaries (do **not** vendor GPL German igerman98 in git):

```
/app/data/client-models/hunspell-en_US/en_US.aff
/app/data/client-models/hunspell-en_US/en_US.dic
/app/data/client-models/hunspell-de_DE/de_DE.aff
/app/data/client-models/hunspell-de_DE/de_DE.dic
```

Override the root with `CLIENT_MODEL_ASSETS_DIR` if needed. The directory is
on the existing `attachments` volume (`/app/data`). `client-models` is also a
reserved attachment-root name so the #1349 sweep cannot delete a copy placed
under `ATTACHMENTS_DIR`.

## Enable

1. Settings → AI Models → Client inference → pick a recommended (or searched)
   transformers.js text-generation model → **Download model**. The **server**
   fetches Hugging Face; the browser does not. Air-gapped: copy onto the volume
   (this runbook) or upload allow-listed files (8 MiB chunks).
2. Enable the admin flag (blocked until ONNX `installed`).
3. Each author: Settings → Editor → On-device suggestions, then
   **Pre-download on-device model** in *that* browser (OPFS is per-browser).
4. Spellcheck is independent of WebGPU. Enable it on the same Editor card
   once the dictionaries are on the volume. Hunspell is upload-only (do not
   auto-fetch igerman98).

## Behaviour

- Warm ghost text reads OPFS in the worker (same-origin ORT WASM, no jsDelivr).
- Cold cache, missing GPU, or flags off equals #1417 (`POST /llm/inline-completion`).
- ImprovePanel uses the worker when ready, otherwise `POST /llm/improve`.
- Unassigned `inline_completion` plus “Use on-device suggestions when no
  server model is assigned” (default on) allows local ghost text only when
  the worker is ready.

## Server suggestions return no text

An assigned server model does not require WebGPU or an on-device download.
Check Settings → AI Models → LLM providers → Inline completion against the
provider's current `/v1/models` list. A stale model ID can be silently routed
to a different loaded model by the server; a saved assignment alone does not
prove which model actually ran.

For chat-based inline completion, `message.content` must contain the visible
continuation. Reasoning is not suggestion text: a reasoning-enabled server
can hit the newline stop or spend the 8-token word / 48-token full budget
before producing any content. The first request sends `think: false` and
`chat_template_kwargs.enable_thinking: false` to tolerant providers. If that
reply carries no visible text, the backend retries ONCE with
`reasoning_effort: "none"` added — LM Studio can require it even when it
accepts the first two. Strict OpenAI, Azure OpenAI, and hosted DeepSeek
endpoints get neither hint and no retry.

`reasoning_effort` is retry-only because tolerant hosts parse and validate
it rather than ignore it: vLLM 0.10–0.12 reject `"none"` with a 400, and
newer vLLM forwards it into the chat template, where a template that lists
other values (Qwen3.x) raises and surfaces as a 500. On the retry both
outcomes are swallowed — the author gets the empty first reply, and the
failure does not count against the provider's circuit breaker. Diagnose it
at `LOG_LEVEL=debug` (`inline completion: reasoning_effort retry failed`).
On such a host every suggestion after an empty reply costs a second bounded
request; upgrading vLLM, or assigning a model whose template does not
validate the field, removes that cost.

Do not remove the stop rules, expose reasoning as ghost text, increase the
token budget, or move `reasoning_effort` onto the first request to work
around this. Deploy the corrected backend and select a model the server
actually serves; no frontend rebuild is needed for this fix.

## CSP

nginx grants `script-src 'wasm-unsafe-eval'` and `worker-src 'self'`.
`connect-src` stays `'self'`. Do not add Hugging Face hosts.

## Native dependency security overrides

The root manifest scopes two overrides to `@huggingface/transformers@4.2.0`:

- `sharp` 0.34.5 → 0.35.4, including its platform binaries and libheif 1.23.2,
  addresses [GHSA-f88m-g3jw-g9cj](https://github.com/advisories/GHSA-f88m-g3jw-g9cj)
  and [GHSA-rgj7-g3m4-5g8c](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c).
- `onnxruntime-node@1.24.3` → `adm-zip` 0.5.18 → 0.6.0 addresses
  [GHSA-xcpc-8h2w-3j85](https://github.com/advisories/GHSA-xcpc-8h2w-3j85).
  No patched release exists for [GHSA-vwc7-r8mq-g2x9](https://github.com/advisories/GHSA-vwc7-r8mq-g2x9)
  (symlink-following overwrite, `<= 0.6.0`). ORT's installer extracts first-party
  package libraries via `getEntry` + `extractEntryTo(..., false, true)` into
  `node_modules`; it does not unpack untrusted archives. Keep 0.6.0 until
  upstream ships `> 0.6.0` or Transformers admits a parent that does.

As of 2026-09-10, Transformers 4.2.0 is the latest release and its dependency
ranges exclude the patched sharp. Updating ORT to 1.29.0 still pulls
`adm-zip ^0.6.0` and would override Transformers' exact native runtime version.
The narrower archive override leaves ORT's native ABI and browser/WASM versions
unchanged. Remove these overrides when a released Transformers parent admits
the patched dependencies, after checking the resolved graph and the smoke
steps below; do not carry them blindly onto another parent version.

Compatibility boundaries:

- [Sharp 0.35 changes](https://sharp.pixelplumbing.com/changelog/v0.35.0/)
  require Node >=20.9 (covered by the project's Node 22 floor and Node 24
  Docker builder). The removed deprecated APIs are not used by Transformers'
  `RawImage` adapter, whose raw images have 1–4 channels, below the new default
  five-channel limit. Browser images use Canvas, not sharp.
- Sharp's pinned Linux x64/arm64 binaries support glibc >=2.28 or musl >=1.2.5;
  keep optional dependencies enabled. There is no automatic source-build
  fallback in 0.35. The frontend's `node:24-alpine` builder needs the musl
  packages; its nginx runtime ships only the built static assets.
- [adm-zip 0.6 changes](https://github.com/cthackers/adm-zip/releases/tag/v0.6.0)
  require Node >=14. The changed directory-extraction behaviour does not
  affect ORT's installer: it uses `getEntry(pathInPackage)` and
  `extractEntryTo(fileEntry, directory, false, true)` on individual libraries,
  then copies the extracted basename. Native ORT remains 1.24.3 (Node-API 6);
  skipping its CUDA download is not a native-runtime compatibility test.

Before changing or removing the overrides, validate on Node 22 and on the
frontend Docker builder for both `linux/amd64` and `linux/arm64`:

1. Run a clean root `ONNXRUNTIME_NODE_INSTALL=skip npm ci`, then inspect
   `npm ls @huggingface/transformers sharp adm-zip onnxruntime-node onnxruntime-web`.
2. On a native-supported host (macOS or glibc Linux), import Transformers and
   round-trip a small RGB image through `RawImage.toSharp().png().toBuffer()`,
   `RawImage.fromBlob()`, resize and crop; assert dimensions and RGB pixels.
   Exercise adm-zip's exact installer call above on an on-disk ZIP containing
   a nested file, and confirm the extracted basename has the original bytes.
   Do not import native ORT on Alpine as proof of browser support: its
   prebuilt Linux runtime is not a musl runtime.
3. Build `frontend/Dockerfile` separately for both target architectures and
   serve the resulting image. In a WebGPU-capable browser, follow **Enable**,
   load the worker, request a completion and a rewrite, and repeat from warm
   OPFS. Confirm worker and `.jsep.mjs`/`.jsep.wasm` requests return 200 from
   this origin, with no Hugging Face/CDN traffic or native-module requests.
   With WebGPU unavailable, confirm the documented server fallback.
