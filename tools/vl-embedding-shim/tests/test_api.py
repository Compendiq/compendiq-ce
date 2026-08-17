"""The HTTP surface: the OpenAI embeddings response shape, /v1/models, /healthz.

The backend is a fake here — what is under test is the contract the app and the
retrieval eval read: `data[i].embedding`, in request order, unit-norm, truncated
when `dimensions` was asked for.
"""

import base64
import io
import math

import pytest
from fastapi.testclient import TestClient

from vl_embedding_shim.app import create_app
from vl_embedding_shim.backends.base import BackendError, BackendInfo, ResolvedItem
from vl_embedding_shim.config import Settings
from vl_embedding_shim.service import EmbeddingService


def png_data_uri(width=8, height=4) -> str:
    from PIL import Image

    buf = io.BytesIO()
    Image.new('RGB', (width, height), (7, 7, 7)).save(buf, format='PNG')
    return 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode()


class FakeBackend:
    def __init__(self, rows=None, vision=True, fail=None, healthy=True):
        self.rows = rows
        self.vision = vision
        self.fail = fail
        self.healthy = healthy
        self.seen: list[list[ResolvedItem]] = []

    def info(self) -> BackendInfo:
        if not self.healthy:
            raise BackendError('llama-server is not answering /props')
        return BackendInfo(
            backend='fake', model_id='fake-vl-embedding', vision=self.vision, details={},
        )

    def embed(self, items):
        if self.fail:
            raise BackendError(self.fail)
        self.seen.append(list(items))
        if self.rows is not None:
            return [list(row) for row in self.rows]
        # A deterministic non-unit vector, so a missing renormalise is visible.
        return [[3.0, 4.0, 0.0, 0.0] for _ in items]


def client(backend=None, **settings_over):
    backend = backend or FakeBackend()
    settings = Settings(backend='llama', **settings_over)
    return TestClient(create_app(EmbeddingService(backend, settings))), backend


def norm(vec):
    return math.sqrt(sum(x * x for x in vec))


class TestResponseShape:
    def test_the_openai_embeddings_envelope(self):
        c, _ = client()
        body = c.post('/v1/embeddings', json={'model': 'm', 'input': 'hallo'}).json()
        assert body['object'] == 'list'
        assert body['data'][0]['object'] == 'embedding'
        assert body['data'][0]['index'] == 0
        assert isinstance(body['data'][0]['embedding'], list)
        assert body['model'] == 'fake-vl-embedding'
        assert body['usage'] == {'prompt_tokens': 0, 'total_tokens': 0}

    def test_one_datum_per_input_string_in_order(self):
        c, _ = client(FakeBackend(rows=[[1.0, 0.0], [0.0, 1.0], [1.0, 1.0]]))
        body = c.post('/v1/embeddings', json={'model': 'm', 'input': ['a', 'b', 'c']}).json()
        assert [d['index'] for d in body['data']] == [0, 1, 2]
        assert body['data'][0]['embedding'] == pytest.approx([1.0, 0.0])

    def test_the_messages_shape_returns_exactly_one_datum(self):
        c, _ = client()
        body = c.post('/v1/embeddings', json={
            'model': 'm',
            'messages': [
                {'role': 'system', 'content': [{'type': 'text', 'text': 'Represent it.'}]},
                {'role': 'user', 'content': [{'type': 'text', 'text': 'hallo'}]},
                {'role': 'assistant', 'content': [{'type': 'text', 'text': ''}]},
            ],
            'continue_final_message': True,
            'add_special_tokens': True,
        }).json()
        assert len(body['data']) == 1

    def test_output_is_always_l2_normalised(self):
        c, _ = client()
        body = c.post('/v1/embeddings', json={'model': 'm', 'input': 'x'}).json()
        assert norm(body['data'][0]['embedding']) == pytest.approx(1.0)

    def test_the_unprefixed_alias_serves_the_same_thing(self):
        c, _ = client()
        assert c.post('/embeddings', json={'model': 'm', 'input': 'x'}).status_code == 200


class TestDimensions:
    def test_truncates_and_renormalises(self):
        c, _ = client(FakeBackend(rows=[[1.0, 1.0, 1.0, 1.0]]))
        body = c.post('/v1/embeddings', json={'model': 'm', 'input': 'x', 'dimensions': 2}).json()
        assert len(body['data'][0]['embedding']) == 2
        assert norm(body['data'][0]['embedding']) == pytest.approx(1.0)

    def test_refuses_more_than_native_with_a_400(self):
        c, _ = client(FakeBackend(rows=[[1.0, 1.0]]))
        res = c.post('/v1/embeddings', json={'model': 'm', 'input': 'x', 'dimensions': 4096})
        assert res.status_code == 400
        assert 'native' in res.json()['error']['message']


class TestInstructionPlumbing:
    def test_a_plain_input_reaches_the_backend_with_no_instruction(self):
        c, backend = client()
        c.post('/v1/embeddings', json={'model': 'm', 'input': 'hallo'})
        assert backend.seen[0][0].instruction is None
        assert backend.seen[0][0].text == 'hallo'

    def test_a_flat_instruct_string_arrives_split_apart(self):
        c, backend = client()
        c.post('/v1/embeddings', json={
            'model': 'm',
            'input': 'Instruct: Given a search query, retrieve relevant passages\nQuery:wie hoch?',
        })
        item = backend.seen[0][0]
        assert item.instruction == 'Given a search query, retrieve relevant passages'
        assert item.text == 'wie hoch?'

    def test_the_conversion_is_logged(self, caplog):
        c, _ = client()
        with caplog.at_level('INFO'):
            c.post('/v1/embeddings', json={
                'model': 'm', 'input': 'Instruct: t\nQuery:q',
            })
        assert any('Instruct:' in r.getMessage() for r in caplog.records)

    def test_the_system_message_reaches_the_backend_verbatim(self):
        c, backend = client()
        c.post('/v1/embeddings', json={'model': 'm', 'messages': [
            {'role': 'system', 'content': 'Retrieve images or text relevant to the user\'s query.'},
            {'role': 'user', 'content': 'hund am strand'},
        ]})
        assert backend.seen[0][0].instruction == \
            "Retrieve images or text relevant to the user's query."


class TestImages:
    def test_a_data_uri_reaches_the_backend_as_bytes(self):
        c, backend = client()
        res = c.post('/v1/embeddings', json={'model': 'm', 'messages': [
            {'role': 'user', 'content': [
                {'type': 'image_url', 'image_url': {'url': png_data_uri()}},
                {'type': 'text', 'text': 'ein bild'},
            ]},
        ]})
        assert res.status_code == 200
        item = backend.seen[0][0]
        assert len(item.images) == 1
        assert item.images[0].startswith(b'\x89PNG')

    def test_a_broken_data_uri_is_a_400(self):
        c, _ = client()
        res = c.post('/v1/embeddings', json={'model': 'm', 'messages': [
            {'role': 'user', 'content': [
                {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,####'}},
            ]},
        ]})
        assert res.status_code == 400
        assert 'base64' in res.json()['error']['message']

    def test_remote_urls_are_refused_when_disabled(self):
        c, _ = client(allow_remote_images=False)
        res = c.post('/v1/embeddings', json={'model': 'm', 'messages': [
            {'role': 'user', 'content': [
                {'type': 'image_url', 'image_url': {'url': 'https://example.invalid/a.png'}},
            ]},
        ]})
        assert res.status_code == 400
        assert 'remote' in res.json()['error']['message']

    def test_the_pixel_guard_refuses_an_oversized_image_when_a_ceiling_is_set(self):
        c, _ = client(max_pixels=64)
        res = c.post('/v1/embeddings', json={'model': 'm', 'messages': [
            {'role': 'user', 'content': [
                {'type': 'image_url', 'image_url': {'url': png_data_uri(100, 100)}},
            ]},
        ]})
        assert res.status_code == 400
        assert 'max-pixels' in res.json()['error']['message']

    def test_no_ceiling_lets_a_large_image_through(self):
        c, _ = client()
        res = c.post('/v1/embeddings', json={'model': 'm', 'messages': [
            {'role': 'user', 'content': [
                {'type': 'image_url', 'image_url': {'url': png_data_uri(1200, 1200)}},
            ]},
        ]})
        assert res.status_code == 200


class TestErrors:
    def test_a_malformed_body_is_a_400_in_the_openai_error_envelope(self):
        c, _ = client()
        res = c.post('/v1/embeddings', json={'model': 'm'})
        assert res.status_code == 400
        assert res.json()['error']['type'] == 'invalid_request_error'
        assert 'exactly one' in res.json()['error']['message']

    def test_a_backend_failure_is_a_502(self):
        c, _ = client(FakeBackend(fail='llama-server said no'))
        res = c.post('/v1/embeddings', json={'model': 'm', 'input': 'x'})
        assert res.status_code == 502
        assert 'llama-server said no' in res.json()['error']['message']


class TestConcurrency:
    """Embedding work is blocking, and both backends dislike being re-entered.

    `llama` holds a synchronous `httpx.Client`; `mlx` runs the model in-process
    and the shim mutates `language_model._position_ids` right before each
    `process()` call, so two overlapping requests could reset the cache under
    each other. The service therefore serialises embedding — and it must do so
    with a lock, NOT by blocking the event loop, or `/healthz` goes unanswerable
    for the whole of a long embed.
    """

    def test_embedding_is_serialised(self):
        import threading
        import time

        class SlowBackend(FakeBackend):
            def __init__(self):
                super().__init__()
                self.live = 0
                self.peak = 0
                self._guard = threading.Lock()

            def embed(self, items):
                with self._guard:
                    self.live += 1
                    self.peak = max(self.peak, self.live)
                time.sleep(0.05)
                with self._guard:
                    self.live -= 1
                return [[3.0, 4.0] for _ in items]

        backend = SlowBackend()
        c = TestClient(create_app(EmbeddingService(backend, Settings(backend='llama'))))
        errors: list[Exception] = []

        def call():
            try:
                assert c.post('/v1/embeddings', json={'model': 'm', 'input': 'x'}).status_code == 200
            except Exception as exc:  # pragma: no cover - reported below
                errors.append(exc)

        threads = [threading.Thread(target=call) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors
        assert backend.peak == 1, f'{backend.peak} concurrent embeds reached the backend'

    def test_embedding_runs_off_the_event_loop(self):
        # `backend.embed` is blocking — a synchronous httpx call, or a whole
        # MLX forward pass. Run straight from an `async def` handler it would
        # own the loop for its full duration, so /healthz and /v1/models go
        # unanswerable for the length of every embed.
        #
        # `asyncio.get_running_loop()` succeeds only when called ON a thread
        # that is running a loop, which is exactly the distinction: it raises
        # from a threadpool worker and returns from the loop thread. (Starlette's
        # TestClient gives each request its own portal, so a wall-clock
        # "was /healthz answerable" test would pass either way and prove
        # nothing — this asserts the mechanism instead.)
        import asyncio

        seen: dict[str, bool] = {}

        class ProbeBackend(FakeBackend):
            def embed(self, items):
                try:
                    asyncio.get_running_loop()
                    seen['on_event_loop'] = True
                except RuntimeError:
                    seen['on_event_loop'] = False
                return [[3.0, 4.0] for _ in items]

        c = TestClient(create_app(EmbeddingService(ProbeBackend(), Settings(backend='llama'))))
        assert c.post('/v1/embeddings', json={'model': 'm', 'input': 'x'}).status_code == 200
        assert seen['on_event_loop'] is False


class TestModelsAndHealth:
    def test_v1_models_lists_the_served_id(self):
        c, _ = client()
        body = c.get('/v1/models').json()
        assert body['object'] == 'list'
        assert [m['id'] for m in body['data']] == ['fake-vl-embedding']
        assert body['data'][0]['object'] == 'model'

    def test_healthz_reports_the_backend_and_model(self):
        c, _ = client()
        body = c.get('/healthz').json()
        assert body['status'] == 'ok'
        assert body['backend'] == 'fake'
        assert body['model'] == 'fake-vl-embedding'
        assert body['vision'] is True

    def test_healthz_is_503_when_the_backend_cannot_be_reached(self):
        c, _ = client(FakeBackend(healthy=False))
        res = c.get('/healthz')
        assert res.status_code == 503
        assert res.json()['status'] == 'degraded'
        assert '/props' in res.json()['reason']
