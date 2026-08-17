# Runbook — the image index (#1115)

Operating the `image_embedding` leg: which server can serve it, how to start
one, how to assign and probe it, and what changing the model costs.

**Scope as of P1.** The leg is *configurable* and *provable*, and it does
nothing else yet. Assigning it types the `page_image_embeddings` column and
builds its index; **no page image is embedded (P2) and no query touches the
index (P3)**. Everything below is preparation you can do — and verify — before
either lands.

Design of record: ADR-025 in `docs/ARCHITECTURE-DECISIONS.md` and
`docs/superpowers/specs/2026-08-16-multimodal-image-retrieval-design.md`.

---

## 1. What the endpoint has to be

Not "any OpenAI-compatible embeddings endpoint". The model is pooled at the
**last token of a chat prompt**, so the request is vLLM's chat-embeddings
extension: `POST {baseUrl}/embeddings` with a `messages` array and a trailing
**empty `assistant` turn** plus `continue_final_message: true`.

| Serving path | Verdict |
|---|---|
| **vLLM ≥ 0.14.0**, `--runner pooling` | **The supported path.** |
| Hugging Face **TEI** | No. No image concept anywhere in its OpenAPI spec; the request for this family (`text-embeddings-inference#822`) is open with zero comments. |
| **LM Studio** `/v1/embeddings` | No. Text `input` only; images belong to its chat surface. |
| **llama.cpp `llama-server`** | Not through this client. Multimodal embeddings exist, but on the **non-OpenAI** `POST /embedding` route, with a hand-built prompt and a per-server *random* media marker from `/props`. Fine for measuring a GGUF checkpoint directly; not something Compendiq can be pointed at. |
| `mlx_vlm.server` | No. It applies the chat template to images and **not** to text, so the two modalities come from different formattings. The probe refuses this (`width_mismatch`) only when the widths also differ — do not rely on it catching every such server. |
| Plain `{model, input}` on any server | No. Mechanically accepted by the same vLLM instance, and wrong: the chat template is applied on the `messages` path only, so the vector is pooled at a different position and must never share an index. |

## 2. Serving it on vLLM

```bash
# 2B, native 2048 dimensions — the recommended default.
vllm serve Qwen/Qwen3-VL-Embedding-2B \
    --runner pooling \
    --max-model-len 8192
```

- `--runner pooling` is required; the checkpoint ships its own
  `chat_template.jinja`, so **no `--chat-template` flag is needed**.
- No `--pooler-config`. The conversion default is last-token + L2-normalise,
  which is exactly what the checkpoint's `1_Pooling` / `2_Normalize` declare.
  Third-party guides suggesting `{"pooling_type": "MEAN"}` are wrong for this
  model.
- `--max-model-len 8192` matches the reference implementation's operating
  context. 32K is the architectural ceiling; nothing was evaluated there.

**MRL (`dimensions`) needs an override.** Neither checkpoint declares
`is_matryoshka` in `config.json`, and vLLM refuses the `dimensions` parameter
for models it does not recognise as Matryoshka. The 8B needs this, because its
native 4096 lands in pgvector's **unindexed** tier:

```bash
vllm serve Qwen/Qwen3-VL-Embedding-8B \
    --runner pooling --max-model-len 8192 \
    --hf-overrides '{"is_matryoshka": true}'
# or pin the allowed set:
#   --hf-overrides '{"matryoshka_dimensions":[4096,2048,1024,512]}'
```

Compendiq re-normalises client-side whenever it sends `dimensions`, because
truncating a unit vector does not leave a unit vector and vLLM is not documented
to re-normalise on every path.

### Pin the version. A bump is a re-index event.

vLLM's image preprocessing diverges from the reference `qwen_vl_utils` path
(~0.92 cosine on identical inputs — `vllm#33204`, open, acknowledged in vLLM's
own docs), and a quality regression between `0.14.0rc2` and `0.15.2` was
reported as `vllm#33954`. A corpus embedded on one version and queried on
another is silently degraded, and nothing in Compendiq can detect it.

So: pin the served version, and when you change it, treat it exactly like
changing the model — see §5.

What Compendiq can see for you, and what it cannot:

- **Moving the endpoint** — a different provider row, *or* the same provider
  row edited to a new `base_url` — changes the recorded identity, so the next
  save or **Re-check** rebuilds. That covers a container swapped for one running
  a different vLLM version at a new address.
- **Upgrading in place**, same URL, is invisible to every signal the app has.
  After such an upgrade, run **Re-check** (it re-confirms the width) and then
  force a rescan once P2 exists. Nothing will warn you.

## 3. Local development

`mlx-embeddings` behind a ~30-line FastAPI shim exposing the §1 shape is the
only local option that reproduces production semantics on **both** modalities
(instruction as a system message, chat template on image *and* text). It ships
with P5 under `tools/vl-embedding-shim/`.

**Local vectors never decide anything.** Quantisation, MLX-vs-CUDA numerics and
vLLM's own preprocessing divergence each move the space. Local is for plumbing
and for eyeballing ranked lists; any number that decides something is measured
on the production stack.

## 4. Assigning and probing

Settings → AI Models → the **Image embedding** row.

1. Pick a provider (and a model, or leave it to the provider's default model).
2. Save. The save **blocks on a probe** and **refuses the assignment** if it
   fails — a leg that cannot embed must not be assignable, because the failure
   it prevents is silent: a plain text embedder *answers* the request with a
   well-formed vector from the wrong pooling position.

On success the row is written with the **resolved model pinned into it**, even
if you left the model on "Inherit provider's model": the probe verified exactly
one model, and an inherited one would silently follow the provider's
`default_model` the next time somebody edits it. So the model dropdown will show
that model after the save. That is not a UI glitch — it is the leg refusing to
name a model nobody probed.

The probe embeds a known image **and** a text, and requires:

- the endpoint accepts the `messages` shape;
- both come back at the **same width** (a server that templates one modality
  and not the other puts two vector spaces in one column);
- the width is 1..16000.

**Refusal categories.** The toast carries the prose in the middle column; the
slug is the `reason` field on the 422 body, which is what a log line or a
scripted client sees.

| Category (`reason`) | What the toast says | Do |
|---|---|---|
| `shape_rejected` | "This endpoint refused the request. Image embedding needs a server that accepts vLLM's chat-embeddings shape…" | Usually the wrong kind of server (see §1) or the wrong model id. The provider's own body is in the **backend log** — it is deliberately *not* stored for a pair that was refused, so the row's disclosure will not show it. |
| `unreachable` | "The provider could not be reached for the probe…" | Check the base URL, credentials, and that the server is up. The per-provider breaker may also be open from earlier failures. |
| `width_mismatch` | "This endpoint returned different vector widths for an image and for a text…" | The server is not applying the same formatting to both. Not usable. |
| `unusable_width` | "This endpoint returned a vector width Postgres cannot index." | Serve at ≤ 4000 dimensions using the model's `dimensions` / MRL parameter (§2). |

On success the row shows `2048-dim · halfvec HNSW` (or `vector HNSW`, or
`no index (sequential scan)`) and when it was last checked. **Re-check** re-runs
the probe against the currently assigned pair; on success it also re-applies the
column type, which is the remedy when you restart the model server at a
different width. A *failed* re-check leaves the column alone and is reported as
an error, not a success.

**Re-check is not read-only.** If the width or the endpoint changed, re-applying
the column type is the destructive rebuild in §5: the image index is emptied and
every non-folder page is queued for a re-scan. The toast says so, naming the
page count, when that is what happened.

The provider's raw error body is admin-only, behind the row's disclosure — which
shows the **currently assigned** pair's last verdict. A refused *change* never
overwrites it, so after a refused assignment look in the backend log rather than
there. It is never returned by `GET /llm/usecase-default`, which every logged-in
user can call.

### Index tiers

| Probed width | Column | Index |
|---|---|---|
| ≤ 2000 | `vector(n)` | HNSW `vector_cosine_ops` |
| ≤ 4000 | `halfvec(n)` | HNSW `halfvec_cosine_ops` |
| > 4000 | `vector(n)` | **none** — sequential scan |

The unindexed tier is legal and correct, and it will get slow as the corpus
grows. Prefer MRL truncation to 4000 or below.

## 5. Changing the model (or the provider)

**It empties the image index and re-scans. There is no shadow swap here, and
that is deliberate**: the image leg is simply *off* while its index is empty, so
text search is never degraded, and images are cheap to redo.

A rebuild is triggered by the probed **width** changing **or** by the assigned
`provider:model@baseUrl` changing — the second because two different models at
the same width are two incompatible spaces that a column type cannot
distinguish, and the base URL is in there because a provider row's endpoint can
move without its id changing (§2).

It is triggered by **saving** the assignment and by **Re-check** — those are the
only two moments the app looks. Editing a provider row alone changes nothing
until one of them runs.

What happens, in one bounded-lock transaction:

1. drop the HNSW index;
2. `TRUNCATE page_image_embeddings`;
3. retype `embedding` to the new tier;
4. rebuild the index (or skip it, above 4000, with a warning in the log and a
   note on the settings row);
5. record `admin_settings.image_embedding_dimensions` and
   `…_index_model`;
6. mark every non-folder page `image_embedding_dirty`.

`pages.embedding_dirty` is **not** touched — text retrieval does not move when
the image model does. That is the whole reason migration 093 gave the two flags
separate columns.

**Unassigning** the use case turns the leg off and destroys nothing: the column
type and the index survive, so re-assigning the same pair costs nothing.

## 6. Verifying by hand

```bash
curl -s "$BASE_URL/embeddings" -H 'Content-Type: application/json' -d '{
  "model": "Qwen/Qwen3-VL-Embedding-2B",
  "messages": [
    {"role": "system",    "content": [{"type": "text", "text": "Represent the user'\''s input."}]},
    {"role": "user",      "content": [{"type": "text", "text": "a diagram of a network"}]},
    {"role": "assistant", "content": [{"type": "text", "text": ""}]}
  ],
  "encoding_format": "float",
  "continue_final_message": true,
  "add_special_tokens": true
}' | jq '.data[0].embedding | length'
```

A 400/422 here is the `shape_rejected` case. A number is the width the probe
would record.

If you drop the trailing `assistant` turn or `continue_final_message`, this call
**still succeeds** and still returns a plausible vector — of a different, worse
space. That is why the client's request body is asserted byte-for-byte in
`vl-embedding-client.test.ts` rather than left to a smoke test.
