"""The Qwen3-VL-Embedding chat template, built by hand.

Why by hand: the `llama` backend talks to llama-server's `/embedding`, which
takes a raw prompt string rather than a `messages` array (its OpenAI-compatible
`/v1/embeddings` route is text-only — llama.cpp PR #18665 was closed unmerged).
So the shim owns the template, and owning it is also what makes the two backends
comparable: the `mlx` backend hands `mlx-embeddings` the same normalised
instruction, and that library builds the identical conversation through the
checkpoint's own `chat_template.jinja`.

Every byte below is transcribed from the research pack's §1.4, which quotes the
paper's "Input Template for Embedding", the shipped `chat_template.jinja`, and
the reference embedder `scripts/qwen3_vl_embedding.py`.

Three details are load-bearing and each was verified against the reference:

1. **The prompt ends with `<|im_start|>assistant\\n` and nothing after it.** That
   trailing newline is the position that gets pooled (last non-pad token, then
   L2-normalise). The paper's prose says a `<|endoftext|>` PAD token is
   appended; the *code* calls `apply_chat_template(add_generation_prompt=True)`,
   which does not. Reproduce the code.
2. **Image first, then text.** The reference builder appends every image part
   before every text part regardless of how the caller interleaved them.
3. **The instruction gets a trailing period** when it does not already end in
   punctuation, and **empty content becomes the literal string `NULL`**. Both
   are undocumented behaviours of the reference embedder.
"""

from __future__ import annotations

import unicodedata

#: The instruction every input gets when the caller supplies no system message.
#: `chat_template.jinja` declares it as `default_system_message`, and
#: `config_sentence_transformers.json` repeats it as the default prompt. It
#: applies to documents *and* queries — unlike Qwen3-Embedding (text), this
#: family has no "bare" corpus mode.
DEFAULT_INSTRUCTION = "Represent the user's input."

#: The canonical retrieval instruction for a mixed text+image corpus, from the
#: model's own quick-starts. It is a CONSTANT, never a default: the shim never
#: invents instructions, and a caller who wants this one passes it as the system
#: message. Applying it automatically would put a query instruction on every
#: document too, which is the asymmetry the official examples exist to avoid.
QUERY_INSTRUCTION = "Retrieve images or text relevant to the user's query."

#: What `chat_template.jinja` emits for an image content part. The `llama`
#: backend substitutes llama-server's own per-process random media marker
#: instead; everything else uses this.
VISION_PLACEHOLDER = '<|vision_start|><|image_pad|><|vision_end|>'

#: The reference embedder's stand-in for an input with no text, image or video.
NULL_CONTENT = 'NULL'


def normalise_instruction(instruction: str | None) -> str:
    """The system message as the model was trained to see it.

    `None` — the caller sent no system message — falls back to
    :data:`DEFAULT_INSTRUCTION`. An **empty string** does not: that is a system
    message the caller wrote, and `chat_template.jinja` takes its
    `messages[0].role == 'system'` branch for it and emits
    ``<|im_start|>system\\n<|im_end|>\\n``. Collapsing the two would be the one
    place the shim invents an instruction the caller explicitly declined.

    Then a period is appended unless the last character is already punctuation
    — mirroring the reference embedder, including its leading truthiness test,
    which is what leaves an empty instruction empty::

        if instruction and not unicodedata.category(instruction[-1]).startswith('P'):
            instruction = instruction + '.'
    """
    text = DEFAULT_INSTRUCTION if instruction is None else instruction
    if text and not unicodedata.category(text[-1]).startswith('P'):
        text = text + '.'
    return text


def build_prompt(
    instruction: str | None,
    text: str,
    image_count: int = 0,
    media_marker: str = VISION_PLACEHOLDER,
) -> str:
    """The full prompt string for one input.

    `image_count` markers are emitted, in front of `text` — llama-server refuses
    a request whose marker count does not equal its `multimodal_data` length
    ("number of media markers in text (0) does not match number of bitmaps (1)"),
    so the count is the contract, not a detail.

    An input with neither text nor images becomes :data:`NULL_CONTENT`. The
    emptiness test is Python falsiness, exactly as the reference has it, so
    whitespace-only text is content and is left alone.
    """
    if image_count < 0:
        raise ValueError('image_count must not be negative')

    body = media_marker * image_count + text
    if not body:
        body = NULL_CONTENT

    return (
        f'<|im_start|>system\n{normalise_instruction(instruction)}<|im_end|>\n'
        f'<|im_start|>user\n{body}<|im_end|>\n'
        f'<|im_start|>assistant\n'
    )
