"""Parsing the two accepted request shapes into one internal form.

**Shape A — vLLM's chat-template extension** (the production shape, design D4)::

    {"model": …, "messages": [
        {"role": "system",    "content": [{"type": "text", "text": "<instruction>"}]},
        {"role": "user",      "content": [{"type": "image_url", "image_url": {"url": …}},
                                          {"type": "text", "text": …}]},
        {"role": "assistant", "content": [{"type": "text", "text": ""}]}],
     "continue_final_message": true, "add_special_tokens": true,
     "encoding_format": "float", "dimensions": 1024}

`messages` is ONE prompt, so this shape yields exactly one embedding — that is
vLLM's own semantics ("a list of `messages` … will be treated as a single
prompt to the model"), not a shim limitation.

**Shape B — the plain `{model, input}` shape.** Accepted so the app's own
`generateEmbedding` (which posts exactly that, and reads `data[i].embedding`)
can drive text-parity runs and the retrieval eval against this server. Each
string goes through the *same* chat template under the default instruction —
the plain path is never passed through untemplated, because a bare string pools
a different position and lands off the training distribution (research §2.4).

**The `Instruct:` conversion.** The app prefixes instruction-aware embedding
models with Qwen3-Embedding's flat form `Instruct: {task}\\nQuery:{query}`
(#1329, `query-instruction.ts`). That convention belongs to the *text* family;
the VL family uses a chat template instead, and the two are unrelated. Sending
the flat string through as user content would produce a garbled double
instruction: the task description would sit inside the user turn *underneath*
the default system instruction, so the model would be asked to represent a
sentence that happens to describe a task. So the shim splits it back apart into
system={task}, user={query} and logs that it did — a parity number measured
through this server is then template-correct rather than measuring a mistake.

The split is deliberately narrow: the literal prefix `Instruct: ` plus the
literal separator `\\nQuery:` with **no space after the colon**, because that is
byte-for-byte what `formatQueryForEmbedding` emits. It only applies to shape B;
a caller who spells the flat form inside a `messages` user turn meant it.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

FLAT_PREFIX = 'Instruct: '
FLAT_SEPARATOR = '\nQuery:'

_ROLES = ('system', 'user', 'assistant')
_PART_TYPES = ('text', 'image_url')


class ShimRequestError(ValueError):
    """The caller's body is wrong. Maps to HTTP 400."""


@dataclass(frozen=True)
class ImageRef:
    """An unresolved image: a `data:` URI or a remote URL, as the caller sent it."""

    url: str


@dataclass
class EmbedItem:
    """One thing to embed."""

    text: str = ''
    #: `None` means "the caller supplied no system message". The default lives
    #: in `template.DEFAULT_INSTRUCTION` and is applied there, so there is
    #: exactly one place it is written down.
    instruction: str | None = None
    images: tuple[ImageRef, ...] = ()
    #: True when this item came from a flat `Instruct:`-form input string.
    converted_from_flat: bool = False


@dataclass
class ParsedRequest:
    items: list[EmbedItem]
    model: str | None = None
    dimensions: int | None = None
    shape: Literal['messages', 'input'] = 'input'
    #: Indices of items whose instruction was recovered from the flat form.
    converted_indices: list[int] = field(default_factory=list)


def split_flat_instruct(text: str) -> tuple[str, str] | None:
    """`(task, query)` if `text` is Qwen3-Embedding's flat instruct form."""
    if not text.startswith(FLAT_PREFIX):
        return None
    rest = text[len(FLAT_PREFIX):]
    idx = rest.find(FLAT_SEPARATOR)
    if idx < 0:
        return None
    task = rest[:idx]
    if not task.strip():
        return None
    return task, rest[idx + len(FLAT_SEPARATOR):]


def _content_parts(content: Any, *, where: str) -> list[Mapping[str, Any]]:
    if content is None:
        return []
    if isinstance(content, str):
        return [{'type': 'text', 'text': content}]
    if isinstance(content, Sequence):
        parts: list[Mapping[str, Any]] = []
        for part in content:
            if not isinstance(part, Mapping):
                raise ShimRequestError(f'{where} content parts must be objects')
            parts.append(part)
        return parts
    raise ShimRequestError(f'{where} content must be a string or a list of content parts')


def _image_url(part: Mapping[str, Any]) -> str:
    raw = part.get('image_url')
    if isinstance(raw, str):
        return raw
    if isinstance(raw, Mapping):
        url = raw.get('url')
        if isinstance(url, str) and url:
            return url
    raise ShimRequestError('an image_url part needs image_url.url')


def _parse_messages(messages: Any) -> EmbedItem:
    if not isinstance(messages, Sequence) or isinstance(messages, (str, bytes)):
        raise ShimRequestError('messages must be a list')
    entries: list[Mapping[str, Any]] = []
    for message in messages:
        if not isinstance(message, Mapping):
            raise ShimRequestError('each message must be an object')
        role = message.get('role')
        if role not in _ROLES:
            raise ShimRequestError(
                f'unsupported message role {role!r}; expected one of {", ".join(_ROLES)}'
            )
        entries.append(message)

    instruction: str | None = None
    user: Mapping[str, Any] | None = None

    for index, message in enumerate(entries):
        role = message['role']
        if role == 'system':
            # One check, not two: "not first" already covers "a second one",
            # so a separate `instruction is not None` branch would be dead.
            if index != 0:
                raise ShimRequestError(
                    'at most one system message is accepted, and it must be first'
                )
            instruction = ''.join(
                str(part.get('text', ''))
                for part in _content_parts(message.get('content'), where='system')
                if part.get('type', 'text') == 'text'
            )
        elif role == 'user':
            if user is not None:
                raise ShimRequestError(
                    'exactly one user message is accepted — a messages array is one prompt'
                )
            user = message
        else:  # assistant
            if index != len(entries) - 1:
                raise ShimRequestError('an assistant message may only be the final message')
            filled = ''.join(
                str(part.get('text', ''))
                for part in _content_parts(message.get('content'), where='assistant')
            )
            if filled:
                raise ShimRequestError(
                    'the trailing assistant message must be empty — it is the '
                    'continuation point (continue_final_message), not a turn; '
                    'its content would be silently dropped'
                )

    if user is None:
        raise ShimRequestError('exactly one user message is required')

    images: list[ImageRef] = []
    texts: list[str] = []
    for part in _content_parts(user.get('content'), where='user'):
        part_type = part.get('type', 'text')
        if part_type == 'text':
            texts.append(str(part.get('text', '')))
        elif part_type == 'image_url':
            images.append(ImageRef(_image_url(part)))
        else:
            raise ShimRequestError(
                f'unsupported content part type {part_type!r}; this model takes '
                f'{" and ".join(_PART_TYPES)}'
            )

    # Image parts first, then text — the reference builder's order, regardless
    # of how the caller interleaved them (research §1.4).
    return EmbedItem(text=''.join(texts), instruction=instruction, images=tuple(images))


def _parse_input(raw: Any, *, convert_flat_instruct: bool) -> tuple[list[EmbedItem], list[int]]:
    if isinstance(raw, str):
        strings = [raw]
    elif isinstance(raw, Sequence) and not isinstance(raw, (bytes, bytearray)):
        strings = list(raw)
    else:
        raise ShimRequestError('input must be a string or a list of strings')

    if not strings:
        raise ShimRequestError('input must not be empty')

    items: list[EmbedItem] = []
    converted: list[int] = []
    for index, value in enumerate(strings):
        if not isinstance(value, str):
            raise ShimRequestError(
                'input must contain strings; token-id arrays are not supported '
                'because the shim cannot detokenize them'
            )
        split = split_flat_instruct(value) if convert_flat_instruct else None
        if split is None:
            items.append(EmbedItem(text=value))
        else:
            task, query = split
            items.append(EmbedItem(text=query, instruction=task, converted_from_flat=True))
            converted.append(index)
    return items, converted


def _parse_dimensions(raw: Any) -> int | None:
    if raw is None:
        return None
    # `bool` is an `int` in Python, and `dimensions: true` is a caller mistake,
    # not a request for one component.
    if isinstance(raw, bool) or not isinstance(raw, int):
        raise ShimRequestError('dimensions must be a positive integer')
    if raw < 1:
        raise ShimRequestError('dimensions must be a positive integer')
    return raw


def parse_embeddings_request(
    body: Mapping[str, Any],
    *,
    convert_flat_instruct: bool = True,
) -> ParsedRequest:
    """Validate and normalise a `POST /v1/embeddings` body."""
    if not isinstance(body, Mapping):
        raise ShimRequestError('the request body must be a JSON object')

    has_input = body.get('input') is not None
    has_messages = body.get('messages') is not None
    if has_input == has_messages:
        raise ShimRequestError('exactly one of `input` or `messages` is required')

    encoding_format = body.get('encoding_format')
    if encoding_format not in (None, 'float'):
        raise ShimRequestError(
            f'encoding_format {encoding_format!r} is not supported; this shim emits float'
        )

    model = body.get('model')
    if model is not None and not isinstance(model, str):
        raise ShimRequestError('model must be a string')

    dimensions = _parse_dimensions(body.get('dimensions'))

    if has_messages:
        return ParsedRequest(
            items=[_parse_messages(body['messages'])],
            model=model,
            dimensions=dimensions,
            shape='messages',
        )

    items, converted = _parse_input(body['input'], convert_flat_instruct=convert_flat_instruct)
    return ParsedRequest(
        items=items,
        model=model,
        dimensions=dimensions,
        shape='input',
        converted_indices=converted,
    )
