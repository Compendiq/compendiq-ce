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

## CSP

nginx grants `script-src 'wasm-unsafe-eval'` and `worker-src 'self'`.
`connect-src` stays `'self'`. Do not add Hugging Face hosts.
