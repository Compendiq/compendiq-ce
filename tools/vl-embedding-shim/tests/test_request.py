"""Request-shape parsing: the vLLM `messages` shape, the plain `{model, input}`
shape, and the flat `Instruct:`-form conversion.
"""

import base64

import pytest

from vl_embedding_shim.request import ShimRequestError, parse_embeddings_request
from vl_embedding_shim.template import DEFAULT_INSTRUCTION, QUERY_INSTRUCTION

PNG_1PX = base64.b64decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
)
PNG_1PX_B64 = base64.b64encode(PNG_1PX).decode()


def messages_body(**over):
    body = {
        'model': 'qwen3-vl-embedding',
        'messages': [
            {'role': 'system', 'content': [{'type': 'text', 'text': QUERY_INSTRUCTION}]},
            {'role': 'user', 'content': [{'type': 'text', 'text': 'wie hoch ist der Turm?'}]},
            {'role': 'assistant', 'content': [{'type': 'text', 'text': ''}]},
        ],
        'encoding_format': 'float',
        'continue_final_message': True,
        'add_special_tokens': True,
    }
    body.update(over)
    return body


class TestMessagesShape:
    def test_yields_one_item_carrying_the_system_message_as_the_instruction(self):
        parsed = parse_embeddings_request(messages_body())
        assert parsed.shape == 'messages'
        assert len(parsed.items) == 1
        assert parsed.items[0].instruction == QUERY_INSTRUCTION
        assert parsed.items[0].text == 'wie hoch ist der Turm?'
        assert parsed.items[0].images == ()

    def test_carries_the_model_and_dimensions_through(self):
        parsed = parse_embeddings_request(messages_body(dimensions=512))
        assert parsed.model == 'qwen3-vl-embedding'
        assert parsed.dimensions == 512

    def test_absent_system_message_leaves_the_instruction_unset(self):
        # Unset, not "the default" — the template layer owns the fallback so
        # there is exactly one place the default is written down.
        parsed = parse_embeddings_request(messages_body(messages=[
            {'role': 'user', 'content': [{'type': 'text', 'text': 'hi'}]},
        ]))
        assert parsed.items[0].instruction is None

    def test_string_content_is_accepted_for_both_roles(self):
        parsed = parse_embeddings_request(messages_body(messages=[
            {'role': 'system', 'content': 'Represent the user\'s input'},
            {'role': 'user', 'content': 'hallo'},
        ]))
        assert parsed.items[0].instruction == "Represent the user's input"
        assert parsed.items[0].text == 'hallo'

    def test_image_url_parts_are_collected_in_order(self):
        parsed = parse_embeddings_request(messages_body(messages=[
            {'role': 'user', 'content': [
                {'type': 'image_url', 'image_url': {'url': f'data:image/png;base64,{PNG_1PX_B64}'}},
                {'type': 'image_url', 'image_url': {'url': 'https://example.invalid/b.jpg'}},
                {'type': 'text', 'text': 'zwei Bilder'},
            ]},
        ]))
        item = parsed.items[0]
        assert [ref.url for ref in item.images] == [
            f'data:image/png;base64,{PNG_1PX_B64}',
            'https://example.invalid/b.jpg',
        ]
        assert item.text == 'zwei Bilder'

    def test_text_parts_are_concatenated_in_order_and_images_still_lead(self):
        # The reference builder appends every image, then every text — the
        # user's interleaving is not preserved, matching qwen3_vl_embedding.py.
        parsed = parse_embeddings_request(messages_body(messages=[
            {'role': 'user', 'content': [
                {'type': 'text', 'text': 'a'},
                {'type': 'image_url', 'image_url': {'url': 'https://example.invalid/b.jpg'}},
                {'type': 'text', 'text': 'b'},
            ]},
        ]))
        assert parsed.items[0].text == 'ab'
        assert len(parsed.items[0].images) == 1

    def test_empty_user_content_is_allowed_and_becomes_NULL_downstream(self):
        parsed = parse_embeddings_request(messages_body(messages=[
            {'role': 'user', 'content': []},
        ]))
        assert parsed.items[0].text == ''
        assert parsed.items[0].images == ()

    def test_a_trailing_assistant_with_content_is_refused(self):
        # `continue_final_message: true` means the assistant turn is a
        # continuation point, not a message. Non-empty content would be
        # silently dropped, so refuse it instead.
        with pytest.raises(ShimRequestError, match='assistant'):
            parse_embeddings_request(messages_body(messages=[
                {'role': 'user', 'content': 'hi'},
                {'role': 'assistant', 'content': 'here you go'},
            ]))

    def test_an_assistant_that_is_not_last_is_refused(self):
        with pytest.raises(ShimRequestError, match='assistant'):
            parse_embeddings_request(messages_body(messages=[
                {'role': 'assistant', 'content': ''},
                {'role': 'user', 'content': 'hi'},
            ]))

    def test_two_user_messages_are_refused(self):
        with pytest.raises(ShimRequestError, match='user'):
            parse_embeddings_request(messages_body(messages=[
                {'role': 'user', 'content': 'a'},
                {'role': 'user', 'content': 'b'},
            ]))

    def test_no_user_message_is_refused(self):
        with pytest.raises(ShimRequestError, match='user'):
            parse_embeddings_request(messages_body(messages=[
                {'role': 'system', 'content': 'x'},
            ]))

    def test_a_system_message_that_is_not_first_is_refused(self):
        with pytest.raises(ShimRequestError, match='system'):
            parse_embeddings_request(messages_body(messages=[
                {'role': 'user', 'content': 'a'},
                {'role': 'system', 'content': 'b'},
            ]))

    def test_an_unknown_content_part_type_is_refused(self):
        with pytest.raises(ShimRequestError, match='input_audio'):
            parse_embeddings_request(messages_body(messages=[
                {'role': 'user', 'content': [{'type': 'input_audio', 'input_audio': {}}]},
            ]))

    def test_an_unknown_role_is_refused(self):
        with pytest.raises(ShimRequestError, match='tool'):
            parse_embeddings_request(messages_body(messages=[
                {'role': 'tool', 'content': 'x'},
            ]))


class TestPlainInputShape:
    def test_a_single_string_yields_one_item_under_the_default_instruction(self):
        parsed = parse_embeddings_request({'model': 'm', 'input': 'ein Satz'})
        assert parsed.shape == 'input'
        assert len(parsed.items) == 1
        assert parsed.items[0].text == 'ein Satz'
        assert parsed.items[0].instruction is None
        assert parsed.items[0].converted_from_flat is False

    def test_a_list_yields_one_item_per_string_in_order(self):
        parsed = parse_embeddings_request({'model': 'm', 'input': ['a', 'b', 'c']})
        assert [item.text for item in parsed.items] == ['a', 'b', 'c']

    def test_an_empty_list_is_refused(self):
        with pytest.raises(ShimRequestError, match='input'):
            parse_embeddings_request({'model': 'm', 'input': []})

    def test_a_non_string_element_is_refused(self):
        # Token-id arrays are a real OpenAI input shape and the shim cannot
        # detokenize them; refusing beats embedding "[1, 2, 3]".
        with pytest.raises(ShimRequestError, match='string'):
            parse_embeddings_request({'model': 'm', 'input': [[1, 2, 3]]})

    def test_plain_input_never_carries_images(self):
        parsed = parse_embeddings_request({'model': 'm', 'input': 'x'})
        assert parsed.items[0].images == ()


class TestFlatInstructConversion:
    FLAT = (
        'Instruct: Given a search query, retrieve relevant passages from the '
        'knowledge base that answer the query\nQuery:wie hoch ist der Turm?'
    )

    def test_converts_the_flat_form_into_system_plus_user(self):
        parsed = parse_embeddings_request({'model': 'm', 'input': self.FLAT})
        item = parsed.items[0]
        assert item.instruction == (
            'Given a search query, retrieve relevant passages from the '
            'knowledge base that answer the query'
        )
        assert item.text == 'wie hoch ist der Turm?'
        assert item.converted_from_flat is True

    def test_the_query_keeps_every_byte_after_the_separator(self):
        # query-instruction.ts: "There is no space after `Query:`" — so a query
        # whose OWN first character is a space really does produce
        # "…\nQuery: leading space". Stripping it would make the shim embed a
        # different string than the one production sends.
        parsed = parse_embeddings_request(
            {'model': 'm', 'input': 'Instruct: task\nQuery: leading space'},
        )
        assert parsed.items[0].converted_from_flat is True
        assert parsed.items[0].text == ' leading space'

    def test_a_differently_spelled_separator_is_not_the_apps_prefix(self):
        parsed = parse_embeddings_request({'model': 'm', 'input': 'Instruct: task\nQuery : x'})
        assert parsed.items[0].converted_from_flat is False
        assert parsed.items[0].text == 'Instruct: task\nQuery : x'

    def test_splits_on_the_first_separator_only(self):
        parsed = parse_embeddings_request(
            {'model': 'm', 'input': 'Instruct: t\nQuery:a\nQuery:b'},
        )
        assert parsed.items[0].text == 'a\nQuery:b'

    def test_an_ordinary_document_is_left_alone(self):
        parsed = parse_embeddings_request({'model': 'm', 'input': 'Die Turmhöhe beträgt 12 m.'})
        assert parsed.items[0].instruction is None
        assert parsed.items[0].converted_from_flat is False

    def test_an_empty_task_is_not_a_conversion(self):
        parsed = parse_embeddings_request({'model': 'm', 'input': 'Instruct: \nQuery:x'})
        assert parsed.items[0].converted_from_flat is False

    def test_conversion_can_be_disabled(self):
        parsed = parse_embeddings_request(
            {'model': 'm', 'input': self.FLAT}, convert_flat_instruct=False,
        )
        assert parsed.items[0].converted_from_flat is False
        assert parsed.items[0].text == self.FLAT

    def test_the_messages_shape_is_never_converted(self):
        # A caller who spells the flat form inside a user message meant it.
        parsed = parse_embeddings_request(messages_body(messages=[
            {'role': 'user', 'content': self.FLAT},
        ]))
        assert parsed.items[0].converted_from_flat is False
        assert parsed.items[0].text == self.FLAT


class TestTopLevelValidation:
    def test_both_input_and_messages_is_refused(self):
        with pytest.raises(ShimRequestError, match='exactly one'):
            parse_embeddings_request({'model': 'm', 'input': 'a', 'messages': []})

    def test_neither_is_refused(self):
        with pytest.raises(ShimRequestError, match='exactly one'):
            parse_embeddings_request({'model': 'm'})

    def test_base64_encoding_format_is_refused(self):
        with pytest.raises(ShimRequestError, match='encoding_format'):
            parse_embeddings_request({'model': 'm', 'input': 'a', 'encoding_format': 'base64'})

    def test_float_encoding_format_is_accepted(self):
        parse_embeddings_request({'model': 'm', 'input': 'a', 'encoding_format': 'float'})

    def test_non_integer_dimensions_is_refused(self):
        with pytest.raises(ShimRequestError, match='dimensions'):
            parse_embeddings_request({'model': 'm', 'input': 'a', 'dimensions': '512'})

    def test_zero_dimensions_is_refused(self):
        with pytest.raises(ShimRequestError, match='dimensions'):
            parse_embeddings_request({'model': 'm', 'input': 'a', 'dimensions': 0})

    def test_a_bool_is_not_an_integer_dimension(self):
        with pytest.raises(ShimRequestError, match='dimensions'):
            parse_embeddings_request({'model': 'm', 'input': 'a', 'dimensions': True})


class TestDefaultInstructionIsNotInvented:
    def test_parsing_never_fills_in_an_instruction(self):
        for body in (
            {'model': 'm', 'input': 'x'},
            messages_body(messages=[{'role': 'user', 'content': 'x'}]),
        ):
            assert parse_embeddings_request(body).items[0].instruction is None

    def test_the_default_is_only_a_template_constant(self):
        assert DEFAULT_INSTRUCTION == "Represent the user's input."
