"""The HTTP surface.

`POST /v1/embeddings` accepts vLLM's chat-template shape and the plain
`{model, input}` shape, and answers the ordinary OpenAI embeddings envelope in
both cases. `GET /v1/models` and `GET /healthz` exist so an operator can tell
what is loaded without embedding anything.

Errors use OpenAI's `{"error": {...}}` envelope: a bad body is 400, an
unreachable or unhappy backend is 502. The distinction matters to a caller with
a circuit breaker — the app's own `openai-compatible-client.ts` treats a
deterministic 400 as proof the provider is reachable rather than as an outage.
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from .backends.base import BackendError
from .images import ImageError
from .mrl import DimensionsError
from .request import ShimRequestError
from .service import EmbeddingService


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
            body = await request.json()
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
