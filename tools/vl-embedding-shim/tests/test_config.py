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
