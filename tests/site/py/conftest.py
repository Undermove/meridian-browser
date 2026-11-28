import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]


def load(name, rel):
  # Loaded by path: the folder is named `site`, which would clash with the stdlib module.
  spec = importlib.util.spec_from_file_location(name, ROOT / rel)
  module = importlib.util.module_from_spec(spec)
  spec.loader.exec_module(module)
  return module


@pytest.fixture(scope='session')
def build():
  return load('site_build', 'site/build.py')


@pytest.fixture(scope='session')
def artifact():
  return load('site_build_artifact', 'site/lab/build_artifact.py')
