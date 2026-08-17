"""MRL truncation, and the re-normalisation the research pack flags as unverified
upstream (§2.5): "vLLM truncates but does not necessarily re-normalize to unit
length in every path — UNVERIFIED. MRL truncation mathematically requires
re-normalizing before cosine comparison."

So the shim does it, always, and refuses a width it cannot produce.
"""

import math

import pytest

from vl_embedding_shim.mrl import DimensionsError, apply_mrl, l2_norm, l2_normalize


def _norm(vec):
    return math.sqrt(sum(x * x for x in vec))


class TestL2Normalize:
    def test_makes_a_unit_vector(self):
        assert _norm(l2_normalize([3.0, 4.0])) == pytest.approx(1.0)

    def test_is_idempotent_on_an_already_unit_vector(self):
        once = l2_normalize([1.0, 2.0, 3.0])
        assert l2_normalize(once) == pytest.approx(once)

    def test_preserves_direction(self):
        assert l2_normalize([3.0, 4.0]) == pytest.approx([0.6, 0.8])

    def test_a_zero_vector_is_returned_unchanged_rather_than_dividing_by_zero(self):
        assert l2_normalize([0.0, 0.0, 0.0]) == [0.0, 0.0, 0.0]

    def test_l2_norm_reports_the_length(self):
        assert l2_norm([3.0, 4.0]) == pytest.approx(5.0)


class TestApplyMrl:
    def test_no_dimensions_returns_a_renormalised_full_width_vector(self):
        out = apply_mrl([3.0, 4.0], None)
        assert len(out) == 2
        assert _norm(out) == pytest.approx(1.0)

    def test_truncates_to_the_first_n_components(self):
        out = apply_mrl([0.6, 0.8, 0.0, 0.0], 2)
        assert len(out) == 2
        assert out == pytest.approx([0.6, 0.8])

    def test_renormalises_after_truncation(self):
        # [0.6, 0.8, 0.0] is unit; dropping the last component leaves it unit.
        # [1, 1, 1]/sqrt(3) truncated to 2 is NOT unit until renormalised.
        source = l2_normalize([1.0, 1.0, 1.0])
        out = apply_mrl(source, 2)
        assert _norm(out) == pytest.approx(1.0)
        assert out == pytest.approx([1 / math.sqrt(2), 1 / math.sqrt(2)])

    def test_n_equal_to_native_is_allowed(self):
        assert len(apply_mrl([1.0, 2.0, 3.0], 3)) == 3

    def test_refuses_more_than_native(self):
        with pytest.raises(DimensionsError) as exc:
            apply_mrl([1.0, 2.0, 3.0], 4)
        assert '3' in str(exc.value) and '4' in str(exc.value)

    def test_refuses_zero_and_negative(self):
        with pytest.raises(DimensionsError):
            apply_mrl([1.0, 2.0, 3.0], 0)
        with pytest.raises(DimensionsError):
            apply_mrl([1.0, 2.0, 3.0], -1)
