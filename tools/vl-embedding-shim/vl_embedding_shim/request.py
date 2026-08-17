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

Two things about this shape are worth stating plainly, because "exactly vLLM's
shape" is what the tool advertises:

* **The continuation is enforced, not assumed.** See `_check_continuation` —
  the shim refuses a body vLLM would render without the trailing
  ``<|im_start|>assistant\\n``, which is stricter than vLLM on purpose.
* **A text part may not precede an image part.** The shim builds
  images-then-text after the reference embedder while vLLM emits the marker
  where the caller put it, so an interleaved body embeds differently in the two
  places — measurably more differently than the continuation mistake above. It
  is refused rather than silently normalised; see `_parse_messages`.
* **A content part's kind is decided the way the checkpoint decides it**, never
  by defaulting a type-less part to text — see `_part_kind`.

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


def _part_kind(part: Mapping[str, Any], *, where: str) -> Literal['text', 'image']:
    """What kind of content part this is — decided, never assumed.

    Two sources agree and neither of them defaults to text. This checkpoint's
    `chat_template.jinja` calls a part an image when ``content.type == 'image'
    or 'image' in content or 'image_url' in content``; vLLM's
    `_parse_chat_message_content_mm_part` reads a part carrying **no** `type` as
    `CustomChatCompletionContentSimpleImageParam` when it has `image_url`, and
    refuses every other type-less part with ``Missing 'type' field in
    multimodal part``.

    Defaulting a type-less part to text — which this function replaced — meant
    ``{"image_url": {"url": …}}`` became an *empty text part*: the shim answered
    200 with the literal-`NULL` vector and the image never reached the model
    (review r2 measured cos 1.000000 against the ``input: [""]`` vector on the
    8B; measured here, that `NULL` vector sits at cos **0.169** from the image's
    own). An explicitly wrong `type` was already a 400, so the guard refused the
    legible mistake and swallowed the silent one — which is the failure class
    this whole module exists to refuse.
    """
    part_type = part.get('type')
    if part_type is None:
        if 'image_url' in part:
            return 'image'
        raise ShimRequestError(
            f'a {where} content part needs a `type` ({" or ".join(_PART_TYPES)}); the only '
            'type-less form vLLM accepts is `{"image_url": …}` and it refuses the rest with '
            '"Missing \'type\' field in multimodal part". Refused rather than read as empty '
            'text, which would drop an image this model\'s own chat template renders a '
            'vision marker for'
        )
    if part_type == 'text':
        return 'text'
    if part_type == 'image_url':
        return 'image'
    raise ShimRequestError(
        f'unsupported content part type {part_type!r}; this model takes '
        f'{" and ".join(_PART_TYPES)}'
    )


def _text_only_parts(content: Any, *, where: str) -> list[Mapping[str, Any]]:
    """`content`'s parts, refusing any that is not text.

    `chat_template.jinja` renders only `'text' in content` for the `system` and
    `assistant` roles — no vision marker — so an image part there is dropped on
    the way to the model. vLLM does not drop it: it collects the image as
    multimodal input the rendered prompt has no placeholder for, and fails the
    request. Either way the caller's body is wrong, so it is refused here rather
    than quietly embedded without the image.
    """
    parts = _content_parts(content, where=where)
    for part in parts:
        if _part_kind(part, where=where) != 'text':
            raise ShimRequestError(
                f'a {where} message may only carry text parts — this model\'s chat '
                f'template renders no vision marker for a {where} image, so it would be '
                'dropped here and would leave vLLM one image against zero placeholders'
            )
    return parts


def _image_url(part: Mapping[str, Any]) -> str:
    raw = part.get('image_url')
    if isinstance(raw, str):
        return raw
    if isinstance(raw, Mapping):
        url = raw.get('url')
        if isinstance(url, str) and url:
            return url
    raise ShimRequestError('an image_url part needs image_url.url')


def _parse_messages(messages: Any) -> tuple[EmbedItem, bool]:
    """`(item, ends_with_an_assistant_turn)`.

    The flag is returned rather than checked here because the two fields that
    decide whether the prompt ends at the generation point —
    `continue_final_message` and `add_generation_prompt` — are top-level body
    fields, not messages. `_check_continuation` reads both together.
    """
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
    ends_with_assistant = False

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
                for part in _text_only_parts(message.get('content'), where='system')
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
                for part in _text_only_parts(message.get('content'), where='assistant')
            )
            if filled:
                raise ShimRequestError(
                    'the trailing assistant message must be empty — it is the '
                    'continuation point (continue_final_message), not a turn; '
                    'its content would be silently dropped'
                )
            ends_with_assistant = True

    if user is None:
        raise ShimRequestError('exactly one user message is required')

    images: list[ImageRef] = []
    texts: list[str] = []
    for part in _content_parts(user.get('content'), where='user'):
        if _part_kind(part, where='user') == 'text':
            texts.append(str(part.get('text', '')))
            continue
        # Image parts first, then text — the reference builder's order
        # (research §1.4). `chat_template.jinja` instead iterates
        # `message.content` and emits the marker where the CALLER put it, so
        # `[text "a", image, text "b"]` renders `a<image>b` on vLLM and
        # `<image>ab` here. Measured on the 8B by posting both prompts to
        # llama-server: cos 0.588 (review r2) and 0.657 (this fix, a different
        # image) — a bigger divergence either way than the missing continuation
        # this module already 400s over, which measures 0.953/0.957 on the same
        # pairs. Normalising it silently would be the same mistake in the
        # opposite direction, so an interleaved body is refused and every
        # accepted one is image-first already, which makes the "reorder" below a
        # no-op rather than a rewrite.
        if any(texts):
            raise ShimRequestError(
                'a text content part may not precede an image part: vLLM emits the '
                'vision marker where you put it while this shim always builds '
                'images-then-text, and the two prompts embed differently (cos 0.59-0.66 '
                'measured on the 8B). Put the image parts first, as design D4 does'
            )
        images.append(ImageRef(_image_url(part)))

    item = EmbedItem(text=''.join(texts), instruction=instruction, images=tuple(images))
    return item, ends_with_assistant


def _check_continuation(body: Mapping[str, Any], *, ends_with_assistant: bool) -> None:
    """Refuse a `messages` body vLLM would not render as a continuation.

    The whole point of the trailing empty `assistant` turn is that the prompt
    ends with ``<|im_start|>assistant\\n`` and nothing after it, because that
    final newline is the token whose hidden state becomes the vector (research
    §1.4, §2.3). vLLM's `EmbeddingChatRequest` defaults **both**
    `continue_final_message` and `add_generation_prompt` to `false`, so a body
    that carries neither renders the user turn closed by ``<|im_end|>\\n`` and
    pools that position instead — silently, with a plausible-looking vector.

    The shim always builds the continued prompt, so accepting such a body would
    answer the RIGHT vector for the WRONG request: a client developed green
    against this server would then ship off-distribution vectors to production.
    That is precisely the mistake this tool exists to let a laptop catch, so it
    is refused. The shim is deliberately stricter than vLLM here — in the safe
    direction, since every body it accepts renders identically on vLLM.

    Two forms are accepted, because vLLM renders both to the same bytes:

    * a trailing empty `assistant` turn + ``continue_final_message: true``
      (vLLM's own example, design D4); or
    * no trailing assistant + ``add_generation_prompt: true`` (what the
      reference embedder's `apply_chat_template` call does).

    Both at once is refused because transformers itself refuses that pair.
    `add_special_tokens` is accepted in either polarity and ignored: the shim
    hands a prompt *string* to a backend that tokenizes it, so there is no
    tokenizer-level flag here to honour.
    """
    continue_final = body.get('continue_final_message')
    add_generation = body.get('add_generation_prompt')

    if continue_final is True and add_generation is True:
        raise ShimRequestError(
            'continue_final_message and add_generation_prompt cannot both be true — '
            'transformers refuses that pair outright, so this body would 400 in '
            'production rather than embed'
        )

    if ends_with_assistant:
        if continue_final is not True:
            raise ShimRequestError(
                'a trailing empty `assistant` message needs `continue_final_message: true`. '
                'vLLM defaults it to false and would close the turn with `<|im_end|>`, '
                'pooling that position instead of the `<|im_start|>assistant\\n` the model '
                'was trained to be read at — a different, off-distribution vector. The shim '
                'refuses the body rather than answer the right vector for the wrong request'
            )
        return

    if add_generation is not True:
        raise ShimRequestError(
            'a `messages` body must end at `<|im_start|>assistant\\n`: append an empty '
            '`assistant` message with `continue_final_message: true` (vLLM\'s own example, '
            'design D4), or pass `add_generation_prompt: true`. vLLM defaults both to false '
            'and would pool the end of the user turn instead'
        )


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
        item, ends_with_assistant = _parse_messages(body['messages'])
        _check_continuation(body, ends_with_assistant=ends_with_assistant)
        return ParsedRequest(
            items=[item],
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
