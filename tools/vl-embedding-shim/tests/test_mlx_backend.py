"""The in-process MLX backend, driven with a fake encoder.

`mlx-embeddings` is a library, not a server: `load()` gives `(model, processor)`
and `model.process(inputs, processor=processor)` embeds a list of
`{text, image, instruction}` dicts. The three things worth pinning are the ones
where a plausible-looking call produces a *different prompt* than the llama
backend builds:

* an empty text must be passed as `None`, not `''` — the library's
  `_format_mm_content` only substitutes the literal `NULL` when the content
  list comes out empty, and an empty string is still a text part;
* the instruction must arrive already normalised (trailing period), because the
  library's processor does not apply the reference embedder's period rule;
* the model is loaded once, not per request.
"""

import io

import pytest

from vl_embedding_shim.backends.base import BackendError, ResolvedItem
from vl_embedding_shim.backends.mlx import MlxBackend


def png_bytes(width=8, height=4) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new('RGB', (width, height), (1, 2, 3)).save(buf, format='PNG')
    return buf.getvalue()


class FakeArray:
    def __init__(self, rows):
        self._rows = rows

    def tolist(self):
        return self._rows


class FakeLanguageModel:
    def __init__(self):
        self._position_ids = 'stale'
        self._rope_deltas = 'stale'


class FakeModel:
    def __init__(self, rows=None):
        self.calls = []
        self._rows = rows
        self.language_model = FakeLanguageModel()

    def process(self, inputs, processor=None):
        self.calls.append({
            'inputs': inputs,
            'processor': processor,
            'position_ids': self.language_model._position_ids,
            'rope_deltas': self.language_model._rope_deltas,
        })
        # The library caches these on the first call and reads them back on the
        # next one; a fake that never sets them cannot catch a missing reset.
        self.language_model._position_ids = 'cached-2d'
        self.language_model._rope_deltas = 'cached'
        rows = self._rows or [[0.6, 0.8] for _ in inputs]
        return FakeArray(rows)


class FakeProcessor:
    """Carries the two fields `mlx_embeddings.Processor` stamps onto an image.

    The values are the library's own 0.1.0 defaults, so a backend that leaves
    them alone is visible as the number it left behind.
    """

    def __init__(self):
        self.min_pixels = 4096
        self.max_pixels = 1_843_200


def make(rows=None, processor=None, **kwargs):
    model = FakeModel(rows)
    processor = FakeProcessor() if processor is None else processor
    loads = []

    def loader(path):
        loads.append(path)
        return model, processor

    be = MlxBackend('mlx-community/Qwen3-VL-Embedding-2B-8bit', loader=loader, **kwargs)
    return be, model, loads


class TestLoading:
    def test_loads_lazily_and_only_once(self):
        be, model, loads = make()
        assert loads == []
        be.embed([ResolvedItem(text='a', instruction=None)])
        be.embed([ResolvedItem(text='b', instruction=None)])
        assert loads == ['mlx-community/Qwen3-VL-Embedding-2B-8bit']

    def test_info_reports_the_model_path_as_the_served_id(self):
        be, _model, _loads = make()
        info = be.info()
        assert info.backend == 'mlx'
        assert info.model_id == 'mlx-community/Qwen3-VL-Embedding-2B-8bit'
        # The MLX path is in-process and always has the projector: vision is a
        # property of the checkpoint, not of a separate server.
        assert info.vision is True

    def test_an_explicit_model_id_wins(self):
        be, _m, _l = make(model_id='qwen3-vl-2b')
        assert be.info().model_id == 'qwen3-vl-2b'


class TestInputBuilding:
    def test_passes_text_and_the_normalised_instruction(self):
        be, model, _ = make()
        be.embed([ResolvedItem(text='hallo', instruction='Find images matching this description')])
        assert model.calls[0]['inputs'] == [{
            'text': 'hallo',
            'instruction': 'Find images matching this description.',
        }]

    def test_an_absent_instruction_becomes_the_default_with_its_period(self):
        be, model, _ = make()
        be.embed([ResolvedItem(text='hallo', instruction=None)])
        assert model.calls[0]['inputs'][0]['instruction'] == "Represent the user's input."

    def test_an_explicitly_empty_instruction_is_passed_through_as_empty(self):
        # And the library then substitutes its own default for it —
        # `processor.py:256` is `item.get("instruction") or
        # self.default_embedding_instruction`, so any falsy value is the
        # default and there is no way to express "an empty system message"
        # through its API. This backend therefore CANNOT match the `llama`
        # one for that one body; the divergence is named in the module
        # docstring and the README rather than papered over with a sentinel
        # that would be a third prompt again.
        be, model, _ = make()
        be.embed([ResolvedItem(text='hallo', instruction='')])
        assert model.calls[0]['inputs'][0]['instruction'] == ''

    def test_empty_text_is_omitted_so_the_library_emits_NULL(self):
        # Passing text='' would give the library a non-empty content list and
        # therefore an empty text part instead of the literal NULL.
        be, model, _ = make()
        be.embed([ResolvedItem(text='', instruction=None)])
        assert 'text' not in model.calls[0]['inputs'][0]

    def test_whitespace_only_text_is_kept(self):
        be, model, _ = make()
        be.embed([ResolvedItem(text='  ', instruction=None)])
        assert model.calls[0]['inputs'][0]['text'] == '  '

    def test_images_are_decoded_to_pil_and_passed_as_a_list(self):
        from PIL import Image

        be, model, _ = make()
        be.embed([ResolvedItem(text='caption', instruction=None, images=(png_bytes(8, 4),))])
        images = model.calls[0]['inputs'][0]['image']
        assert isinstance(images, list) and len(images) == 1
        assert isinstance(images[0], Image.Image)
        assert images[0].size == (8, 4)

    def test_a_palette_image_is_converted_to_rgb(self):
        # The case above builds an already-RGB PNG, so the conversion branch
        # never ran and deleting it left the suite green (review r3). A palette
        # or CMYK source reaching the vision tower with the wrong channel count
        # is what the branch exists to prevent, and only a non-RGB source can
        # show that it does.
        from PIL import Image

        buf = io.BytesIO()
        Image.new('RGB', (8, 4), (1, 2, 3)).convert('P').save(buf, format='PNG')
        palette_png = buf.getvalue()
        assert Image.open(io.BytesIO(palette_png)).mode == 'P', 'fixture is not a palette image'

        be, model, _ = make()
        be.embed([ResolvedItem(text='caption', instruction=None, images=(palette_png,))])
        image = model.calls[0]['inputs'][0]['image'][0]
        assert image.mode == 'RGB'
        assert image.size == (8, 4)

    def test_no_images_means_no_image_key(self):
        be, model, _ = make()
        be.embed([ResolvedItem(text='x', instruction=None)])
        assert 'image' not in model.calls[0]['inputs'][0]

    def test_a_batch_is_one_process_call_in_order(self):
        be, model, _ = make(rows=[[1.0, 0.0], [0.0, 1.0]])
        out = be.embed([
            ResolvedItem(text='a', instruction=None),
            ResolvedItem(text='b', instruction=None),
        ])
        assert len(model.calls) == 1
        assert [i.get('text') for i in model.calls[0]['inputs']] == ['a', 'b']
        assert out == [[1.0, 0.0], [0.0, 1.0]]

    def test_an_undecodable_image_is_a_backend_error(self):
        be, _model, _ = make()
        with pytest.raises(BackendError, match='decode'):
            be.embed([ResolvedItem(text='', instruction=None, images=(b'not an image',))])


class TestThePixelBudget:
    """The two backends must cost an image the same, and only one of them can be told to.

    `mlx_embeddings` 0.1.0 stamps its `Processor.max_pixels` onto every image
    content block, and `from_pretrained` fills that field from the library's own
    `MAX_PIXELS = 1800 * 32 * 32 = 1_843_200` — the reference *script*'s
    permissive runtime default, 1.41x the 1_310_720 the checkpoint declares and
    the paper says training saw. Research §5.1: the higher one is plausibly
    *worse*, not merely slower. The field is pinned after the load rather than
    passed through `load(tokenizer_config=…)`, so it stays on the `Loader` seam
    these tests drive and a library that stopped honouring the kwarg could not
    ignore it silently (review r3).
    """

    def test_the_checkpoints_budget_replaces_the_librarys_default(self):
        processor = FakeProcessor()
        assert processor.max_pixels == 1_843_200, 'fixture no longer models the library'
        be, _model, _ = make(processor=processor)
        be.embed([ResolvedItem(text='x', instruction=None)])
        assert processor.max_pixels == 1_310_720

    def test_the_floor_is_left_alone(self):
        # `MIN_PIXELS = 4 * 32 * 32` already equals the checkpoint's, so there
        # is nothing to correct and nothing to pin a second value against.
        processor = FakeProcessor()
        be, _model, _ = make(processor=processor)
        be.embed([ResolvedItem(text='x', instruction=None)])
        assert processor.min_pixels == 4096

    def test_a_processor_without_the_field_is_not_a_crash(self):
        # A future release that renames or drops it must degrade to the
        # library's budget, not to a 502 on every request.
        class Bare:
            pass

        processor = Bare()
        be, _model, _ = make(processor=processor)
        assert be.embed([ResolvedItem(text='x', instruction=None)]) == [[0.6, 0.8]]
        assert not hasattr(processor, 'max_pixels'), 'the field was invented rather than set'

    def test_it_is_pinned_once_at_load_not_per_request(self):
        processor = FakeProcessor()
        be, _model, _ = make(processor=processor)
        be.embed([ResolvedItem(text='a', instruction=None)])
        processor.max_pixels = 999  # a caller reaching past the shim
        be.embed([ResolvedItem(text='b', instruction=None)])
        assert processor.max_pixels == 999


class TestPositionIdCacheReset:
    """`mlx-embeddings` 0.1.0 serves exactly one text request per loaded model.

    `compute_qwen3_vl_hidden_states` caches `language_model._position_ids` and
    reads it back as `[:, :, :n]`, but the text-only branch stores a 2-D array,
    so the SECOND call dies with `ValueError: Too many indices for array with
    2 dimensions`. The library resets the cache itself — but only when
    `pixel_values is not None`, i.e. only for image requests.

    Measured on `mlx-community/Qwen3-VL-Embedding-2B-8bit`: first text call OK,
    every later text call fails, and a reset before each call fixes all of them.
    """

    def test_the_cache_is_cleared_before_every_call(self):
        be, model, _ = make()
        be.embed([ResolvedItem(text='a', instruction=None)])
        be.embed([ResolvedItem(text='b', instruction=None)])
        assert [call['position_ids'] for call in model.calls] == [None, None]
        assert [call['rope_deltas'] for call in model.calls] == [None, None]

    def test_a_model_without_a_language_model_attribute_is_not_a_crash(self):
        # The workaround must not become a hard dependency on the library's
        # internals: a future version that drops the attribute should still work.
        class Bare:
            def __init__(self):
                self.calls = []

            def process(self, inputs, processor=None):
                self.calls.append(inputs)
                return FakeArray([[1.0, 0.0] for _ in inputs])

        bare = Bare()
        be = MlxBackend('x', loader=lambda path: (bare, FakeProcessor()))
        assert be.embed([ResolvedItem(text='a', instruction=None)]) == [[1.0, 0.0]]


class TestOutput:
    def test_returns_plain_python_floats(self):
        be, _model, _ = make(rows=[[1, 2]])
        out = be.embed([ResolvedItem(text='a', instruction=None)])
        assert out == [[1.0, 2.0]]
        assert all(isinstance(x, float) for x in out[0])

    def test_a_row_count_mismatch_is_a_backend_error(self):
        be, _model, _ = make(rows=[[1.0, 2.0]])
        with pytest.raises(BackendError, match='2'):
            be.embed([
                ResolvedItem(text='a', instruction=None),
                ResolvedItem(text='b', instruction=None),
            ])
