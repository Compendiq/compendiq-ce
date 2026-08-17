"""`python -m vl_embedding_shim --backend llama` (or `--backend mlx`)."""

from __future__ import annotations

import logging
import sys

import uvicorn

from .app import create_app
from .config import build_backend, settings_from_args
from .service import EmbeddingService


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=logging.INFO, format='%(asctime)s %(levelname)-5s %(name)s %(message)s',
    )
    settings = settings_from_args(argv)
    service = EmbeddingService(build_backend(settings), settings)

    log = logging.getLogger('vl_embedding_shim')
    log.info(
        'starting the %s backend on http://%s:%d — dev only; production is '
        'vLLM >= 0.14 --runner pooling',
        settings.backend, settings.host, settings.port,
    )
    if settings.backend == 'llama':
        log.info('proxying llama-server at %s', settings.llama_base_url)
    else:
        log.info('loading %s in-process (first request pays the load)', settings.mlx_model)

    uvicorn.run(create_app(service), host=settings.host, port=settings.port, log_level='info')
    return 0


if __name__ == '__main__':
    sys.exit(main())
