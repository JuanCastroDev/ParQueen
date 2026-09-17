import importlib.util
from pathlib import Path


def test_gunicorn_is_single_sync_worker_with_bounded_timeout():
    config_path = Path(__file__).parents[1] / "gunicorn.conf.py"
    spec = importlib.util.spec_from_file_location("resolver_gunicorn_config", config_path)
    config = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(config)

    assert config.workers == 1
    assert config.worker_class == "sync"
    assert config.threads == 1
    assert config.timeout == 10
    assert config.preload_app is False
    assert config.accesslog is None


def test_dockerfile_pins_approved_geosupport_digest_and_runs_nonroot():
    dockerfile = (Path(__file__).parents[1] / "Dockerfile").read_text(encoding="ascii")

    assert (
        "nycplanning/docker-geosupport:26.3.0@sha256:"
        "b549087cfe07910f8c71a561ead3a728160de0817914c495cc6b75e65815774b"
        in dockerfile
    )
    assert "USER resolver" in dockerfile
    assert "process pool" not in dockerfile.lower()
