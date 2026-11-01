import sys
import tomllib
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parents[1]))


@pytest.fixture(scope="session")
def th() -> dict:
    """The shipped thresholds, so the tests pin the boundaries config.toml actually uses."""
    return tomllib.loads((Path(__file__).parents[1] / "config.toml").read_text())["thresholds"]
