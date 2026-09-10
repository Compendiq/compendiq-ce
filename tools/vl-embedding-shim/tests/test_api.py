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
        self.refreshes = 0

    def info(self, *, refresh: bool = False) -> BackendInfo:
        if refresh:
            self.refreshes += 1
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


def client(backend=None, image_client=None, **settings_over):
    backend = backend or FakeBackend()
    settings = Settings(backend='llama', **settings_over)
    service = EmbeddingService(backend, settings, image_client=image_client)
    return TestClient(create_app(service)), backend


def chat(*entries, **over):
    """A `messages` body that satisfies the continuation contract.

    The trailing empty `assistant` turn plus `continue_final_message: true` is
    the shape vLLM's own example sends and the shim now requires — see
    `test_request.py::TestTheContinuationContract`.
    """
    body = {
        'model': 'm',
        'messages': [*entries, {'role': 'assistant', 'content': [{'type': 'text', 'text': ''}]}],
        'continue_final_message': True,
    }
    body.update(over)
    return body


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
        body = c.post('/v1/embeddings', json=chat(
            {'role': 'system', 'content': [{'type': 'text', 'text': 'Represent it.'}]},
            {'role': 'user', 'content': [{'type': 'text', 'text': 'hallo'}]},
            add_special_tokens=True,
        )).json()
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
        c.post('/v1/embeddings', json=chat(
            {'role': 'system', 'content': 'Retrieve images or text relevant to the user\'s query.'},
            {'role': 'user', 'content': 'hund am strand'},
        ))
        assert backend.seen[0][0].instruction == \
            "Retrieve images or text relevant to the user's query."


class TestImages:
    def test_a_data_uri_reaches_the_backend_as_bytes(self):
        c, backend = client()
        res = c.post('/v1/embeddings', json=chat(
            {'role': 'user', 'content': [
                {'type': 'image_url', 'image_url': {'url': png_data_uri()}},
                {'type': 'text', 'text': 'ein bild'},
            ]},
        ))
        assert res.status_code == 200
        item = backend.seen[0][0]
        assert len(item.images) == 1
        assert item.images[0].startswith(b'\x89PNG')

    def test_a_broken_data_uri_is_a_400(self):
        c, _ = client()
        res = c.post('/v1/embeddings', json=chat(
            {'role': 'user', 'content': [
                {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,####'}},
            ]},
        ))
        assert res.status_code == 400
        assert 'base64' in res.json()['error']['message']

    def test_remote_urls_are_refused_by_default(self):
        # The polarity is the point: a shim that fetches arbitrary URLs on
        # request is an SSRF proxy for anything that can reach it, and the
        # traffic this tool exists for (the app, the eval, the README's own
        # examples) sends `data:` URIs. Opening it is a deliberate flag.
        c, _ = client()
        res = c.post('/v1/embeddings', json=chat(
            {'role': 'user', 'content': [
                {'type': 'image_url', 'image_url': {'url': 'https://example.invalid/a.png'}},
            ]},
        ))
        assert res.status_code == 400
        assert 'remote' in res.json()['error']['message']
        assert '--allow-remote-images' in res.json()['error']['message']

    def test_the_flag_opens_remote_fetching(self):
        import httpx

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=b'\x89PNG-remote-bytes')

        fetcher = httpx.Client(transport=httpx.MockTransport(handler))
        c, backend = client(allow_remote_images=True, image_client=fetcher)
        res = c.post('/v1/embeddings', json=chat(
            {'role': 'user', 'content': [
                {'type': 'image_url', 'image_url': {'url': 'https://example.invalid/a.png'}},
            ]},
        ))
        assert res.status_code == 200
        assert backend.seen[0][0].images == (b'\x89PNG-remote-bytes',)

    def test_a_redirect_is_refused_rather_than_followed(self):
        # A permitted host that 302s is how a fetch reaches 169.254.169.254 or
        # a loopback service, so the fetcher does not follow one.
        import httpx

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                302, headers={'location': 'http://169.254.169.254/latest/meta-data/'},
            )

        fetcher = httpx.Client(transport=httpx.MockTransport(handler))
        c, _ = client(allow_remote_images=True, image_client=fetcher)
        res = c.post('/v1/embeddings', json=chat(
            {'role': 'user', 'content': [
                {'type': 'image_url', 'image_url': {'url': 'https://example.invalid/a.png'}},
            ]},
        ))
        assert res.status_code == 400
        assert 'redirect' in res.json()['error']['message']

    def test_the_client_the_process_builds_does_not_follow_redirects(self):
        # The test above injects its own client, which httpx constructs with
        # `follow_redirects=False` by DEFAULT — so it passed either way, and
        # flipping the real client to True left the whole suite green (review
        # r2). The `is_redirect` check is not a second line of defence: a
        # followed redirect answers 200 with the metadata body and no redirect
        # to see. So this asserts the client the shim itself builds.
        service = EmbeddingService(FakeBackend(), Settings(allow_remote_images=True))
        assert service._image_client is not None
        assert service._image_client.follow_redirects is False

    def test_a_remote_image_is_bounded_by_the_body_ceiling(self):
        # The inbound body is capped so one POST cannot decide how much of a
        # 24 GB machine it gets — and a POST naming a URL reaches the same
        # allocation through the fetch. Measured before this bound: a 2 KiB
        # body ceiling admitted a 200 MB image (review r2).
        import httpx

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=b'\x89PNG' + b'x' * 8192)

        fetcher = httpx.Client(transport=httpx.MockTransport(handler))
        c, backend = client(
            allow_remote_images=True, image_client=fetcher, max_body_bytes=2048,
        )
        res = c.post('/v1/embeddings', json=chat(
            {'role': 'user', 'content': [
                {'type': 'image_url', 'image_url': {'url': 'https://example.invalid/big.png'}},
            ]},
        ))
        assert res.status_code == 400
        assert '2048' in res.json()['error']['message']
        assert backend.seen == [], 'an over-size fetch reached the backend'

    def test_a_chunked_remote_image_is_counted_as_it_streams(self):
        # The sibling above declares a `content-length`, so it only exercises
        # the cheap pre-read check; a chunked response declares nothing, which
        # is why the fetcher counts the bytes as they arrive. Without this case
        # the streaming half was covered by nothing (review r3) and deleting it
        # would silently restore the unbounded fetch r2 measured at 200 MB. The
        # inbound body has exactly this pair of tests already.
        import httpx

        def handler(request: httpx.Request) -> httpx.Response:
            def chunks():
                for _ in range(4):
                    yield b'x' * 2048

            res = httpx.Response(200, content=chunks())
            assert 'content-length' not in res.headers, 'the response declared its size'
            return res

        fetcher = httpx.Client(transport=httpx.MockTransport(handler))
        c, backend = client(
            allow_remote_images=True, image_client=fetcher, max_body_bytes=2048,
        )
        res = c.post('/v1/embeddings', json=chat(
            {'role': 'user', 'content': [
                {'type': 'image_url', 'image_url': {'url': 'https://example.invalid/chunked.png'}},
            ]},
        ))
        assert res.status_code == 400
        assert '2048' in res.json()['error']['message']
        assert backend.seen == [], 'an over-size chunked fetch reached the backend'

    def test_the_ceiling_bounds_the_REQUEST_not_each_image_separately(self):
        # The two cases above bound ONE fetch, which is not what the README
        # promises ("a request that names a URL reaches the same allocation
        # through a second door"). Measured on the final r3 code: a 2048-byte
        # ceiling against a body naming 20 URLs each serving 2000 bytes
        # answered 200 with 40,000 bytes retained — 19.5x the ceiling, because
        # the limit was re-applied per image instead of spent from one budget.
        # Four 1000-byte images are enough to show it: the third exhausts a
        # 2048-byte request budget.
        import httpx

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=b'\x89PNG' + b'x' * 996)

        fetcher = httpx.Client(transport=httpx.MockTransport(handler))
        c, backend = client(
            allow_remote_images=True, image_client=fetcher, max_body_bytes=2048,
        )
        res = c.post('/v1/embeddings', json=chat(
            {'role': 'user', 'content': [
                {'type': 'image_url', 'image_url': {'url': f'https://example.invalid/{i}.png'}}
                for i in range(4)
            ]},
        ))
        assert res.status_code == 400
        # The ceiling is named even though the fetch that failed had less than
        # that left, so the message points at the flag the operator can move.
        assert '2048' in res.json()['error']['message']
        assert backend.seen == [], 'four 1000-byte images passed a 2048-byte ceiling'

    def test_several_small_remote_images_that_fit_the_budget_are_served(self):
        # The other half of the budget: it must not refuse a request whose
        # images genuinely sum under the ceiling, or the bound above would be
        # indistinguishable from "only one remote image per request".
        import httpx

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=b'\x89PNG' + b'x' * 96)

        fetcher = httpx.Client(transport=httpx.MockTransport(handler))
        c, backend = client(
            allow_remote_images=True, image_client=fetcher, max_body_bytes=2048,
        )
        res = c.post('/v1/embeddings', json=chat(
            {'role': 'user', 'content': [
                {'type': 'image_url', 'image_url': {'url': f'https://example.invalid/{i}.png'}}
                for i in range(4)
            ]},
        ))
        assert res.status_code == 200
        assert len(backend.seen[0][0].images) == 4

    def test_a_remote_image_under_the_ceiling_is_served(self):
        import httpx

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=b'\x89PNG-small')

        fetcher = httpx.Client(transport=httpx.MockTransport(handler))
        c, backend = client(
            allow_remote_images=True, image_client=fetcher, max_body_bytes=2048,
        )
        res = c.post('/v1/embeddings', json=chat(
            {'role': 'user', 'content': [
                {'type': 'image_url', 'image_url': {'url': 'https://example.invalid/a.png'}},
            ]},
        ))
        assert res.status_code == 200
        assert backend.seen[0][0].images == (b'\x89PNG-small',)

    def test_the_pixel_guard_refuses_an_oversized_image_when_a_ceiling_is_set(self):
        c, _ = client(max_pixels=64)
        res = c.post('/v1/embeddings', json=chat(
            {'role': 'user', 'content': [
                {'type': 'image_url', 'image_url': {'url': png_data_uri(100, 100)}},
            ]},
        ))
        assert res.status_code == 400
        assert 'max-pixels' in res.json()['error']['message']

    def test_no_ceiling_lets_a_large_image_through(self):
        c, _ = client()
        res = c.post('/v1/embeddings', json=chat(
            {'role': 'user', 'content': [
                {'type': 'image_url', 'image_url': {'url': png_data_uri(1200, 1200)}},
            ]},
        ))
        assert res.status_code == 200


class TestErrors:
    def test_a_malformed_body_is_a_400_in_the_openai_error_envelope(self):
        c, _ = client()
        res = c.post('/v1/embeddings', json={'model': 'm'})
        assert res.status_code == 400
        assert res.json()['error']['type'] == 'invalid_request_error'
        assert 'exactly one' in res.json()['error']['message']

    def test_a_short_answer_from_the_backend_is_a_502_naming_both_counts(self):
        # The service counts rows for EVERY backend — the mlx backend has its
        # own equivalent guard, the llama path had none, and this one was
        # unreachable by the suite (review r2). Without it a short answer is a
        # 200 with fewer `data` rows than inputs, and `generateEmbedding` reads
        # `data[i].embedding` positionally: vectors would land on the wrong
        # strings rather than the request failing.
        c, _ = client(FakeBackend(rows=[[1.0, 0.0]]))
        res = c.post('/v1/embeddings', json={'model': 'm', 'input': ['a', 'b']})
        assert res.status_code == 502
        message = res.json()['error']['message']
        assert '1 vectors' in message and '2 inputs' in message

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

    def test_both_diagnostics_read_the_backend_afresh(self):
        # These two are what an operator checks after restarting llama-server,
        # so serving them from a cache filled by the previous process reports a
        # dead media marker and the previous GGUF's name as current. The embed
        # path keeps the cache — it is per-request hot — and re-reads only when
        # a request actually fails (test_llama_backend.py).
        c, backend = client()
        c.get('/healthz')
        c.get('/v1/models')
        assert backend.refreshes == 2


class TestSafetyDefaults:
    """The two defaults that are security decisions rather than ergonomics.

    Both were mutated to the unsafe value against the rest of the suite and it
    stayed green, which is what these pin.
    """

    def test_the_shim_binds_loopback(self):
        assert Settings().host == '127.0.0.1'

    def test_remote_image_fetching_is_off(self):
        assert Settings().allow_remote_images is False

    def test_a_body_ceiling_exists_and_is_sane(self):
        assert 1 <= Settings().max_body_bytes <= 128 * 1024 * 1024


class TestBodyLimit:
    """`await request.json()` buffers whatever arrives; uvicorn caps nothing.

    A `data:` URI is base64, so a request is ~4/3 of the bytes it carries, and
    the app's own precedent is a ladder of explicit rungs (CLAUDE.md, #1178).
    413 rather than 400: the body was well-formed, it was too big.
    """

    def test_a_body_over_the_ceiling_is_413(self):
        c, backend = client(max_body_bytes=2048)
        res = c.post('/v1/embeddings', json={'model': 'm', 'input': 'x' * 8192})
        assert res.status_code == 413
        assert '2048' in res.json()['error']['message']
        assert backend.seen == [], 'an over-size body reached the backend'

    def test_a_body_under_the_ceiling_is_served(self):
        c, _ = client(max_body_bytes=8192)
        res = c.post('/v1/embeddings', json={'model': 'm', 'input': 'x' * 128})
        assert res.status_code == 200

    def test_a_chunked_body_is_counted_as_it_streams(self):
        # No `content-length` to check, so the header test alone would let this
        # through: the limit has to be enforced against the bytes themselves.
        import json as jsonlib

        payload = jsonlib.dumps({'model': 'm', 'input': 'x' * 8192}).encode()

        def chunks():
            for i in range(0, len(payload), 512):
                yield payload[i:i + 512]

        c, backend = client(max_body_bytes=2048)
        res = c.post(
            '/v1/embeddings', content=chunks(),
            headers={'content-type': 'application/json'},
        )
        assert res.status_code == 413
        assert backend.seen == []
