"""Backend (b): proxy to a `llama-server` serving a Qwen3-VL-Embedding GGUF.

Why the non-OpenAI route. llama-server's `/v1/embeddings` is text-only — its
documented options are OpenAI's and its examples are `input` as a string or a
string array. The PR that would have added image+text input there
(ggml-org/llama.cpp#18665, "server: support image+text input for embeddings
(Qwen3-VL-Embedding)") is **closed and unmerged**. Multimodal embeddings live on
`POST /embedding`, which is explicitly *not* OAI-compatible and takes a JSON
object prompt::

    {"content": {"prompt_string": "…", "multimodal_data": ["<base64>", …]}}

So this backend hand-builds the chat template (see `template.py`) instead of
handing a `messages` array to anything.

**The media marker is randomised per server process.** The literal
`<__media__>` in the README no longer works; `/props` reports the real one, and
a mismatch between marker count and `multimodal_data` length is the error in
llama.cpp issues #26201 and #25088 — "number of media markers in text (0) does
not match number of bitmaps (1)". `/props` also reports `modalities.vision`,
which is checked before any image is sent: the README says a client "must not
specify this field unless the server has the multimodal capability".

`/props` is cached for the embed hot path but **re-read on a failed image
request** (see `_embed_item`) and on every `/healthz` and `/v1/models`, which
are the two diagnostics an operator consults right after restarting the server.
A cache that only ever fills once outlives the process it describes.

**Throughput is not a goal.** One HTTP request per item, sequentially. Batching
text-only items into `{"content": [prompt, …]}` would be faster, but this is a
dev shim in front of a local model that dominates the wall clock anyway, and a
per-item request keeps the failure of one item from being an ambiguous partial
batch.
"""

from __future__ import annotations

import base64
import logging
from collections.abc import Sequence
from typing import Any

import httpx

from ..template import build_prompt
from .base import BackendError, BackendInfo, ResolvedItem

DEFAULT_BASE_URL = 'http://127.0.0.1:8090'

#: Seconds allowed for a `/props` read, regardless of the embed timeout.
PROPS_TIMEOUT = 10.0

log = logging.getLogger('vl_embedding_shim')


class LlamaBackend:
    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        *,
        client: httpx.Client | None = None,
        model_id: str | None = None,
        timeout: float = 300.0,
    ) -> None:
        self._base_url = base_url.rstrip('/')
        self._client = client or httpx.Client(base_url=self._base_url, timeout=timeout)
        self._model_id = model_id
        self._props: dict[str, Any] | None = None
        # `/props` is a metadata read that either answers at once or is broken,
        # and `/healthz` now performs one on every call. The embed timeout
        # (300 s, sized for an 8B forward pass) would make a hung server hang
        # the diagnostic that exists to report it.
        self._props_timeout = min(timeout, PROPS_TIMEOUT)

    # -- properties of the running server ---------------------------------

    def props(self, *, refresh: bool = False) -> dict[str, Any]:
        if self._props is None or refresh:
            try:
                res = self._client.get(f'{self._base_url}/props', timeout=self._props_timeout)
                res.raise_for_status()
                payload = res.json()
            except httpx.HTTPError as exc:
                raise BackendError(
                    f'could not read {self._base_url}/props from llama-server: {exc}'
                ) from exc
            if not isinstance(payload, dict):
                raise BackendError(f'{self._base_url}/props did not answer a JSON object')
            self._props = payload
        return self._props

    def info(self, *, refresh: bool = False) -> BackendInfo:
        props = self.props(refresh=refresh)
        modalities = props.get('modalities')
        vision = modalities.get('vision') if isinstance(modalities, dict) else None
        return BackendInfo(
            backend='llama',
            model_id=self._model_id or self._derived_model_id(props),
            vision=vision if isinstance(vision, bool) else None,
            details={
                'base_url': self._base_url,
                'media_marker': props.get('media_marker'),
                'model_path': props.get('model_path'),
                'n_ctx': (props.get('default_generation_settings') or {}).get('n_ctx'),
            },
        )

    @staticmethod
    def _derived_model_id(props: dict[str, Any]) -> str:
        path = props.get('model_path') or props.get('model_alias') or ''
        return str(path).rsplit('/', 1)[-1] or 'llama-server'

    # -- embedding ---------------------------------------------------------

    def _media_marker(self, *, refresh: bool = False) -> str:
        info = self.info(refresh=refresh)
        if info.vision is not True:
            raise BackendError(
                'llama-server reports no vision capability '
                f'(/props modalities.vision = {info.vision!r}); start it with '
                '--mmproj to embed images'
            )
        marker = info.details.get('media_marker')
        if not isinstance(marker, str) or not marker:
            raise BackendError(
                '/props reported no media_marker, so image placeholders cannot be '
                'built; this llama-server build cannot take multimodal_data'
            )
        return marker

    def embed(self, items: Sequence[ResolvedItem]) -> list[list[float]]:
        return [self._embed_item(item) for item in items]

    def _embed_item(self, item: ResolvedItem) -> list[float]:
        if not item.images:
            # No marker in the prompt, so nothing about this request can be
            # invalidated by a restart — and `/props` need never have been read.
            return self._embed_one(item, None)

        marker = self._media_marker()
        try:
            return self._embed_one(item, marker)
        except BackendError as original:
            # The marker is randomised per llama-server PROCESS, and restarting
            # it (onto another GGUF, a bigger batch, an added --mmproj) is this
            # tool's main dev loop. A marker cached for the life of the shim
            # then turns every later image request into llama.cpp's "number of
            # media markers in text (0) does not match number of bitmaps (1)"
            # (issues #26201 / #25088) until someone restarts the shim too.
            # Re-read once: the marker is the only thing that can have changed
            # behind an unchanged base URL. If it did not change, nothing was
            # learned and the original error stands rather than being doubled.
            try:
                fresh = self._media_marker(refresh=True)
            except BackendError:
                # The re-read is diagnostics, not the request. A server that
                # died between the two calls would otherwise be reported as a
                # /props failure, hiding what the embed itself actually said.
                raise original from None
            if fresh == marker:
                raise
            log.warning(
                'llama-server answered with a new media marker (%s -> %s) — it was '
                'restarted under this shim; retrying the request once with the new one',
                marker, fresh,
            )
            return self._embed_one(item, fresh)

    def _embed_one(self, item: ResolvedItem, marker: str | None) -> list[float]:
        prompt = build_prompt(
            instruction=item.instruction,
            text=item.text,
            image_count=len(item.images),
            # Only substituted when there are images, so a text-only call never
            # depends on /props having been read.
            media_marker=marker or '',
        )
        content: dict[str, Any] = {'prompt_string': prompt}
        if item.images:
            content['multimodal_data'] = [
                base64.b64encode(data).decode('ascii') for data in item.images
            ]

        try:
            res = self._client.post(f'{self._base_url}/embedding', json={'content': content})
        except httpx.HTTPError as exc:
            raise BackendError(f'llama-server /embedding request failed: {exc}') from exc

        if res.status_code >= 400:
            raise BackendError(
                f'llama-server /embedding answered HTTP {res.status_code}: {res.text[:500]}'
            )

        return _unwrap_embedding(res.json())


def _unwrap_embedding(payload: Any) -> list[float]:
    """The vector out of llama-server's `[{"index": 0, "embedding": [[…]]}]`."""
    rows = payload.get('data') if isinstance(payload, dict) else payload
    if not isinstance(rows, list) or not rows:
        raise BackendError(f'llama-server /embedding answered no rows: {payload!r:.200}')
    first = rows[0]
    if not isinstance(first, dict) or 'embedding' not in first:
        raise BackendError(f'llama-server /embedding row carries no embedding: {first!r:.200}')
    vector = first['embedding']
    # `--pooling last` answers one row nested inside `embedding`; older builds
    # answered the vector flat. Unwrap exactly one level when present.
    if isinstance(vector, list) and vector and isinstance(vector[0], list):
        vector = vector[0]
    if not isinstance(vector, list) or not vector:
        raise BackendError('llama-server /embedding answered an empty embedding')
    return [float(x) for x in vector]
