"""Env-gated smoke test against a RUNNING shim.

    VL_SHIM_INTEGRATION=1 pytest tests/test_integration.py
    VL_SHIM_INTEGRATION=1 VL_SHIM_URL=http://127.0.0.1:8011 pytest tests/test_integration.py

Skipped by default: it needs a real model behind a real server, which no CI in
this repository has (the retrieval-eval job's Ollama service container serves
`nomic-embed-text`, which is text-only).

**What it does not do.** The model card's worked example scores a text query
against a photo of a woman and a golden retriever on a beach — that image is a
remote asset, and an offline machine cannot reproduce the number. Asserting a
cosine against a *generated* placeholder image would be asserting a number
nobody derived. So this file checks STRUCTURAL properties only:

* every vector is unit-norm and the width is stable across calls;
* `dimensions` shortens it and it is still unit-norm;
* an image embeds at all, through the same endpoint;
* and the one ordering property that holds for any working embedder — a pair of
  near-paraphrases scores above an unrelated pair.

That last one is a plumbing check, not a quality metric. Retrieval numbers are
measured on the production stack (design D11): quantisation, MLX-vs-CUDA
numerics and vLLM's own ~0.92-cosine preprocessing divergence all shift the
space, so a local cosine is comparable to nothing but itself.
"""

from __future__ import annotations

import base64
import io
import math
import os

import httpx
import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get('VL_SHIM_INTEGRATION') != '1',
    reason='set VL_SHIM_INTEGRATION=1 and run a shim to enable',
)

BASE_URL = os.environ.get('VL_SHIM_URL', 'http://127.0.0.1:8011')
TIMEOUT = float(os.environ.get('VL_SHIM_TIMEOUT', '600'))

QUERY_INSTRUCTION = "Retrieve images or text relevant to the user's query."


@pytest.fixture(scope='module')
def client():
    with httpx.Client(base_url=BASE_URL, timeout=TIMEOUT) as c:
        yield c


def embed(client, body) -> list[list[float]]:
    res = client.post('/v1/embeddings', json=body)
    assert res.status_code == 200, res.text
    payload = res.json()
    assert payload['object'] == 'list'
    return [d['embedding'] for d in payload['data']]


def messages_body(text=None, image_data_uri=None, instruction=None, **over):
    content = []
    if image_data_uri:
        content.append({'type': 'image_url', 'image_url': {'url': image_data_uri}})
    content.append({'type': 'text', 'text': text or ''})
    messages = []
    if instruction:
        messages.append(
            {'role': 'system', 'content': [{'type': 'text', 'text': instruction}]},
        )
    messages.append({'role': 'user', 'content': content})
    messages.append({'role': 'assistant', 'content': [{'type': 'text', 'text': ''}]})
    body = {
        'model': 'qwen3-vl-embedding',
        'messages': messages,
        'encoding_format': 'float',
        'continue_final_message': True,
        'add_special_tokens': True,
    }
    body.update(over)
    return body


def norm(vec) -> float:
    return math.sqrt(sum(x * x for x in vec))


def cosine(a, b) -> float:
    return sum(x * y for x, y in zip(a, b))


def stripes_png(width=192, height=128) -> str:
    """A deterministic, offline image. Content is irrelevant — that it embeds is not."""
    from PIL import Image, ImageDraw

    img = Image.new('RGB', (width, height), (240, 240, 235))
    draw = ImageDraw.Draw(img)
    for i in range(0, width, 24):
        draw.rectangle([i, 0, i + 11, height], fill=(30, 90, 140))
    draw.ellipse([width // 3, height // 4, 2 * width // 3, 3 * height // 4], fill=(220, 160, 40))
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode()


class TestHealth:
    def test_healthz_answers(self, client):
        res = client.get('/healthz')
        assert res.status_code == 200, res.text
        assert res.json()['status'] == 'ok'

    def test_models_lists_one_served_id(self, client):
        data = client.get('/v1/models').json()['data']
        assert len(data) == 1 and data[0]['id']


class TestStructure:
    def test_a_text_embeds_to_a_unit_vector(self, client):
        [vec] = embed(client, messages_body(text='Ein Turm aus Stahlbeton.'))
        assert len(vec) > 0
        assert norm(vec) == pytest.approx(1.0, abs=1e-3)

    def test_the_width_is_stable(self, client):
        [a] = embed(client, messages_body(text='erste Eingabe'))
        [b] = embed(client, messages_body(text='zweite Eingabe'))
        assert len(a) == len(b)

    def test_the_plain_input_shape_matches_the_messages_shape_width(self, client):
        [via_messages] = embed(client, messages_body(text='dieselbe Eingabe'))
        [via_input] = embed(client, {'model': 'm', 'input': 'dieselbe Eingabe'})
        assert len(via_messages) == len(via_input)
        assert norm(via_input) == pytest.approx(1.0, abs=1e-3)

    def test_dimensions_truncates_and_stays_unit_norm(self, client):
        [full] = embed(client, messages_body(text='eine Eingabe'))
        target = min(512, len(full))
        [short] = embed(client, messages_body(text='eine Eingabe', dimensions=target))
        assert len(short) == target
        assert norm(short) == pytest.approx(1.0, abs=1e-3)

    def test_dimensions_above_native_is_refused(self, client):
        [full] = embed(client, messages_body(text='x'))
        res = client.post('/v1/embeddings', json=messages_body(text='x', dimensions=len(full) + 1))
        assert res.status_code == 400
        assert 'native' in res.json()['error']['message']

    def test_a_body_without_the_continuation_flag_is_refused(self, client):
        # The whole point of the tool: the request that would silently pool a
        # different position on vLLM does not quietly succeed here either.
        body = messages_body(text='x')
        del body['continue_final_message']
        res = client.post('/v1/embeddings', json=body)
        assert res.status_code == 400
        assert 'continue_final_message' in res.json()['error']['message']

    def test_a_remote_image_url_is_refused_unless_the_flag_is_set(self, client):
        # Skipped rather than failed when the operator started the shim with
        # --allow-remote-images: that is a real configuration, just not the
        # default this asserts.
        res = client.post('/v1/embeddings', json=messages_body(
            image_data_uri='https://example.invalid/a.png',
        ))
        if res.status_code == 200:
            pytest.skip('this shim was started with --allow-remote-images')
        assert res.status_code == 400
        assert 'remote' in res.json()['error']['message']


class TestOrdering:
    def test_near_paraphrases_beat_an_unrelated_pair(self, client):
        # A plumbing check, not a quality metric — see the module docstring.
        vectors = embed(client, {'model': 'm', 'input': [
            'Der Turm ist 120 Meter hoch.',
            'Die Höhe des Turms beträgt 120 Meter.',
            'Das Rezept verlangt drei Eier und etwas Zucker.',
        ]})
        near, far = cosine(vectors[0], vectors[1]), cosine(vectors[0], vectors[2])
        assert near > far, f'paraphrase {near:.4f} did not beat unrelated {far:.4f}'

    def test_a_query_instruction_does_not_break_the_ordering(self, client):
        [query] = embed(client, messages_body(
            text='Wie hoch ist der Turm?', instruction=QUERY_INSTRUCTION,
        ))
        docs = embed(client, {'model': 'm', 'input': [
            'Der Turm ist 120 Meter hoch.',
            'Das Rezept verlangt drei Eier und etwas Zucker.',
        ]})
        assert cosine(query, docs[0]) > cosine(query, docs[1])


class TestImages:
    def test_an_image_embeds_at_all(self, client):
        [vec] = embed(client, messages_body(image_data_uri=stripes_png()))
        assert norm(vec) == pytest.approx(1.0, abs=1e-3)

    def test_an_image_lands_in_the_same_space_width(self, client):
        [text_vec] = embed(client, messages_body(text='blaue Streifen'))
        [image_vec] = embed(client, messages_body(image_data_uri=stripes_png()))
        assert len(text_vec) == len(image_vec)

    def test_image_plus_text_embeds(self, client):
        [vec] = embed(client, messages_body(
            text='blaue Streifen mit einem gelben Kreis', image_data_uri=stripes_png(),
        ))
        assert norm(vec) == pytest.approx(1.0, abs=1e-3)

    def test_the_type_less_image_part_reaches_the_model(self, client):
        # vLLM's simple image form — `{"image_url": …}` with no `type` — used to
        # be read as an empty TEXT part here, so an image-only body embedded the
        # literal string `NULL` and answered 200 with the image never sent
        # (review r2). The unit tests pin the parse; this pins the end of the
        # wire, because "the image reached the model" is not visible in a 200.
        image = stripes_png()
        [typed] = embed(client, messages_body(image_data_uri=image))
        body = messages_body(image_data_uri=image)
        body['messages'][-2]['content'][0] = {'image_url': {'url': image}}
        [type_less] = embed(client, body)
        [null_vector] = embed(client, {'model': 'qwen3-vl-embedding', 'input': ['']})
        assert cosine(typed, type_less) > 0.999
        assert cosine(type_less, null_vector) < 0.9

    def test_an_interleaved_content_array_is_refused(self, client):
        # Text before an image renders `a<image>b` on vLLM and `<image>ab` here
        # — cos 0.59-0.66 apart on the 8B — so it is a 400 rather than a
        # silently different vector.
        body = messages_body(image_data_uri=stripes_png())
        body['messages'][-2]['content'].insert(0, {'type': 'text', 'text': 'davor'})
        res = client.post('/v1/embeddings', json=body)
        assert res.status_code == 400
        assert 'precede an image part' in res.json()['error']['message']

    def test_an_image_is_not_identical_to_its_caption(self, client):
        # Cheap guard against a backend that silently drops the image and
        # embeds the text alone — which is exactly what a missing media marker
        # or a text-only /v1/embeddings route would do.
        caption = 'blaue Streifen mit einem gelben Kreis'
        [text_only] = embed(client, messages_body(text=caption))
        [with_image] = embed(client, messages_body(text=caption, image_data_uri=stripes_png()))
        assert cosine(text_only, with_image) < 0.999
