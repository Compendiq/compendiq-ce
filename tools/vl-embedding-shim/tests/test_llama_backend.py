"""The llama-server backend, mocked at the HTTP boundary.

llama-server's OpenAI-compatible `/v1/embeddings` is text-only (llama.cpp PR
#18665, which would have added image+text input, is closed unmerged), so the
shim talks to the non-OpenAI `POST /embedding` with a JSON-object prompt. Two
things about that route decide most of this file:

* **The media marker is randomised per server process.** The literal
  `<__media__>` stopped working; `/props` reports the real one. Getting the
  count wrong is llama.cpp issues #26201 / #25088: "number of media markers in
  text (0) does not match number of bitmaps (1)".
* **The response is `[{"index": 0, "embedding": [[...]]}]`** — the vector is
  nested one level deeper than the OpenAI shape.
"""

import json

import httpx
import pytest

from vl_embedding_shim.backends.base import BackendError, ResolvedItem
from vl_embedding_shim.backends.llama import LlamaBackend

MARKER = '<__media_cZ1FlZADoIfxZ4e19r4w4oxIvgf5rVdH__>'

PROPS = {
    'model_path': '/models/Qwen3-VL-Embedding-8B-Q6_K.gguf',
    'modalities': {'vision': True, 'video': True, 'audio': False},
    'media_marker': MARKER,
}


class Recorder:
    def __init__(self, props=None, embedding=None, status=200, body=None):
        self.props = PROPS if props is None else props
        self.embedding = [0.6, 0.8] if embedding is None else embedding
        self.status = status
        self.body = body
        self.requests: list[httpx.Request] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.url.path == '/props':
            return httpx.Response(200, json=self.props)
        if request.url.path == '/embedding':
            if self.status != 200:
                return httpx.Response(self.status, text=self.body or 'boom')
            if self.body is not None:
                return httpx.Response(200, json=self.body)
            return httpx.Response(200, json=[{'index': 0, 'embedding': [self.embedding]}])
        return httpx.Response(404, text=f'unexpected path {request.url.path}')

    def client(self) -> httpx.Client:
        return httpx.Client(
            transport=httpx.MockTransport(self.handler),
            base_url='http://127.0.0.1:8090',
        )

    def embed_bodies(self):
        return [
            json.loads(r.content) for r in self.requests if r.url.path == '/embedding'
        ]


def backend(rec: Recorder, **kwargs) -> LlamaBackend:
    return LlamaBackend('http://127.0.0.1:8090', client=rec.client(), **kwargs)


class TestProps:
    def test_reads_the_media_marker_and_vision_flag(self):
        rec = Recorder()
        info = backend(rec).info()
        assert info.backend == 'llama'
        assert info.vision is True
        assert info.details['media_marker'] == MARKER

    def test_the_served_model_id_defaults_to_the_gguf_basename(self):
        assert backend(Recorder()).info().model_id == 'Qwen3-VL-Embedding-8B-Q6_K.gguf'

    def test_an_explicit_model_id_wins(self):
        assert backend(Recorder(), model_id='qwen3-vl-8b').info().model_id == 'qwen3-vl-8b'

    def test_props_is_cached_between_ordinary_reads(self):
        rec = Recorder()
        be = backend(rec)
        be.info()
        be.info()
        assert sum(1 for r in rec.requests if r.url.path == '/props') == 1

    def test_the_props_read_has_its_own_short_timeout(self):
        # `/healthz` now performs one on every call, and the embed timeout is
        # 300 s (an 8B forward pass). A hung llama-server must not hang the
        # diagnostic whose job is to report that.
        rec = Recorder()
        backend(rec, timeout=300.0).info()
        props = next(r for r in rec.requests if r.url.path == '/props')
        assert props.extensions['timeout']['read'] <= 10

    def test_refresh_re_reads_it(self):
        # `/healthz` and `/v1/models` pass `refresh=True`: they are the two
        # diagnostics an operator consults after restarting llama-server, and
        # a cached answer there reports the previous process's marker and the
        # previous GGUF's name as if they were live.
        rec = Recorder()
        be = backend(rec)
        be.info()
        be.info(refresh=True)
        assert sum(1 for r in rec.requests if r.url.path == '/props') == 2


class TestTextEmbedding:
    def test_posts_the_hand_built_chat_template_as_prompt_string(self):
        rec = Recorder()
        backend(rec).embed([ResolvedItem(text='hallo', instruction=None)])
        body = rec.embed_bodies()[0]
        assert body['content']['prompt_string'] == (
            "<|im_start|>system\nRepresent the user's input.<|im_end|>\n"
            '<|im_start|>user\nhallo<|im_end|>\n'
            '<|im_start|>assistant\n'
        )

    def test_a_text_only_request_carries_no_multimodal_data(self):
        rec = Recorder()
        backend(rec).embed([ResolvedItem(text='hallo', instruction=None)])
        assert 'multimodal_data' not in rec.embed_bodies()[0]['content']

    def test_the_system_message_is_the_instruction_with_its_period(self):
        rec = Recorder()
        backend(rec).embed([ResolvedItem(text='q', instruction='Find images matching this description')])
        assert 'Find images matching this description.<|im_end|>' \
            in rec.embed_bodies()[0]['content']['prompt_string']

    def test_unwraps_the_nested_embedding_row(self):
        rec = Recorder(embedding=[1.0, 2.0, 3.0])
        assert backend(rec).embed([ResolvedItem(text='x', instruction=None)]) == [[1.0, 2.0, 3.0]]

    def test_accepts_a_flat_embedding_row_too(self):
        # Older builds answered `embedding: [floats]`. Both are unwrapped to a
        # single vector rather than guessed at downstream.
        rec = Recorder(body=[{'index': 0, 'embedding': [1.0, 2.0]}])
        assert backend(rec).embed([ResolvedItem(text='x', instruction=None)]) == [[1.0, 2.0]]

    def test_one_request_per_item_in_order(self):
        rec = Recorder()
        backend(rec).embed([
            ResolvedItem(text='a', instruction=None),
            ResolvedItem(text='b', instruction=None),
        ])
        prompts = [b['content']['prompt_string'] for b in rec.embed_bodies()]
        assert len(prompts) == 2
        assert '\na<|im_end|>' in prompts[0]
        assert '\nb<|im_end|>' in prompts[1]


class TestImageEmbedding:
    def test_substitutes_the_servers_random_marker_once_per_image(self):
        rec = Recorder()
        backend(rec).embed([ResolvedItem(text='zwei', instruction=None, images=(b'\x01', b'\x02'))])
        body = rec.embed_bodies()[0]
        assert body['content']['prompt_string'].count(MARKER) == 2
        assert len(body['content']['multimodal_data']) == 2

    def test_never_emits_the_literal_vision_placeholder_to_llama_server(self):
        # `<|vision_start|><|image_pad|><|vision_end|>` is what the checkpoint's
        # jinja emits; llama-server wants ITS marker and matches on that.
        rec = Recorder()
        backend(rec).embed([ResolvedItem(text='', instruction=None, images=(b'\x01',))])
        assert '<|vision_start|>' not in rec.embed_bodies()[0]['content']['prompt_string']

    def test_sends_the_bytes_base64_encoded_without_a_data_uri_prefix(self):
        import base64

        rec = Recorder()
        backend(rec).embed([ResolvedItem(text='', instruction=None, images=(b'PNGBYTES',))])
        payload = rec.embed_bodies()[0]['content']['multimodal_data'][0]
        assert payload == base64.b64encode(b'PNGBYTES').decode()
        assert not payload.startswith('data:')

    def test_markers_precede_the_text(self):
        rec = Recorder()
        backend(rec).embed([ResolvedItem(text='caption', instruction=None, images=(b'\x01',))])
        prompt = rec.embed_bodies()[0]['content']['prompt_string']
        assert prompt.index(MARKER) < prompt.index('caption')

    def test_refuses_images_when_props_reports_no_vision(self):
        props = dict(PROPS, modalities={'vision': False})
        rec = Recorder(props=props)
        with pytest.raises(BackendError, match='vision'):
            backend(rec).embed([ResolvedItem(text='', instruction=None, images=(b'\x01',))])

    def test_refuses_images_when_props_reports_no_media_marker(self):
        props = {k: v for k, v in PROPS.items() if k != 'media_marker'}
        rec = Recorder(props=props)
        with pytest.raises(BackendError, match='media_marker'):
            backend(rec).embed([ResolvedItem(text='', instruction=None, images=(b'\x01',))])

    def test_a_text_only_request_still_works_without_vision(self):
        rec = Recorder(props=dict(PROPS, modalities={'vision': False}))
        assert backend(rec).embed([ResolvedItem(text='x', instruction=None)]) == [[0.6, 0.8]]


class TestARestartedLlamaServer:
    """The marker is randomised per server PROCESS, so a restart invalidates it.

    Restarting llama-server — onto a different GGUF, a bigger batch, an added
    `--mmproj` — is the tool's main dev loop. A marker cached for the life of
    the shim process turns every subsequent image request into llama.cpp's
    `number of media markers in text (0) does not match number of bitmaps (1)`,
    which the runbook's troubleshooting table would then misdiagnose as an old
    build. One re-read and one retry is the whole fix: the marker is the only
    thing that can have changed under an unchanged base URL.
    """

    class RestartingRecorder(Recorder):
        """`/props` answers a new marker after the first `/embedding` failure."""

        def __init__(self):
            super().__init__()
            self.marker = MARKER

        def handler(self, request: httpx.Request) -> httpx.Response:
            self.requests.append(request)
            if request.url.path == '/props':
                return httpx.Response(200, json=dict(PROPS, media_marker=self.marker))
            body = json.loads(request.content)
            prompt = body['content']['prompt_string']
            if self.marker not in prompt:
                return httpx.Response(500, text=(
                    'mtmd_tokenize: error: number of media markers in text (0) '
                    'does not match number of bitmaps (1)'
                ))
            return httpx.Response(200, json=[{'index': 0, 'embedding': [[0.6, 0.8]]}])

    def test_a_stale_marker_is_re_read_and_the_request_retried(self):
        rec = self.RestartingRecorder()
        be = backend(rec)
        be.embed([ResolvedItem(text='vorher', instruction=None, images=(b'\x01',))])
        rec.marker = '<__media_SECONDSERVER__>'  # the restart happens here
        rec.requests.clear()

        assert be.embed([ResolvedItem(text='nachher', instruction=None, images=(b'\x01',))]) \
            == [[0.6, 0.8]]
        prompts = [b['content']['prompt_string'] for b in rec.embed_bodies()]
        assert len(prompts) == 2, 'the failed call was not retried'
        assert MARKER in prompts[0]
        assert '<__media_SECONDSERVER__>' in prompts[1]

    def test_a_failure_that_is_not_the_marker_is_not_retried(self):
        # The marker came back unchanged, so nothing was learned and a second
        # identical request would only double a real error (a batch too small
        # for one image's ~1280 visual tokens, say).
        rec = Recorder(status=500, body='batch size exceeded')
        be = backend(rec)
        with pytest.raises(BackendError, match='500'):
            be.embed([ResolvedItem(text='x', instruction=None, images=(b'\x01',))])
        assert len(rec.embed_bodies()) == 1

    def test_the_embed_error_survives_a_props_read_that_also_fails(self):
        # A server that died between the two calls must be reported by what the
        # embed said, not by the diagnostic re-read that came after it.
        class DyingRecorder(Recorder):
            def handler(self, request: httpx.Request) -> httpx.Response:
                self.requests.append(request)
                if request.url.path == '/props':
                    if any(r.url.path == '/embedding' for r in self.requests):
                        return httpx.Response(503, text='service unavailable')
                    return httpx.Response(200, json=PROPS)
                return httpx.Response(500, text='mtmd_tokenize: error: number of media markers')

        rec = DyingRecorder()
        with pytest.raises(BackendError, match='mtmd_tokenize'):
            backend(rec).embed([ResolvedItem(text='x', instruction=None, images=(b'\x01',))])

    def test_a_text_only_request_is_never_retried(self):
        # It carries no marker, so a re-read cannot change anything about it.
        rec = Recorder(status=500, body='boom')
        be = backend(rec)
        with pytest.raises(BackendError, match='500'):
            be.embed([ResolvedItem(text='x', instruction=None)])
        assert len(rec.embed_bodies()) == 1


class TestFailures:
    def test_a_non_2xx_becomes_a_backend_error_naming_the_status(self):
        rec = Recorder(status=500, body='mtmd_tokenize: error')
        with pytest.raises(BackendError, match='500'):
            backend(rec).embed([ResolvedItem(text='x', instruction=None)])

    def test_an_unparseable_response_becomes_a_backend_error(self):
        rec = Recorder(body=[{'index': 0}])
        with pytest.raises(BackendError, match='embedding'):
            backend(rec).embed([ResolvedItem(text='x', instruction=None)])

    def test_an_empty_response_list_becomes_a_backend_error(self):
        rec = Recorder(body=[])
        with pytest.raises(BackendError):
            backend(rec).embed([ResolvedItem(text='x', instruction=None)])

    def test_a_transport_failure_becomes_a_backend_error(self):
        def boom(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError('connection refused', request=request)

        client = httpx.Client(transport=httpx.MockTransport(boom), base_url='http://127.0.0.1:8090')
        be = LlamaBackend('http://127.0.0.1:8090', client=client)
        with pytest.raises(BackendError, match='refused|connect'):
            be.embed([ResolvedItem(text='x', instruction=None)])


class TestANonJsonBody:
    """A 200 that is not JSON is a backend failure, not a crash (review r3).

    `res.json()` raises `json.JSONDecodeError`, which is a **ValueError** and
    not an `httpx.HTTPError`, so it used to escape both handlers in this module
    and surface as an unhandled exception: `/healthz` answered 500 instead of
    the documented 503 `{status: degraded, reason: …}` and `/v1/embeddings`
    answered 500 instead of 502. Pointing `--llama-base-url` at something that
    serves HTML with a 200 — an nginx/SPA, a proxy error page — is the single
    most likely spelling of the operator error the runbook has a troubleshooting
    row for, and the row promised a reason the shim could not produce.

    LM Studio on :1234 answers 404 to `/props`, which `raise_for_status`
    already caught, which is why this went unnoticed.
    """

    HTML = '<html><body><h1>404 Not Found</h1></body></html>'

    def _client(self, *, bad_path: str) -> httpx.Client:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == bad_path:
                return httpx.Response(
                    200, text=self.HTML, headers={'content-type': 'text/html'},
                )
            if request.url.path == '/props':
                return httpx.Response(200, json=PROPS)
            return httpx.Response(200, json=[{'index': 0, 'embedding': [[0.6, 0.8]]}])

        return httpx.Client(
            transport=httpx.MockTransport(handler), base_url='http://127.0.0.1:8090',
        )

    def _service(self, *, bad_path: str):
        from vl_embedding_shim.config import Settings
        from vl_embedding_shim.service import EmbeddingService

        be = LlamaBackend('http://127.0.0.1:8090', client=self._client(bad_path=bad_path))
        return EmbeddingService(be, Settings(backend='llama'))

    def test_props_answering_html_is_a_backend_error(self):
        be = LlamaBackend('http://127.0.0.1:8090', client=self._client(bad_path='/props'))
        with pytest.raises(BackendError, match='/props') as exc:
            be.info()
        # The body, not just the parser's `Expecting value: line 1 column 1`,
        # which on its own tells an operator nothing about what answered.
        assert '404 Not Found' in str(exc.value)

    def test_embedding_answering_html_is_a_backend_error(self):
        be = LlamaBackend('http://127.0.0.1:8090', client=self._client(bad_path='/embedding'))
        with pytest.raises(BackendError, match='JSON|json'):
            be.embed([ResolvedItem(text='x', instruction=None)])

    def test_healthz_reports_degraded_rather_than_crashing(self):
        from fastapi.testclient import TestClient

        from vl_embedding_shim.app import create_app

        client = TestClient(
            create_app(self._service(bad_path='/props')), raise_server_exceptions=False,
        )
        res = client.get('/healthz')
        assert res.status_code == 503
        assert res.json()['status'] == 'degraded'
        assert '/props' in res.json()['reason']

    def test_embeddings_reports_502_rather_than_crashing(self):
        from fastapi.testclient import TestClient

        from vl_embedding_shim.app import create_app

        client = TestClient(
            create_app(self._service(bad_path='/embedding')), raise_server_exceptions=False,
        )
        res = client.post('/v1/embeddings', json={'model': 'm', 'input': 'hallo'})
        assert res.status_code == 502
        assert res.json()['error']['type'] == 'backend_error'
