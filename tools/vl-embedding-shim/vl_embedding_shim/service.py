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


def _too_big(url: str, remaining: int, ceiling: int, seen: int | None = None) -> str:
    size = f'{seen} bytes' if seen is not None else 'more'
    return (
        f'{url} served {size} than the {remaining} bytes left of this request\'s '
        f'--max-body-bytes budget of {ceiling}; every image a request fetches is '
        'counted against the same ceiling as an inbound body, so a body naming '
        'many URLs cannot pull in more than one carrying them'
    )


class _FetchBudget:
    """What one request may still pull in through `image_url` fetches.

    Per REQUEST, not per image (review r3). Re-applying `--max-body-bytes` to
    each fetch bounded nothing a caller cares about: measured on the previous
    code, a 2 KiB ceiling against a body naming 20 URLs each serving 2000 bytes
    answered 200 with 40,000 bytes retained — 19.5x the ceiling, reached
    through the second door the ceiling exists to close. One budget, spent.

    It is created per `_resolve` call rather than held on the service: requests
    run in a threadpool, and a shared counter would have two of them spending
    each other's budget (and would never refill).
    """

    __slots__ = ('ceiling', 'remaining')

    def __init__(self, ceiling: int) -> None:
        self.ceiling = ceiling
        self.remaining = ceiling


class EmbeddingService:
    def __init__(
        self,
        backend: Backend,
        settings: Settings,
        *,
        image_client: httpx.Client | None = None,
    ) -> None:
        self.backend = backend
        self.settings = settings
        # Built up front rather than lazily: requests run in a threadpool, and
        # a lazy `if self._image_client is None` would race two of them into
        # two clients. `httpx.Client` itself is thread-safe. An injected client
        # is the HTTP boundary the tests mock at; the settings flag still
        # decides whether remote fetching happens at all.
        if not settings.allow_remote_images:
            self._image_client = None
        else:
            # `follow_redirects=False` on purpose: a permitted host that 302s is
            # how a fetch reaches 169.254.169.254 or a loopback service, and an
            # operator who opted into one URL did not opt into wherever it points.
            # Pinned against THIS client rather than an injected one — httpx's
            # own default is already `False`, so a test that builds its own
            # client passes whatever this line says (review r2: flipping it to
            # `True` left all 176 tests green, and `is_redirect` below is not a
            # backstop — a followed redirect answers 200 with the metadata body
            # and no redirect left to see).
            self._image_client = image_client or httpx.Client(
                timeout=30.0, follow_redirects=False,
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

    def _fetcher(self, budget: _FetchBudget):
        client = self._image_client
        if client is None:
            return None

        def fetch(url: str) -> bytes:
            # Streamed and counted, not `client.get(url).content`. The inbound
            # body is capped because "a single POST would otherwise decide how
            # much of a 24 GB machine it gets" (app.read_body) — and a POST that
            # names a URL decides the same thing through the fetch instead: a
            # 2 KiB body against a host serving 200 MB allocated 200 MB before
            # this bound existed (review r2). The ceiling is `--max-body-bytes`
            # rather than a knob of its own: it is the same question (how many
            # bytes may one request pull into memory) reached by a second door.
            # `budget.remaining`, not the ceiling: what is left after this
            # request's earlier fetches is what this one may still spend.
            limit = budget.remaining
            try:
                with client.stream('GET', url) as res:
                    if res.is_redirect:
                        raise ImageError(
                            f'{url} answered a redirect to {res.headers.get("location")!r}; '
                            'remote image fetching does not follow redirects — pass the '
                            'final URL'
                        )
                    res.raise_for_status()
                    declared = res.headers.get('content-length')
                    if declared is not None and declared.isdigit() and int(declared) > limit:
                        raise ImageError(
                            _too_big(url, limit, budget.ceiling, int(declared))
                        )
                    chunks: list[bytes] = []
                    total = 0
                    for chunk in res.iter_bytes():
                        total += len(chunk)
                        if total > limit:
                            # A chunked response declares nothing, so the bytes
                            # are counted as they arrive — the same belt-and-
                            # braces `read_body` uses on the inbound side.
                            raise ImageError(_too_big(url, limit, budget.ceiling))
                        chunks.append(chunk)
            except httpx.HTTPError as exc:
                raise ImageError(f'could not fetch {url}: {exc}') from exc
            data = b''.join(chunks)
            # Charged only once the bytes are in hand: a fetch that raised
            # aborts the whole request anyway, and this keeps the counter
            # equal to what is actually being held.
            budget.remaining -= len(data)
            return data

        return fetch

    def _resolve(self, parsed: ParsedRequest) -> list[ResolvedItem]:
        # One budget for the whole request, spanning every item and every image
        # in it — the `messages` shape parses to a single item today, but the
        # bound is on the request either way.
        fetcher = self._fetcher(_FetchBudget(self.settings.max_body_bytes))
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
        # Refreshed, unlike `model_id()` above: this route is how the eval
        # runbook labels a run (`EVAL_EMBEDDING_MODEL=$(curl … /v1/models)`),
        # and after a llama-server restart onto a different GGUF a cached
        # answer names a model that did not serve the run.
        info = self.backend.info(refresh=True)
        return {
            'object': 'list',
            'data': [{
                'id': self.settings.served_model_id or info.model_id,
                'object': 'model',
                'owned_by': 'vl-embedding-shim',
            }],
        }

    def health(self) -> tuple[int, dict[str, Any]]:
        # Refreshed for the same reason: this is the diagnostic the runbook
        # tells an operator to check, and reporting a dead media marker as
        # `"status": "ok"` is worse than not reporting one.
        try:
            info = self.backend.info(refresh=True)
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
