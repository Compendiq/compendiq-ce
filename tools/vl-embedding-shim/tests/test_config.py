"""The CLI, which is where the safety defaults are actually decided.

`Settings()` and `settings_from_args([])` are two independent copies of every
default — the dataclass field and the argparse `default=` — and the process
runs the second one. A test that pins only the dataclass would certify a value
the shim never uses, so both are asserted, and asserted to agree.
"""

import pytest

from vl_embedding_shim.config import DEFAULT_MAX_BODY_BYTES, Settings, settings_from_args


class TestTheDefaultsTheProcessActuallyRunsOn:
    def test_the_cli_agrees_with_the_dataclass(self):
        assert settings_from_args([]) == Settings()

    def test_it_binds_loopback(self):
        assert settings_from_args([]).host == '127.0.0.1'

    def test_remote_image_fetching_is_off(self):
        # Opt-out was the wrong polarity: any caller that can reach the shim
        # could make it GET an arbitrary URL and receive the effect.
        assert settings_from_args([]).allow_remote_images is False

    def test_the_body_ceiling_is_set(self):
        assert settings_from_args([]).max_body_bytes == DEFAULT_MAX_BODY_BYTES


class TestOpeningTheDoorTakesAFlag:
    def test_the_flag_enables_remote_images(self):
        assert settings_from_args(['--allow-remote-images']).allow_remote_images is True

    def test_the_env_var_enables_it_too(self, monkeypatch):
        monkeypatch.setenv('VL_SHIM_ALLOW_REMOTE_IMAGES', '1')
        assert settings_from_args([]).allow_remote_images is True

    @pytest.mark.parametrize('value', ['', '0', 'false', 'no'])
    def test_a_falsy_env_value_does_not(self, monkeypatch, value):
        monkeypatch.setenv('VL_SHIM_ALLOW_REMOTE_IMAGES', value)
        assert settings_from_args([]).allow_remote_images is False

    def test_the_body_ceiling_is_overridable(self):
        assert settings_from_args(['--max-body-bytes', '4096']).max_body_bytes == 4096


class TestAnUnusableCeilingIsRefusedRatherThanReinterpreted:
    """`0` used to mean two different things, and neither was what was asked.

    `_env_int` returns `0` for the string `'0'`, which then met
    `_env_int(...) or DEFAULT_MAX_BODY_BYTES` and silently became 32 MiB — the
    ceiling was not lowered, it was raised to the default. The same `0` on
    `--max-pixels` survived as a live ceiling of zero, and `guard_pixels` only
    short-circuits on `None`, so every image was refused for being "over the
    --max-pixels ceiling of 0". A mistyped knob must fail at startup instead
    (review r3).
    """

    @pytest.mark.parametrize('value', ['0', '-1'])
    def test_a_zero_or_negative_body_ceiling_is_a_cli_error(self, value, capsys):
        with pytest.raises(SystemExit):
            settings_from_args(['--max-body-bytes', value])
        assert '--max-body-bytes' in capsys.readouterr().err

    @pytest.mark.parametrize('value', ['0', '-1'])
    def test_the_env_var_is_validated_too(self, value, monkeypatch, capsys):
        # `'0'` reached the argparse default through `or DEFAULT`, so this is
        # the spelling that resolved to 32 MiB rather than failing.
        monkeypatch.setenv('VL_SHIM_MAX_BODY_BYTES', value)
        with pytest.raises(SystemExit):
            settings_from_args([])
        assert '--max-body-bytes' in capsys.readouterr().err

    @pytest.mark.parametrize('value', ['0', '-1'])
    def test_a_zero_or_negative_pixel_ceiling_is_a_cli_error(self, value, capsys):
        with pytest.raises(SystemExit):
            settings_from_args(['--max-pixels', value])
        assert '--max-pixels' in capsys.readouterr().err

    @pytest.mark.parametrize('value', ['0', '-1'])
    def test_the_pixel_env_var_is_validated_too(self, value, monkeypatch, capsys):
        monkeypatch.setenv('VL_SHIM_MAX_PIXELS', value)
        with pytest.raises(SystemExit):
            settings_from_args([])
        assert '--max-pixels' in capsys.readouterr().err

    def test_an_unset_pixel_ceiling_is_still_the_no_guard_default(self):
        # `None` is not "less than 1" — it is the documented off position, and
        # the validation must not turn the default into an error.
        assert settings_from_args([]).max_pixels is None

    def test_a_real_ceiling_still_passes(self):
        assert settings_from_args(['--max-pixels', '1']).max_pixels == 1
        assert settings_from_args(['--max-body-bytes', '1']).max_body_bytes == 1
