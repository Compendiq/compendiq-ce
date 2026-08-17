"""Dev-only serving shim for Qwen3-VL-Embedding (#1115).

Exposes exactly vLLM's chat-template embeddings shape — `POST /v1/embeddings`
with a `messages` array — over two interchangeable local backends (`mlx`,
`llama`). Production is vLLM >= 0.14 with `--runner pooling`; this exists so a
laptop can exercise the same request/response contract.

See README.md for the load-bearing rules.
"""

__all__ = ['__version__']

__version__ = '0.1.0'
