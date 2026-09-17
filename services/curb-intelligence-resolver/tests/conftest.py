import logging

import pytest


@pytest.fixture(autouse=True)
def reset_resolver_logger():
    logger = logging.getLogger("curb_intelligence_resolver")
    previous_handlers = list(logger.handlers)
    previous_level = logger.level
    previous_propagate = logger.propagate
    logger.handlers.clear()
    logger.setLevel(logging.NOTSET)
    logger.propagate = True
    yield
    logger.handlers[:] = previous_handlers
    logger.setLevel(previous_level)
    logger.propagate = previous_propagate
