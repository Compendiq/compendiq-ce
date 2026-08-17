"""Image reference resolution: `data:` URIs, remote URLs, and the pixel guard."""

import base64
import io

import pytest

from vl_embedding_shim.images import (
    ImageError,
    guard_pixels,
    measure_pixels,
    resolve_image,
)
from vl_embedding_shim.request import ImageRef

PNG_1PX = base64.b64decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
)


def png_bytes(width: int, height: int) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new('RGB', (width, height), (10, 20, 30)).save(buf, format='PNG')
    return buf.getvalue()


class TestDataUri:
    def test_decodes_a_base64_data_uri(self):
        uri = 'data:image/png;base64,' + base64.b64encode(PNG_1PX).decode()
        assert resolve_image(ImageRef(uri)) == PNG_1PX

    def test_accepts_whitespace_inside_the_payload(self):
        # Some clients wrap long base64 at 76 columns.
        payload = base64.b64encode(PNG_1PX).decode()
        uri = 'data:image/png;base64,' + payload[:8] + '\n' + payload[8:]
        assert resolve_image(ImageRef(uri)) == PNG_1PX

    def test_refuses_a_data_uri_that_is_not_base64(self):
        with pytest.raises(ImageError, match='base64'):
            resolve_image(ImageRef('data:image/png,%89PNG'))

    def test_refuses_a_percent_encoded_payload_that_happens_to_decode_as_base64(self):
        # The case above is ALSO invalid base64, so deleting the `;base64`
        # header check left it green for the wrong reason (review r2). A
        # payload inside the base64 alphabet would then be decoded as base64
        # into garbage bytes and forwarded — measured live as a confusing 502
        # ("Failed to load image or audio file") from llama-server, rather than
        # the 400 this refusal exists to give.
        with pytest.raises(ImageError, match='percent-encoded'):
            resolve_image(ImageRef('data:image/png,aGVsbG8='))

    def test_refuses_undecodable_base64(self):
        with pytest.raises(ImageError, match='base64'):
            resolve_image(ImageRef('data:image/png;base64,!!!!not base64!!!!'))

    def test_refuses_an_empty_payload(self):
        with pytest.raises(ImageError):
            resolve_image(ImageRef('data:image/png;base64,'))


class TestRemoteUrl:
    def test_fetches_an_http_url_through_the_injected_fetcher(self):
        seen = []

        def fetcher(url: str) -> bytes:
            seen.append(url)
            return PNG_1PX

        assert resolve_image(ImageRef('https://example.invalid/a.png'), fetcher=fetcher) == PNG_1PX
        assert seen == ['https://example.invalid/a.png']

    def test_remote_fetching_can_be_refused(self):
        with pytest.raises(ImageError, match='remote'):
            resolve_image(ImageRef('https://example.invalid/a.png'), fetcher=None)

    def test_refuses_a_scheme_that_is_neither_data_nor_http(self):
        with pytest.raises(ImageError, match='file'):
            resolve_image(ImageRef('file:///etc/passwd'), fetcher=lambda url: b'')


class TestPixelGuard:
    def test_measures_the_dimensions(self):
        assert measure_pixels(png_bytes(40, 20)) == (40, 20)

    def test_no_ceiling_means_no_guard_and_no_decode(self):
        # v1 does not resize; the guard is opt-in (--max-pixels). Passing None
        # must not even open the image, so a format Pillow cannot read still
        # reaches the model server.
        guard_pixels(b'not an image at all', None)

    def test_admits_an_image_inside_the_budget(self):
        guard_pixels(png_bytes(100, 100), 1_310_720)

    def test_refuses_an_image_over_the_budget_naming_both_numbers(self):
        with pytest.raises(ImageError) as exc:
            guard_pixels(png_bytes(1200, 1200), 1_310_720)
        assert '1440000' in str(exc.value)
        assert '1310720' in str(exc.value)

    def test_an_undecodable_image_is_refused_when_a_ceiling_is_set(self):
        with pytest.raises(ImageError, match='decode'):
            guard_pixels(b'not an image at all', 1_310_720)
