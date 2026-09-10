"""The chat template, byte for byte.

Every expectation here is transcribed from the research pack's §1.4, which in
turn quotes the paper's "Input Template for Embedding", the shipped
`chat_template.jinja`, and the reference embedder `scripts/qwen3_vl_embedding.py`.
A byte that drifts here is a silently different token sequence and therefore a
different, off-distribution vector — the single easiest thing to get wrong.
"""

from vl_embedding_shim.template import (
    DEFAULT_INSTRUCTION,
    QUERY_INSTRUCTION,
    VISION_PLACEHOLDER,
    build_prompt,
    normalise_instruction,
)


class TestExactTemplates:
    def test_text_query_with_retrieval_instruction(self):
        # research §1.4, "Text query (with a retrieval instruction)"
        assert build_prompt(
            instruction=QUERY_INSTRUCTION,
            text='A woman playing with her dog on a beach at sunset.',
        ) == (
            "<|im_start|>system\n"
            "Retrieve images or text relevant to the user's query.<|im_end|>\n"
            '<|im_start|>user\n'
            'A woman playing with her dog on a beach at sunset.<|im_end|>\n'
            '<|im_start|>assistant\n'
        )

    def test_image_only(self):
        # research §1.4, "Image only" — the default instruction, and the user
        # message is nothing but the vision placeholder.
        assert build_prompt(instruction=None, text='', image_count=1) == (
            "<|im_start|>system\n"
            "Represent the user's input.<|im_end|>\n"
            '<|im_start|>user\n'
            '<|vision_start|><|image_pad|><|vision_end|><|im_end|>\n'
            '<|im_start|>assistant\n'
        )

    def test_image_then_text(self):
        # research §1.4, "Image + text": the reference builder appends image
        # first, then text.
        assert build_prompt(
            instruction=None,
            text='A woman shares a joyful moment…',
            image_count=1,
        ) == (
            "<|im_start|>system\n"
            "Represent the user's input.<|im_end|>\n"
            '<|im_start|>user\n'
            '<|vision_start|><|image_pad|><|vision_end|>A woman shares a joyful moment…<|im_end|>\n'
            '<|im_start|>assistant\n'
        )

    def test_ends_with_assistant_newline_and_nothing_after_it(self):
        # The final `\n` after `assistant` is the token that gets pooled
        # (research §1.4). Anything appended after it pools a different
        # position.
        prompt = build_prompt(instruction=None, text='x')
        assert prompt.endswith('<|im_start|>assistant\n')
        assert not prompt.endswith('<|endoftext|>')


class TestInstruction:
    def test_default_is_represent_the_users_input(self):
        assert DEFAULT_INSTRUCTION == "Represent the user's input."

    def test_query_instruction_constant_is_the_canonical_one(self):
        assert QUERY_INSTRUCTION == 'Retrieve images or text relevant to the user\'s query.'

    def test_missing_instruction_falls_back_to_the_default_never_the_query_one(self):
        # Rule (1): the shim never invents instructions. An absent system
        # message is the DEFAULT, not the retrieval instruction — that one is
        # the caller's to pass.
        assert DEFAULT_INSTRUCTION in build_prompt(instruction=None, text='q')
        assert QUERY_INSTRUCTION not in build_prompt(instruction=None, text='q')

    def test_trailing_period_appended_when_it_ends_without_punctuation(self):
        # reference embedder: `if instruction and not
        # unicodedata.category(instruction[-1]).startswith('P'): instruction += '.'`
        assert normalise_instruction('Find images matching this description') == \
            'Find images matching this description.'

    def test_existing_punctuation_is_left_alone(self):
        assert normalise_instruction('Represent the user\'s input.') == \
            'Represent the user\'s input.'
        assert normalise_instruction('What is this?') == 'What is this?'

    def test_only_an_absent_instruction_becomes_the_default(self):
        # `None` is "the caller sent no system message"; `''` is "the caller
        # sent an empty one". `chat_template.jinja` renders the second as
        # `<|im_start|>system\n<|im_end|>\n`, so collapsing the two would have
        # the shim inventing an instruction the caller explicitly declined —
        # the one exception rule (1) would otherwise have.
        assert normalise_instruction(None) == DEFAULT_INSTRUCTION
        assert normalise_instruction('') == ''

    def test_an_empty_instruction_renders_an_empty_system_message(self):
        assert build_prompt(instruction='', text='x') == (
            '<|im_start|>system\n<|im_end|>\n'
            '<|im_start|>user\nx<|im_end|>\n'
            '<|im_start|>assistant\n'
        )

    def test_non_latin_instruction_still_gets_its_period(self):
        assert normalise_instruction('Beschreibe die Eingabe') == 'Beschreibe die Eingabe.'


class TestEmptyContent:
    def test_no_text_and_no_image_is_the_literal_NULL(self):
        # reference embedder: `if not text and not image and not video:
        # content.append({'type': 'text', 'text': "NULL"})`
        assert '\nNULL<|im_end|>' in build_prompt(instruction=None, text='')

    def test_whitespace_only_text_is_not_NULL(self):
        # The reference tests falsiness, and '  ' is truthy in Python. Matching
        # it exactly is the point: a "tidier" strip() here is a different
        # prompt from the one production sends.
        assert 'NULL' not in build_prompt(instruction=None, text='  ')

    def test_an_image_alone_is_never_NULL(self):
        assert 'NULL' not in build_prompt(instruction=None, text='', image_count=1)


class TestMediaMarkers:
    def test_marker_count_equals_image_count(self):
        marker = '<__media_ABC__>'
        prompt = build_prompt(instruction=None, text='caption', image_count=3, media_marker=marker)
        assert prompt.count(marker) == 3

    def test_markers_precede_the_text(self):
        marker = '<__media_ABC__>'
        prompt = build_prompt(instruction=None, text='caption', image_count=2, media_marker=marker)
        assert prompt.index(marker) < prompt.index('caption')

    def test_zero_images_emits_no_marker(self):
        marker = '<__media_ABC__>'
        assert marker not in build_prompt(
            instruction=None, text='caption', image_count=0, media_marker=marker,
        )

    def test_default_marker_is_the_models_own_vision_placeholder(self):
        # llama-server randomises its marker per process and the shim reads it
        # from /props; every other path (and the byte-for-byte template above)
        # uses the model's real placeholder.
        assert VISION_PLACEHOLDER == '<|vision_start|><|image_pad|><|vision_end|>'
        assert VISION_PLACEHOLDER in build_prompt(instruction=None, text='', image_count=1)
