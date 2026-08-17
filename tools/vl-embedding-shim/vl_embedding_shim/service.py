"""Parse → resolve images → embed → MRL → the OpenAI response envelope."""

from __future__ import annotations

import logging
import threading
from collections.abc import Mapping
from typing import Any

import httpx

from .backends.base import Backend, BackendError, ResolvedItem
from .config import Settings
from .images import ImageError, guard_pixels, resolve_image
from .mrl import DimensionsError, apply_mrl
from .request import ParsedRequest, ShimRequestError, parse_embeddings_request

log = logging.getLogger('vl_embedding_shim')


class EmbeddingService:
    def __init__(self, backend: Backend, settings: Settings) -> None:
        self.backend = backend
        self.settings = settings
        # Built up front rather than lazily: requests run in a threadpool, and
        # a lazy `if self._image_client is None` would race two of them into
        # two clients. `httpx.Client` itself is thread-safe.
        self._image_client = (
            httpx.Client(timeout=30.0, follow_redirects=True)
            if settings.allow_remote_images else None
        )
        # One request through the model at a time. Neither backend wants to be
        # re-entered: `mlx` runs the model in-process and has its
        # `language_model._position_ids` reset immediately before each
        # `process()` call, so two overlapping requests would clear the cache
        # under each other; `llama` is a single local server with four slots
        # sharing one 8192-token context. Serialising costs throughput, which
        # this tool does not have as a goal.
        self._embed_lock = threading.Lock()

    # -- image fetching ----------------------------------------------------

    def _fetcher(self):
        client = self._image_client
        if client is None:
            return None

        def fetch(url: str) -> bytes:
            try:
                res = client.get(url)
                res.raise_for_status()
            except httpx.HTTPError as exc:
                raise ImageError(f'could not fetch {url}: {exc}') from exc
            return res.content

        return fetch

    def _resolve(self, parsed: ParsedRequest) -> list[ResolvedItem]:
        fetcher = self._fetcher()
        resolved: list[ResolvedItem] = []
        for item in parsed.items:
            images = []
            for ref in item.images:
                data = resolve_image(ref, fetcher=fetcher)
                guard_pixels(data, self.settings.max_pixels)
                images.append(data)
            resolved.append(
                ResolvedItem(
                    text=item.text, instruction=item.instruction, images=tuple(images),
                )
            )
        return resolved

    # -- the endpoint ------------------------------------------------------

    def embed(self, body: Mapping[str, Any]) -> dict[str, Any]:
        parsed = parse_embeddings_request(
            body, convert_flat_instruct=self.settings.convert_flat_instruct,
        )
        for index in parsed.converted_indices:
            item = parsed.items[index]
            # Loud on purpose: a parity run measured through this server is only
            # template-correct BECAUSE of this conversion, and the operator
            # reading the numbers should see that it happened.
            log.info(
                'converted flat `Instruct:` input[%d] into a system message '
                '(instruction=%r) — the VL family uses a chat template, not '
                "Qwen3-Embedding's flat prefix",
                index, item.instruction,
            )

        items = self._resolve(parsed)
        with self._embed_lock:
            vectors = self.backend.embed(items)
        if len(vectors) != len(items):
            raise BackendError(
                f'backend returned {len(vectors)} vectors for {len(items)} inputs'
            )

        data = [
            {'object': 'embedding', 'index': index, 'embedding': apply_mrl(vec, parsed.dimensions)}
            for index, vec in enumerate(vectors)
        ]
        return {
            'object': 'list',
            'data': data,
            # The SERVED id, not the caller's `model` string: a mismatch is
            # worth seeing rather than echoing back.
            'model': self.model_id(),
            # The shim does not tokenize, and llama-server's /embedding reports
            # no token counts. Zero is the honest answer; inventing an estimate
            # would be a number someone eventually trusts.
            'usage': {'prompt_tokens': 0, 'total_tokens': 0},
        }

    # -- metadata ----------------------------------------------------------

    def model_id(self) -> str:
        return self.settings.served_model_id or self.backend.info().model_id

    def models(self) -> dict[str, Any]:
        info = self.backend.info()
        return {
            'object': 'list',
            'data': [{
                'id': self.settings.served_model_id or info.model_id,
                'object': 'model',
                'owned_by': 'vl-embedding-shim',
            }],
        }

    def health(self) -> tuple[int, dict[str, Any]]:
        try:
            info = self.backend.info()
        except BackendError as exc:
            return 503, {
                'status': 'degraded',
                'backend': self.settings.backend,
                'reason': str(exc),
            }
        return 200, {
            'status': 'ok',
            'backend': info.backend,
            'model': self.settings.served_model_id or info.model_id,
            'vision': info.vision,
            'details': info.details,
        }


__all__ = [
    'BackendError',
    'DimensionsError',
    'EmbeddingService',
    'ImageError',
    'ShimRequestError',
]
