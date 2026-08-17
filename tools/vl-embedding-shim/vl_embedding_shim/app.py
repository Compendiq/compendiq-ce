"""The HTTP surface.

`POST /v1/embeddings` accepts vLLM's chat-template shape and the plain
`{model, input}` shape, and answers the ordinary OpenAI embeddings envelope in
both cases. `GET /v1/models` and `GET /healthz` exist so an operator can tell
what is loaded without embedding anything.

Errors use OpenAI's `{"error": {...}}` envelope: a bad body is 400, one over the
size ceiling is 413, an unreachable or unhappy backend is 502. The distinction
matters to a caller with a circuit breaker — the app's own
`openai-compatible-client.ts` treats a deterministic 400 as proof the provider
is reachable rather than as an outage.

**The body is read against a ceiling before it is parsed.** Uvicorn imposes no
limit of its own and `await request.json()` buffers whatever arrives, so a
single POST would otherwise decide how much of a 24 GB machine it gets. The
declared `content-length` is checked first (cheap, and it refuses before a byte
is read) and the stream is then counted anyway, because a chunked body declares
nothing.
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from .backends.base import BackendError
from .images import ImageError
from .mrl import DimensionsError
from .request import ShimRequestError
from .service import EmbeddingService


class BodyTooLarge(Exception):
    """The request body is over `--max-body-bytes`. Maps to HTTP 413."""

    def __init__(self, limit: int, seen: int | None = None) -> None:
        super().__init__(limit)
        self.limit = limit
        self.seen = seen

    def __str__(self) -> str:
        seen = f'{self.seen} bytes' if self.seen is not None else 'the request body'
        return (
            f'{seen} exceeds the --max-body-bytes ceiling of {self.limit}. A data: URI '
            'is base64, so a request is about 4/3 of the bytes it carries; raise the '
            'ceiling deliberately or send fewer/smaller images'
        )


async def read_body(request: Request, limit: int) -> bytes:
    """The whole body, or `BodyTooLarge` before it is all in memory."""
    declared = request.headers.get('content-length')
    if declared is not None and declared.isdigit() and int(declared) > limit:
        raise BodyTooLarge(limit, int(declared))

    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > limit:
            raise BodyTooLarge(limit)
        chunks.append(chunk)
    return b''.join(chunks)


def _error(status: int, message: str, kind: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={'error': {'message': message, 'type': kind}})


def create_app(service: EmbeddingService) -> FastAPI:
    app = FastAPI(
        title='vl-embedding-shim',
        description=(
            'Dev-only Qwen3-VL-Embedding shim (#1115). Production is vLLM >= 0.14 '
            'with --runner pooling; this reproduces its request/response contract '
            'locally and is not a supported serving path.'
        ),
        docs_url='/docs',
    )

    async def embeddings(request: Request) -> Any:
        try:
            raw = await read_body(request, service.settings.max_body_bytes)
        except BodyTooLarge as exc:
            return _error(413, str(exc), 'invalid_request_error')
        try:
            body = json.loads(raw)
        except Exception:
            return _error(400, 'the request body must be JSON', 'invalid_request_error')
        try:
            # `service.embed` blocks: a synchronous HTTP call for `llama`, a
            # whole forward pass for `mlx`. Run straight from this coroutine it
            # would own the event loop for its full duration and /healthz would
            # be unanswerable for the length of every embed.
            return await run_in_threadpool(service.embed, body)
        except (ShimRequestError, ImageError, DimensionsError) as exc:
            return _error(400, str(exc), 'invalid_request_error')
        except BackendError as exc:
            return _error(502, str(exc), 'backend_error')

    async def models() -> Any:
        try:
            return await run_in_threadpool(service.models)
        except BackendError as exc:
            return _error(502, str(exc), 'backend_error')

    async def healthz() -> Any:
        status, payload = await run_in_threadpool(service.health)
        return JSONResponse(status_code=status, content=payload)

    # The `/v1` prefix is what a base_url of `http://127.0.0.1:8011/v1` reaches
    # (the app's provider rows carry the `/v1` themselves); the bare aliases are
    # for curl.
    app.post('/v1/embeddings')(embeddings)
    app.post('/embeddings')(embeddings)
    app.get('/v1/models')(models)
    app.get('/models')(models)
    app.get('/healthz')(healthz)

    return app
