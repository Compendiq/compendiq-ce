# Client inference (WebGPU + Hunspell)

On-device editor micro-tasks for #1418 / ADR-026. The browser never talks to
`huggingface.co`.

## Layout

Copy the transformers.js ONNX tree to:

```
/app/data/client-models/qwen2.5-0.5b-instruct-q4/
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

1. Copy files onto the volume (this runbook). There is no upload UI.
2. Settings → AI Models → Client inference → enable the admin flag.
3. Each author: Settings → Personal → Editor → On-device suggestions, then
   **Pre-download on-device model** in *that* browser (OPFS is per-browser).
4. Spellcheck is independent of WebGPU. Enable it on the same Editor card
   once the dictionaries are on the volume.

## Behaviour

- Warm ghost text does not hit Fastify.
- Cold / no GPU / flags off equals #1417 (`POST /llm/inline-completion`).
- ImprovePanel uses the worker when ready, otherwise `POST /llm/improve`.
- Unassigned `inline_completion` plus “Use on-device suggestions when no
  server model is assigned” (default on) allows local ghost text only when
  the worker is ready.

## CSP

nginx grants `script-src 'wasm-unsafe-eval'` and `worker-src 'self'`.
`connect-src` stays `'self'`. Do not add Hugging Face hosts.
